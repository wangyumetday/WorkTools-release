// ============================================================
// PCP PlatformRunner - 平台运行器（阶段2 拆分自 taskManager.js）
// 职责：执行单个平台任务的"账密读取 → 登录 → 前置 → 请求 → 交叉"五步流程
//   每步上报真实业务进度（替代老版 setInterval 模拟进度）
//   支持 o_combo（TRIP+O2+O3 并行请求，按"完成平台数"上报整体进度）
//
// 不维护队列/并发：队列与并发由 taskScheduler.js 负责
// 不维护配置：compiledConfigs 由 taskManager facade 在 start 时预编译后注入
// ============================================================

import * as registry from './platforms/registry.js'

// 单平台执行的真实进度档位
//   credential=5   取账密完成
//   login=15       登录完成
//   prepare=30     prepareRequest 完成
//   request=60     request 完成
//   merge=90       mergeResult 完成
//   100            全部完成（由 scheduler 在 task.status='completed' 时设）
const STEP_PROGRESS = {
  credential: 5,
  login: 15,
  prepare: 30,
  request: 60,
  merge: 90
}

/**
 * 在一个长 await（如 HTTP 请求）期间做 indeterminate creep（不确定渐近）：
 *   从 floor 指数渐近到 cap（不含），每 intervalMs 一 tick
 *   越接近 cap 越慢（指数衰减，halflifeMs 控制速度），体感"在跑但越跑越慢"
 *   请求真正完成时外部 report(>=cap)，progress 向前跳，不回退
 *   reportTaskProgress 内部 `if (next <= task.progress) return` 会自动吞掉 plateau 重复值（不刷 IPC）
 *   16ms 合批器对 200ms 间隔的 tick 无影响（每个 tick 独立成帧，不会被同任务合并丢弃）
 * @returns {function} stop()  清除定时器（请求结束/出错时调用）
 */
function creepProgress(report, floor, cap, intervalMs = 200, halflifeMs = 2500) {
  const start = Date.now()
  let timer = null
  const tick = () => {
    const elapsed = Date.now() - start
    // 1 - e^(-elapsed/halflife)：2.5s 到 63%，5s 到 86%，10s 到 98%
    const p = Math.min(cap - 0.5, floor + (cap - floor) * (1 - Math.exp(-elapsed / halflifeMs)))
    report(p)
    timer = setTimeout(tick, intervalMs)
  }
  timer = setTimeout(tick, intervalMs)
  return () => { if (timer) clearTimeout(timer) }
}

export class PlatformRunner {
  /**
   * @param {object} deps
   *   - credentialManager:    CredentialManager 实例（按平台取选中账密）
   *   - getCompiledConfigs:   () => object（facade 注入，运行时拿到最新预编译配置）
   */
  constructor({ credentialManager, getCompiledConfigs }) {
    this.credentialManager = credentialManager || null
    this.getCompiledConfigs = getCompiledConfigs || (() => ({}))
  }

  /**
   * 按 task.type 分发
   * @param {string} taskType  'jxgj' | 'trip' | 'o2' | 'o3' | 'o_combo'
   * @param {object} data       任务数据
   * @param {function} onStep  (progress:number) => void  真实进度回调
   */
  async runByType(taskType, data, { onStep } = {}) {
    switch (taskType) {
      case 'jxgj':
      case 'trip':
      case 'o2':
      case 'o3':
        return this.run(taskType, data, { onStep })
      case 'o_combo':
        return this.runCombo(data, { onStep })
      default:
        throw new Error(`未知的任务类型: ${taskType}`)
    }
  }

