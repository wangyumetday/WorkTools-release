// ============================================================
// PCP Pipeline - 步骤流编排器（阶段3 + 细粒度阶段状态增强）
// 职责：步骤流的"单一权威"编排器
//
// ===== 状态模型（细粒度 stages）=====
//  stages: Map<stageKey, StageState> — 单一事实来源
//    StageState.shape:
//      {
//        key, title,
//        status: 'idle'|'pending'|'running'|'completed'|'failed'|'skipped',
//        skipReason?, error?,                   // skipped/failed 时的说明文字
//        totalTasks?, completedTasks?, failedTasks?,  // 任务执行统计
//        outputCount?,                          // 本阶段数据产出条数
//        startedAt?, finishedAt?                // 时间戳
//      }
//    stageKey 顺序（也是依赖顺序）：
//      upload → jxgj → trip → o2 → o3 → a3_merge → export
//
// ===== 向后兼容（老字段保留，从 stages 派生）=====
//  status: 'idle'|'running'|'paused'|'waiting_next'|'done'   （全局粗状态）
//  step:   'upload'|'jxgj'|'o_combo'|'export'                 （老 StepFlow 用）
//  这两个字段仍然填充在 getState() 中，老调用方零改动。
//
// mode: 'auto' | 'dev'
//   auto  门禁通过后跑到底（jxgj → O 平台 → a3_merge → 等待手动 export）
//   dev   每个粗阶段完成后停在 waiting_next，等用户点 StepFlow 触发下一步
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import registry, { O_PLATFORM_KEYS } from './platforms/registry.js'
import { DEFAULT_BUSINESS_MODE, isValidBusinessMode } from './businessModes.js'

const PIPELINE_STATE_FILE = 'pipelineState.json'

// ===== 细粒度阶段定义（单一权威：顺序 = 依赖顺序）=====
// 任何地方要列阶段，都应该遍历这个数组而不是自己硬编码顺序
const STAGE_DEFS = [
  { key: 'upload',   title: '导入 Excel 原始数据' },
  { key: 'jxgj',     title: '锦绣国际获取官网票价' },
  { key: 'trip',     title: '携程获取底价' },
  { key: 'o2',       title: 'O2 平台比价' },
  { key: 'o3',       title: 'O3 平台比价' },
  { key: 'a3_merge', title: '交叉合并生成政策' },
  { key: 'export',   title: '导出结果 Excel' }
]

// 老 step 顺序（与原 pipeline.step 字段 1:1 兼容）
const LEGACY_STEP_ORDER = ['upload', 'jxgj', 'o_combo', 'export']

// 哪些新 stage 属于"老 o_combo 粗阶段"（用于 legacy step 派生）
const O_STAGE_KEYS = new Set(['trip', 'o2', 'o3', 'a3_merge'])

export class Pipeline {
  constructor({ taskManager, fileManager, configManager, credentialManager, getMainWindow, userDataPath }) {
    this.taskManager = taskManager
    this.fileManager = fileManager
    this.configManager = configManager
    this.credentialManager = credentialManager
    this.getMainWindow = getMainWindow || (() => null)
    this.userDataPath = userDataPath

    this.stateFile = path.join(userDataPath, 'config', PIPELINE_STATE_FILE)
    this.ensureStateFileDir()

    this.mode = this.loadMode() // 'auto' | 'dev'

    // 业务模式（产什么）：不持久化，每次启动回到默认 policy
    this.businessMode = DEFAULT_BUSINESS_MODE

    // ★ 细粒度阶段状态（核心状态，替换原本粗粒度 status/step）
    this.stages = this._initStages()

    // 向后兼容字段（从 stages 派生；老代码仍然读写这两个，功能正常）
    this.status = 'idle'
    this.step = 'upload'
    this.lastGateFail = null

    // 携程限流额度推送定时器（只在 trip 阶段 running 时活跃）
    this._rateLimitTimer = null
    this._lastRateLimitPayload = null

    // 事件驱动实时推送：请求放行/429 冷却瞬间即推一帧（数值与请求发出时刻对齐，不等 1s 轮询）
    registry.get('trip').onRateLimitChange(() => this._pushRateLimitOnChange())

    // 接管 taskManager 的 onAllComplete：stage 完成后 saveStageResults + 推 IPC + 决定下一步
    if (this.taskManager?.scheduler) {
      this.taskManager.scheduler.onAllComplete = (results, stage) => this.handleStageComplete(results, stage)
    }
  }