  /**
   * 单平台执行：账密 → 登录 → 前置 → 请求 → 交叉
   * @param {string} platform  'jxgj' | 'trip' | 'o2' | 'o3'
   * @param {object} data      业务数据
   * @param {function} onStep  (progress) => void
   */
  async run(platform, data, { onStep } = {}) {
    if (!this.credentialManager) {
      throw new Error(`[${platform}] 任务执行失败：未注入 CredentialManager，无法读取平台账密`)
    }

    const adapter = registry.get(platform)
    const report = (p) => onStep?.(p)

    // 步骤 1：取该平台当前选中账密
    const credential = this.credentialManager.getSelected(platform)
    if (!credential) {
      throw new Error(`[${platform}] 未配置账号，请先在"账密管理"里为该平台选择一个账号`)
    }
    report(STEP_PROGRESS.credential)

    // 步骤 2：使用该平台账密登录
    const loginResult = await adapter.login(credential)
    report(STEP_PROGRESS.login)

    // 步骤 3：取该平台预编译配置 + 注入 ctx
    const compiledConfigs = this.getCompiledConfigs() || {}
    const platformConfig = compiledConfigs[platform] || {}
    const ctx = { credential, loginResult, platformConfig }

    // 步骤 4：三步走（前置 → 请求 → 交叉），每步上报
    const prepared = adapter.prepareRequest(data, data?.dateKey, platformConfig)
    report(STEP_PROGRESS.prepare)

    // ★ 请求阶段是单次 await、无真实中间进度 → 加 indeterminate creep
    //   从 prepare(30) 渐近到 merge-2(88)，让进度条在 HTTP 等待期间可见地推进
    //   请求完成时 report(60) 被 reportTaskProgress 吞掉（creep 已超 60），自然衔接到 merge(90)/100
    //   快请求：creep 几乎没动（30→31）→ 60/90/100 正常报；慢请求：creep 推到 ~88 → 平滑收尾
    const stopCreep = creepProgress(report, STEP_PROGRESS.prepare, STEP_PROGRESS.merge - 2)
    let rawResponse
    try {
      rawResponse = await adapter.request(prepared, ctx)
    } finally {
      stopCreep()
    }
    report(STEP_PROGRESS.request)

    const result = adapter.mergeResult(rawResponse, data, platformConfig)
    report(STEP_PROGRESS.merge)

    // 附加"本次使用的账号"信息，方便前端日志/调试
    const usedCredentialInfo = {
      id: credential.id,
      name: credential.name,
      username: credential.username,
      platform: credential.platform
    }

    if (result && typeof result === 'object') {
      return { ...result, _usedCredential: usedCredentialInfo }
    }
    return { payload: result, _usedCredential: usedCredentialInfo }
  }

  /**
   * O 平台组合请求：并行执行所有"已选中账密"的 O 平台
   *   进度按"已完成平台数"线性映射到 [STEP_PROGRESS.credential, STEP_PROGRESS.merge]
   *   单平台失败不影响其他平台（Promise.allSettled）
   *
   * @deprecated O 平台组合请求已拆分为独立单平台任务（pipeline._invokeAddBatchByStage
   *   现按 task.type=trip/o2/o3 直接走 run()，各平台独立入队、独立进度、独立结果）
   *   此方法仅保留向后兼容，当前 pipeline 不再生成 type='o_combo' 任务，不会走到这里。
   * @param {object} data  业务数据
   * @param {function} onStep
   */
  async runCombo(data, { onStep } = {}) {
    const platforms = ['trip', 'o2', 'o3'].filter(p => this.credentialManager?.getSelected(p))
    const total = platforms.length || 1
    const report = (p) => onStep?.(p)

    report(STEP_PROGRESS.credential)

    let done = 0
    const settled = await Promise.allSettled(
      platforms.map(async (p) => {
        const r = await this.run(p, data, { onStep: () => {} })
        done++
        // 已完成平台数线性映射到 [5, 90]
        const progress = STEP_PROGRESS.credential
          + Math.floor((done / total) * (STEP_PROGRESS.merge - STEP_PROGRESS.credential))
        report(Math.min(progress, STEP_PROGRESS.merge))
        return r
      })
    )

    const result = {}
    platforms.forEach((p, i) => {
      const r = settled[i]
      result[p] = r.status === 'fulfilled'
        ? r.value
        : { error: r.reason?.message || String(r.reason) }
    })
    return result
  }
}