  // ========== stages 初始化 ==========
  _initStages() {
    const map = new Map()
    for (const def of STAGE_DEFS) {
      map.set(def.key, { key: def.key, title: def.title, status: 'idle' })
    }
    return map
  }

  /** 部分/整体更新一个阶段。保持对象引用稳定，合并字段 */
  _setStage(key, patch) {
    const prev = this.stages.get(key)
    if (!prev) return
    Object.assign(prev, patch)
  }

  ensureStateFileDir() {
    const dir = path.dirname(this.stateFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  loadMode() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'))
        return data.mode === 'dev' ? 'dev' : 'auto'
      }
    } catch { /* ignore */ }
    return 'auto'
  }

  saveMode() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ mode: this.mode }, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[Pipeline] mode 持久化失败', e)
    }
  }

  // ========== legacy 派生（保持老调用方不破）==========
  /**
   * 派生老 step 字段（粗粒度 4 步）
   * 规则：找到第一个 status ∈ { idle, pending, running, failed, waiting_next } 的阶段，
   *       映射回对应粗 step；全部 completed/skipped 则是 export
   */
  _deriveLegacyStep() {
    for (const def of STAGE_DEFS) {
      const s = this.stages.get(def.key)
      if (!s) continue
      if (s.status === 'completed' || s.status === 'skipped') continue
      // 映射：新 stage key → 老 step
      if (def.key === 'upload') return 'upload'
      if (def.key === 'jxgj') return 'jxgj'
      if (O_STAGE_KEYS.has(def.key)) return 'o_combo'
      if (def.key === 'export') return 'export'
    }
    return 'export'
  }

  _deriveLegacyStatus() {
    const stageList = Array.from(this.stages.values())
    // running → 只要有阶段在跑
    if (stageList.some(s => s.status === 'running')) return 'running'
    // paused → 由 pause() 直接设，不派生（因为暂停不是阶段状态，是全局控制）
    // 如果全局当前 step 是 jxgj 或 o_combo 且 stages 中对应阶段仍未完成 → 检查是否 waiting_next
    const step = this._deriveLegacyStep()
    if (this.mode === 'dev') {
      // jxgj completed 但还没点 o_combo → waiting_next
      const jxgj = this.stages.get('jxgj').status
      if (step === 'o_combo' && jxgj === 'completed') {
        const anyORunningOrCompleted = O_PLATFORM_KEYS.some(p =>
          ['running', 'completed', 'failed'].includes(this.stages.get(p).status)
        )
        if (!anyORunningOrCompleted) return 'waiting_next'
      }
    }
    // done → export 之前 a3_merge 已 completed（不管是否已真正下载）
    if (this.stages.get('a3_merge').status === 'completed') return 'done'
    // paused → 保留外部设置（pause() 直接写 this.status = 'paused'）
    if (this.status === 'paused') return 'paused'
    return 'idle'
  }

  // ========== 对外 API ==========

  /**
   * 真实步骤流是否进行中
   * 设计：选择文件/下载文件 不算真实步骤流；
   * 只有点「开始」→ jxgj → OTA → a3_merge 的流程才算。
   * 进行中时不允许修改平台配置/账号(凭证)等基础配置。
   * true  when: status === 'running' | 'waiting_next' | 'paused'
   * false when: status === 'idle'    | 'done'
   */
  isInProgress() {
    this._syncLegacyFields()
    const s = this.status
    return s === 'running' || s === 'waiting_next' || s === 'paused'
  }

  /**
   * 启动流程（auto 模式入口）
   *   门禁通过 → upload 标记完成 → jxgj running → 调 runStage('jxgj')
   *   完成后 jxgj 回调里自动衔接 o_combo
   */
  async start() {
    if (this.status === 'running') return { success: false, message: '流程执行中，请勿重复操作' }

    const gate = this.checkGate()
    if (!gate.success) {
      this.lastGateFail = gate
      this.emit('pcp:pipeline:gateFail', gate)
      return gate
    }
    this.lastGateFail = null

    // —— 门禁通过：把阶段状态重置 + upload 标 completed ——
    this._resetRuntimeStages()
    const a1Count = this.fileManager?.getA1()?.count || 0
    this._setStage('upload', {
      status: 'completed',
      outputCount: a1Count,
      startedAt: Date.now(),
      finishedAt: Date.now()
    })

    this._setStage('jxgj', { status: 'running', startedAt: Date.now() })
    this._syncLegacyFields()
    this.emitState()

    await this.runStage('jxgj')
    return { success: true }
  }

  /**
   * dev 模式：用户点 StepFlow 触发某一步
   * @param {string} step  'jxgj' | 'o_combo'（保持老接口，内部映射到细阶段）
   */
  async triggerStep(step) {
    if (this.status === 'running') return { success: false, message: '流程执行中，请勿重复操作' }
    if (step !== 'jxgj' && step !== 'o_combo') {
      return { success: false, message: '未知的步骤' }
    }

    const gate = this.checkGate()
    if (!gate.success) {
      this.lastGateFail = gate
      this.emit('pcp:pipeline:gateFail', gate)
      return gate
    }
    this.lastGateFail = null

    // 第一次手动点 jxgj：重置 + upload 标 completed
    if (step === 'jxgj') {
      this._resetRuntimeStages()
      const a1Count = this.fileManager?.getA1()?.count || 0
      this._setStage('upload', {
        status: 'completed',
        outputCount: a1Count,
        startedAt: Date.now(),
        finishedAt: Date.now()
      })
    }

    if (step === 'jxgj') {
      this._setStage('jxgj', { status: 'running', startedAt: Date.now() })
    } else {
      // o_combo：先检查 jxgj 前置（upload 阶段通过 checkGate 已经保证有文件）
      const jxgj = this.stages.get('jxgj')
      if (jxgj.status !== 'completed' && jxgj.status !== 'failed') {
        // dev 模式下允许 jxgj 没跑完？不允许，依赖必须成立
        return { success: false, message: '请先完成锦绣国际阶段' }
      }
      // 在 runStage('o_combo') 内部会为每 O 平台标 running/skipped
    }

    this._syncLegacyFields()
    this.emitState()
    await this.runStage(step)
    return { success: true }
  }

  async pause() {
    if (this.status !== 'running') return { success: false, message: '没有正在运行的流程' }
    const r = this.taskManager.pause()
    if (r.success) {
      this.status = 'paused'
      this.emitState()
    }
    return r
  }

  /** 终止（硬中断）：running 任务标记 aborted；阶段状态保留（用户能看到卡在了哪一步）*/
  abort() {
    if (this.status !== 'running') return { success: false, message: '没有正在运行的流程' }
    this.taskManager?.abort()
    // 把所有 running 阶段标 failed + 错误说明
    const now = Date.now()
    for (const def of STAGE_DEFS) {
      const s = this.stages.get(def.key)
      if (s.status === 'running') {
        Object.assign(s, { status: 'failed', error: '用户终止', finishedAt: now })
      }
    }
    this.status = 'idle'
    this._syncLegacyFields()
    this.lastGateFail = null
    this.emit('pcp:task:state', this.taskManager.getState())
    this.emitState()
    return { success: true }
  }

  /** 重置到初始态（下载完成后 / 用户重新上传时调用）*/
  reset() {
    this.stages = this._initStages()
    this.status = 'idle'
    this.step = 'upload'
    this.lastGateFail = null
    this.emitState()
    if (this.taskManager) this.taskManager.clearAll()
    if (this.fileManager) this.fileManager.clearAll()
    return { success: true }
  }

  setMode(mode) {
    if (mode !== 'auto' && mode !== 'dev') return { success: false, message: '未知模式' }
    this.mode = mode
    this.saveMode()
    this.emitState()
    return { success: true, mode: this.mode }
  }

  /**
   * 切换业务模式（政策导入 / 底价检查）
   *   - 仅 idle/done（流程不在进行中）可切换（与配置/账号同一把硬锁）
   *   - 切换即全清：a1/a2/a3 + 任务队列 + 阶段状态全部回到初始态（用户需重新选文件）
   *   - 不持久化：重启回到默认 policy（见 constructor）
   */
  setBusinessMode(mode) {
    const valid = isValidBusinessMode(mode)
    if (!valid) return { success: false, message: '未知业务模式' }
    if (this.isInProgress()) {
      return { success: false, message: '流程执行中，请先完成或终止后再切换业务模式' }
    }
    this.businessMode = valid
    this.reset()
    this.emitState()
    return { success: true, businessMode: this.businessMode }
  }

  /**
   * 导出门控：**唯一权威位置**，替代原先 a3.count === 0 的判断
   * 语义：a3_merge 阶段 status === 'completed'（即使 outputCount=0）→ 可以下载
   * @returns {{ can: boolean, reason?: string, platformsToExport?: string[] }}
   *   platformsToExport: 为 0 条数据时仍生成每个完成平台的表头文件准备
   */
  canExport() {
    const a3 = this.stages.get('a3_merge')
    if (a3.status !== 'completed') {
      let reason = '请先完成 O 平台比价阶段'
      if (a3.status === 'failed') reason = a3.error || '比价阶段执行失败，无法导出'
      else if (a3.status === 'running') reason = '比价阶段执行中，请稍候'
      else if (a3.status === 'idle')    reason = '请先完成锦绣国际和 O 平台比价'
      return { can: false, reason }
    }
    // 收集：所有 O 平台中 status === 'completed' 的（即使 0 条 processedData 也要导出表头）
    const platformsToExport = O_PLATFORM_KEYS.filter(p => {
      const s = this.stages.get(p)
      return s.status === 'completed'
    })
    if (platformsToExport.length === 0) {
      return { can: false, reason: '没有已完成的 O 平台任务' }
    }
    return { can: true, platformsToExport }
  }

  getState() {
    // Map → 纯对象数组（序列化安全，前端 v-for 直接用）
    const stages = STAGE_DEFS.map(def => ({ ...(this.stages.get(def.key) || {}) }))
    this._syncLegacyFields()
    return {
      mode: this.mode,
      businessMode: this.businessMode,       // 业务模式（政策导入/底价检查）
      status: this.status,
      step: this.step,
      lastGateFail: this.lastGateFail,
      stages,                              // ★ 新：细粒度阶段数组
      _exportGate: this.canExport()        // ★ 新：下载门控（前端不用推导）
    }
  }

  // ========== 内部：辅助 ==========
  /** 把 stages 派生值写回 legacy 字段，保证老读取者看到一致值 */
  _syncLegacyFields() {
    // status: 如果 paused 是手动设的，保留；否则重新派生
    const derivedStatus = this._deriveLegacyStatus()
    // paused 是全局暂停状态，只有 pause() / resume 流程能改，派生时不覆盖
    if (this.status !== 'paused') {
      this.status = derivedStatus
    } else if (derivedStatus === 'running') {
      // 暂停中派生 running 也不恢复（等用户 resume）
    }
    this.step = this._deriveLegacyStep()
  }

  /** 重置运行中/已完成阶段状态到 idle（保留 upload，否则由调用方再设）*/
  _resetRuntimeStages() {
    for (const def of STAGE_DEFS) {
      const s = this.stages.get(def.key)
      Object.assign(s, {
        status: 'idle',
        error: undefined,
        skipReason: undefined,
        totalTasks: undefined,
        completedTasks: undefined,
        failedTasks: undefined,
        outputCount: undefined,
        startedAt: undefined,
        finishedAt: undefined
      })
    }
  }

  // ========== 内部：门禁检查 ==========
  /**
   * 前置门禁：选文件 → JXGJ 配置启用 → 至少一个 O 配置启用
   * 返回 { success, missing: ['file'|'jxgj_config'|'jxgj_credential'|'o_config'|'o_credential'] }
   */
  checkGate() {
    const missing = []

    // 1. 选文件
    const a1Count = this.fileManager?.getA1()?.count || 0
    if (a1Count === 0) missing.push('file')

    // 2. JXGJ 配置启用 + 账号选中
    // ★ 从运行时配置栈（taskManager.compiledConfigs）取，统一"一条路径"
    if (!this.taskManager?.isRuntimeEnabled('jxgj')) {
      missing.push('jxgj_config')
    } else if (!this.credentialManager?.getSelected('jxgj')) {
      missing.push('jxgj_credential')
    }

    // 3. 至少一个 O 平台启用 + 账号选中
    // ★ 从运行时配置栈取
    const oPlatforms = O_PLATFORM_KEYS
    const enabledO = oPlatforms.filter(p => this.taskManager?.isRuntimeEnabled(p))
    if (enabledO.length === 0) {
      missing.push('o_config')
    } else {
      const hasOCred = enabledO.some(p => this.credentialManager?.getSelected(p))
      if (!hasOCred) missing.push('o_credential')
    }

    if (missing.length === 0) return { success: true, missing: [] }
    return { success: false, missing }
  }

  // ========== 内部：执行 stage ==========
  /**
   * 执行某粗 stage：addBatchByStage + taskStart
   * @param {string} stage  'jxgj' | 'o_combo'
   */
  async runStage(stage) {
    const addResult = await this._invokeAddBatchByStage(stage)
    if (!addResult.success) {
      // 入队失败 → 标记对应阶段失败
      if (stage === 'jxgj') {
        this._setStage('jxgj', {
          status: 'failed', error: addResult.message || '任务入队失败',
          finishedAt: Date.now()
        })
      } else {
        for (const p of O_PLATFORM_KEYS) {
          const prev = this.stages.get(p)
          if (prev.status === 'running') {
            this._setStage(p, {
              status: 'failed', error: addResult.message || '任务入队失败',
              finishedAt: Date.now()
            })
          }
        }
      }
      this._syncLegacyFields()
      this.emitState()
      return
    }
    this.emit('pcp:task:state', this.taskManager.getState())
    const startResult = await this.taskManager.start(stage)
    if (!startResult.success) {
      if (stage === 'jxgj') {
        this._setStage('jxgj', {
          status: 'failed', error: startResult.message,
          finishedAt: Date.now()
        })
      } else {
        for (const p of O_PLATFORM_KEYS) {
          const prev = this.stages.get(p)
          if (prev.status === 'running') {
            this._setStage(p, {
              status: 'failed', error: startResult.message,
              finishedAt: Date.now()
            })
          }
        }
      }
      this._syncLegacyFields()
      this.emitState()
      this.emit('pcp:pipeline:gateFail', { success: false, missing: [], message: startResult.message })
    }
  }

  _invokeAddBatchByStage(stage) {
    const stageMap = {
      jxgj: { source: () => this.fileManager.getA1Data(), type: 'jxgj' },
      o_combo: { source: () => this.fileManager.getA2Data(), type: 'o_combo' }
    }
    const config = stageMap[stage]
    if (!config) return Promise.resolve({ success: false, message: '未知的阶段' })

    const sourceData = config.source()
    if (sourceData.length === 0) {
      return Promise.resolve({ success: false, message: '数据源为空，请先完成上一阶段' })
    }

    // o_combo 阶段：在入队前**就**把每个 O 平台阶段标 running/skipped（细阶段状态立刻可见）
    if (stage === 'o_combo' && this.credentialManager) {
      const hasAnyO = O_PLATFORM_KEYS.some(p => this.credentialManager.getSelected(p))
      if (!hasAnyO) {
        return Promise.resolve({ success: false, message: '未选择平台，请先在「账号管理」里为至少一个 O 平台选中账号' })
      }
      for (const p of O_PLATFORM_KEYS) {
        const enabled = this.taskManager?.isRuntimeEnabled(p)   // ★ 从运行时配置栈取
        const credOk = !!this.credentialManager?.getSelected(p)
        if (!enabled) {
          this._setStage(p, { status: 'skipped', skipReason: '平台未启用', finishedAt: Date.now() })
        } else if (!credOk) {
          this._setStage(p, { status: 'skipped', skipReason: '未选择账号', finishedAt: Date.now() })
        } else {
          // running：totalTasks 稍后在 handleStageComplete 统计（因为此时还在拆分前不知道总数）
          this._setStage(p, { status: 'running', startedAt: Date.now() })
          // 携程进入执行 → 启动限流额度推送定时器（徽章实时显示已用/总额 + 冷却倒计时）
          if (p === 'trip') this._startRateLimitTimer()
        }
      }
    }

    this.taskManager.clearAll()

    let tasks
    if (stage === 'o_combo') {
      const enabledO = O_PLATFORM_KEYS.filter(p =>
        this.taskManager?.isRuntimeEnabled(p)   // ★ 从运行时配置栈取
        && this.credentialManager?.getSelected(p))
      tasks = []
      for (const item of sourceData) {
        const dateObj = item && typeof item.date_obj === 'object' && item.date_obj !== null ? item.date_obj : null
        if (!dateObj) {
          for (const p of enabledO) {
            tasks.push({ type: p, data: { id: `${item.id}__${p}`, source: item, dateKey: null, dateValue: null } })
          }
          continue
        }
        for (const [dateKey, dateValue] of Object.entries(dateObj)) {
          for (const p of enabledO) {
            tasks.push({ type: p, data: { id: `${item.id}__${dateKey}__${p}`, source: item, dateKey, dateValue } })
          }
        }
      }
    } else {
      tasks = sourceData.map(item => ({ type: config.type, data: item }))
    }
    const added = this.taskManager.addBatch(tasks)
    return Promise.resolve({ success: true, count: added.length, tasks: added })
  }

  // ========== 内部：stage 完成回调（接管 taskManager.onAllComplete）==========
  /**
   * stage 完成：saveStageResults → 更新细阶段状态 → 推 IPC → 决定下一步
   */
  async handleStageComplete(results, stage) {
    const now = Date.now()
    // 1. 落盘（保持原行为）
    if (this.fileManager) this.fileManager.saveStageResults(stage, results)

    if (stage === 'jxgj') {
      const total = results.length
      const completed = results.filter(t => t.status === 'completed').length
      const failed = total - completed
      const a2Count = this.fileManager?.getA2()?.count || 0

      this._setStage('jxgj', {
        status: total === 0 ? 'failed' : 'completed',
        error: total === 0 ? '锦绣国际没有实际执行任务' : (failed > 0 ? `有 ${failed} 个任务失败` : undefined),
        totalTasks: total,
        completedTasks: completed,
        failedTasks: failed,
        outputCount: a2Count,
        finishedAt: now
      })

      // BUG-2 弹窗：收集失败任务的错误，按错误内容分组推给前端
      this._emitTaskErrors(results, 'jxgj')

      if (this.mode === 'auto') {
        // 衔接 o_combo（即使 a2Count=0 也要跑：让 O 阶段收到 0 任务失败信息，而不是卡在 jxgj）
        this._syncLegacyFields()
        this.emitState()
        await new Promise(r => setTimeout(r, 300))
        await this.runStage('o_combo')
      } else {
        this._syncLegacyFields()
        this.emitState()
      }
    } else if (stage === 'o_combo') {
      // ★ 按 task.type 拆分 trip/o2/o3 统计
      const byPlatform = { trip: [], o2: [], o3: [] }
      for (const t of results) {
        const type = t.type || (t.result?._usedCredential?.platform)
        if (byPlatform[type]) byPlatform[type].push(t)
      }

      for (const p of O_PLATFORM_KEYS) {
        const prev = this.stages.get(p)
        if (prev.status === 'skipped') continue  // 前面标 skipped 的不动
        const list = byPlatform[p] || []
        const total = list.length
        const completed = list.filter(t => t.status === 'completed').length
        const failed = total - completed
        // outputCount：该平台所有成功任务的 processedData.length 之和（0 也合法）
        const outputCount = list.reduce((sum, t) => {
          const pd = t.result?.processedData
          return sum + (Array.isArray(pd) ? pd.length : 0)
        }, 0)

        let status = 'completed'
        let error = undefined
        if (total === 0) {
          status = 'failed'
          error = '没有实际执行任务'
        } else if (failed === total) {
          status = 'failed'
          error = `全部 ${total} 个任务失败`
        } else if (failed > 0) {
          // 部分失败：仍标 completed（数据里成功的那些要参与合并），用 error 字段挂提示
          error = `${failed}/${total} 个任务失败`
        }

        this._setStage(p, {
          status, error,
          totalTasks: total, completedTasks: completed, failedTasks: failed,
          outputCount,
          finishedAt: now
        })
      }

      // a3_merge：读 saveStageResults 后 fileManager.a3 的 count
      const a3Count = this.fileManager?.getA3()?.count || 0
      const jxgjStatus = this.stages.get('jxgj').status
      const anyOCompleted = O_PLATFORM_KEYS.some(p => this.stages.get(p).status === 'completed')
      let a3Status = 'completed'
      let a3Error = undefined
      if (jxgjStatus !== 'completed') {
        a3Status = 'failed'
        a3Error = '锦绣国际阶段未成功完成'
      } else if (!anyOCompleted) {
        a3Status = 'failed'
        a3Error = '所有 O 平台均未成功执行（均跳过或全部失败）'
      } else {
        // outputCount 可能为 0 → 仍 completed
      }

      this._setStage('a3_merge', {
        status: a3Status,
        outputCount: a3Count,
        error: a3Error,
        startedAt: now,
        finishedAt: now
      })

      // BUG-2 弹窗：收集 O 平台失败任务的错误，按错误内容分组推给前端
      this._emitTaskErrors(results, 'o_combo')

      this._syncLegacyFields()
      this.emitState()
    }

    // 2. 推 pcp:task:allComplete（渲染层据此刷新 a1/a2/a3 计数 + 提示）
    this.emit('pcp:task:allComplete', { results, stage })
  }

  // ========== 工具：事件推送 ==========
  emit(channel, payload) {
    this.getMainWindow()?.webContents.send(channel, payload)
  }

  emitState() {
    this.emit('pcp:pipeline:state', this.getState())
  }

  /**
   * BUG-2 错误弹窗：收集 failed 任务的错误，按错误内容分组推 pcp:task:error
   *   同类型错误（相同 message）堆叠为一个，避免错误多时堆满页面
   *   前端收到后用 notification 弹窗（不自动关闭）
   * @param {Array} results - 任务结果数组
   * @param {string} stage - 'jxgj' | 'o_combo'
   */
  _emitTaskErrors(results, stage) {
    if (!this.getMainWindow()) return
    const failedTasks = results.filter(t => t.status === 'failed')
    if (failedTasks.length === 0) return

    // 按错误内容分组：相同 message 合并，记录出现次数和平台
    const groups = new Map()
    for (const t of failedTasks) {
      const msg = t.result?.error || t.result?.message || '未知错误'
      const platform = t.type || t.result?._usedCredential?.platform || stage
      const key = msg
      if (!groups.has(key)) {
        groups.set(key, { message: msg, platforms: new Set([platform]), count: 1 })
      } else {
        const g = groups.get(key)
        g.platforms.add(platform)
        g.count++
      }
    }

    // 推送给前端：数组，每项 { message, platforms: string[], count }
    const errors = Array.from(groups.values()).map(g => ({
      message: g.message,
      platforms: Array.from(g.platforms),
      count: g.count
    }))
    this.emit('pcp:task:error', { stage, errors })
  }

  // ========== 携程限流额度实时推送（前端徽章：已用 x/limit · 冷却 s） ==========
  /**
   * 构建限流额度载荷（invoke 与定时推送共用的单一实现）
   *   limit 阈值取自 taskManager.compiledConfigs.trip（与限流器实际执行同一条路径）
   *   快照取自 trip adapter 的进程级限流器单例（windowCount = 60s 窗口内已发出请求数）
   */
  buildRateLimitPayload() {
    const snapshot = registry.get('trip').getRateLimitState()
    const limit = Number(this.taskManager?.compiledConfigs?.trip?.rateLimitPerMin) || 0
    return {
      limit,
      used: snapshot.windowCount,
      remaining: limit > 0 ? Math.max(0, limit - snapshot.windowCount) : null,
      cooldownRemainingMs: snapshot.cooldownRemainingMs
    }
  }

  // 启动 1s 定时器：立即推一帧，之后每秒读数，值变化才推
  //   （滑动窗口自然回落 + 冷却倒计时都会让值持续变化，因此推送是实时的）
  _startRateLimitTimer() {
    if (this._rateLimitTimer) return
    this._lastRateLimitPayload = null
    this._rateLimitTimer = setInterval(() => this._tickRateLimitTimer(), 1000)
    this._tickRateLimitTimer()
  }

  _tickRateLimitTimer() {
    // trip 不在 running → 停表 + 推最后一帧 active:false（覆盖完成/失败/用户终止/重置等所有出口）
    if (this.stages.get('trip')?.status !== 'running') {
      const finalPayload = { ...this.buildRateLimitPayload(), active: false }
      this._stopRateLimitTimer()
      this._lastRateLimitPayload = JSON.stringify(finalPayload)
      this.emit('pcp:ratelimit:state', finalPayload)
      return
    }
    const payload = { ...this.buildRateLimitPayload(), active: true }
    const key = JSON.stringify(payload)
    if (key === this._lastRateLimitPayload) return
    this._lastRateLimitPayload = key
    this.emit('pcp:ratelimit:state', payload)
  }

  // 事件驱动推送：限流器状态变化（请求放行 → used+1 / 429 → 进入冷却）瞬间触发
  //   只在 trip 阶段 running 时推；1s 定时器仍保留兜底（窗口自然回落 + 冷却倒计时跳动）
  _pushRateLimitOnChange() {
    if (this.stages.get('trip')?.status !== 'running') return
    const payload = { ...this.buildRateLimitPayload(), active: true }
    this._lastRateLimitPayload = JSON.stringify(payload)
    this.emit('pcp:ratelimit:state', payload)
  }

  _stopRateLimitTimer() {
    if (this._rateLimitTimer) clearInterval(this._rateLimitTimer)
    this._rateLimitTimer = null
  }
}

export default Pipeline
