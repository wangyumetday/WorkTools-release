// ============================================================
// PCP TaskManager - 任务队列管理器
// 职责：
//   - 维护任务队列（addTask / addBatch / deleteTask / clearAll）
//   - 并发池调度（start / pause / setConcurrency / runNextTask 自驱）
//   - 平台请求分发（executeTask → executeG1/O1/O2/O3/OComboTask）
//   - 进度回调推送（onProgress）+ 全部完成回调（onAllComplete）
//
// 依赖：
//   - credentialManager: 注入，按平台取该平台当前选中的账密
//   - configManager:     注入，按平台取该平台的字符串配置（公式等）
//   - platforms/g1.js / o1.js / o2.js / o3.js: 各平台的请求 + 登录函数 + 公式编译器
//
// 并发模型（self-driven worker pool）：
//   ┌─ start() 唤醒 min(concurrency, pending) 个 worker
//   ├─ 每个 worker：扫描 pending → CAS 标记 running → 执行 → activeCount-- → 自驱找下一个
//   └─ 没有 pending 且 activeCount=0 → onAllComplete 收尾
// ============================================================

import { g1Request, g1Login, compilePlatformConfig as compileG1 } from './platforms/g1.js'
import { o1Request, o1Login, compilePlatformConfig as compileO1 } from './platforms/o1.js'
import { o2Request, o2Login, compilePlatformConfig as compileO2 } from './platforms/o2.js'
import { o3Request, o3Login, compilePlatformConfig as compileO3 } from './platforms/o3.js'

// 平台 → 公式编译器映射（每个平台自己定义"字符串怎么变函数"）
// 代码 key 用简称：jxgj=锦绣国际, trip=携程OTA, o2/o3 保持不变
const PLATFORM_COMPILERS = {
  jxgj: compileG1,
  trip: compileO1,
  o2: compileO2,
  o3: compileO3
}

// O 平台 → 登录/请求函数映射（executeOComboTask 用它动态挑有账号的平台调用）
// 代码 key：trip=携程OTA（原O1），o2/o3 保持不变
const O_PLATFORM_HANDLERS = {
  trip: { login: o1Login, request: o1Request },
  o2: { login: o2Login, request: o2Request },
  o3: { login: o3Login, request: o3Request }
}

/**
 * 中文说明：
 *   业务需求里，锦绣国际(JXGJ) / 携程OTA(TRIP) / O2 / O3 四个平台**各自都有自己的账号密码**，
 *   请求锦绣国际时必须使用"锦绣国际当前选中的账密"去登录，
 *   请求 O 组合（o_combo）时需要同时使用 TRIP、O2、O3 各自的选中账密分别登录。
 *
 *   因此 TaskManager 不再靠"全局唯一的 selectedId"，
 *   而是通过构造参数拿到 credentialManager 引用，
 *   在执行对应平台任务前，用 getSelected(platform) 拿到**该平台**的账密。
 */
export class TaskManager {
  constructor({ onProgress, onAllComplete, credentialManager, configManager }) {
    this.tasks = []
    this.isRunning = false
    this.isPaused = false
    // ── 并发执行支持 ──
    //   concurrency: 同时执行的最大任务数（默认 1 = 串行，向后兼容）
    //   activeCount: 当前正在执行的任务数（worker 自驱递增/递减）
    this.concurrency = 4
    this.activeCount = 0
    // currentTaskIndex 仅用于串行模式兼容 / 删除任务时调整游标，并发模式下不再作为执行指针
    this.currentTaskIndex = -1
    this.onProgress = onProgress || (() => { })
    this.onAllComplete = onAllComplete || (() => { })
    this.taskIdCounter = 0
    this.currentStage = null
    // 主进程全局只实例化一次，这里通过依赖注入拿到引用
    this.credentialManager = credentialManager || null
    this.configManager = configManager || null
    // 预编译后的平台配置缓存（floorPriceFormula 已是函数）
    // 由 start() 调用 precompilePlatformConfigs() 填充，整批任务共用一份
    this.compiledConfigs = {}
  }

  /**
   * 设置并发数（运行时也可调）
   *   - 运行中调大：会立刻唤醒额外 worker 认领 pending 任务
   *   - 运行中调小：不会中断正在执行的任务，只是空闲 worker 不再自驱
   *   - 范围限制 [1, 10]，避免误操作开太多导致平台限流
   */
  setConcurrency(n) {
    const next = Math.max(1, Math.min(10, Math.floor(Number(n) || 1)))
    const prev = this.concurrency
    this.concurrency = next
    // 运行中且未暂停且并发数调大 → 唤醒额外 worker
    if (this.isRunning && !this.isPaused && next > prev) {
      const pendingCount = this.tasks.filter(t => t.status === 'pending' || t.status === 'paused').length
      const slotsAvailable = next - this.activeCount
      const extraWorkers = Math.max(0, Math.min(slotsAvailable, pendingCount))
      for (let i = 0; i < extraWorkers; i++) {
        setImmediate(() => this.runNextTask())
      }
    }
    return { success: true, concurrency: this.concurrency }
  }

  // ========== 进度推送序列化：只挑前端进度显示需要的最小字段 ==========
  //   - 目标：1~2千条任务下，每条 onProgress 推送的序列化体积从几KB降到 ~100字节
  //   - 前端显示一列5个字段：ID / 类型 / 进度% / 状态 / 耗时 → 对应 id/type/progress/status/startedAt/finishedAt
  serializeProgress(t) {
    return {
      id: t.id,
      type: t.type,
      status: t.status,
      progress: t.progress ?? 0,
      // 时间戳用于前端计算耗时（未开始的 startedAt=null，前端显示--:--）
      startedAt: t.startedAt ?? null,
      finishedAt: t.finishedAt ?? null,
      createdAt: t.createdAt ?? null
    }
  }

  // 添加单个任务到队列尾部
  addTask(task) {
    const newTask = {
      id: `task_${++this.taskIdCounter}`,
      type: task.type || 'jxgj',
      status: 'pending',
      progress: 0,
      data: task.data || {},
      result: null,
      createdAt: Date.now(),
      // startedAt 在任务被 worker 认领（status 变 running）时才赋值，见 runNextTask
      startedAt: null,
      finishedAt: null
    }
    this.tasks.push(newTask)
    return newTask
  }

  // 批量添加任务
  addBatch(tasks) {
    const results = []
    for (const task of tasks) {
      results.push(this.addTask(task))
    }
    return results
  }

  // 删除任务（运行中的不允许删）
  deleteTask(taskId) {
    const index = this.tasks.findIndex(t => t.id === taskId)
    if (index === -1) return false
    if (this.tasks[index].status === 'running') return false
    this.tasks.splice(index, 1)
    if (index < this.currentTaskIndex) {
      this.currentTaskIndex--
    }
    return true
  }

  // 清空所有非运行中的任务
  clearAll() {
    const runningTasks = this.tasks.filter(t => t.status === 'running')
    this.tasks = runningTasks
    this.currentTaskIndex = -1
    return true
  }

  // 启动任务队列（按 stage 标记当前阶段，便于完成后写入对应数据）
  start(stage = null) {
    if (this.isRunning) return { success: false, message: '任务已在运行中' }
    const pendingTasks = this.tasks.filter(t => t.status === 'pending' || t.status === 'paused')
    if (pendingTasks.length === 0) return { success: false, message: '没有待执行的任务' }

    // ★ 尽早预编译：任务开跑前一次性把所有平台的字符串公式编译成函数
    //   - 整批任务共用一份编译结果（不是每次请求才编译）
    //   - 编译失败时 fail-fast，不让任务运行到一半才发现公式错
    this.precompilePlatformConfigs()

    // ★ 账号预检：根据 stage 检查对应平台账号是否已选中
    //   未配置账号时 fail-fast 直接返回，避免 worker 启动后瞬间全部失败
    //   用户连"为什么失败"都看不到的尴尬场面
    const credCheck = this.checkStageCredentials(stage)
    if (!credCheck.success) return credCheck

    this.isRunning = true
    this.isPaused = false
    this.currentStage = stage
    this.activeCount = 0

    // ── 并发池启动：一次性唤醒 min(concurrency, pendingTasks.length) 个 worker ──
    //   每个 worker 进入"认领-执行-自驱"循环，跑完一个任务自动找下一个
    //   没任务可领且 activeCount=0 时触发 onAllComplete
    const initialWorkers = Math.min(this.concurrency, pendingTasks.length)
    for (let i = 0; i < initialWorkers; i++) {
      setImmediate(() => this.runNextTask())
    }
    return { success: true }
  }

  /**
   * 预编译所有平台的字符串配置 → 函数版配置，缓存到 this.compiledConfigs。
   * 调用时机：start() 启动时一次；之后 runPlatformRequest 直接读缓存注入 context。
   * 编译逻辑封装在各平台文件里（g1.js / o1.js / ...），TaskManager 只调度。
   */
  precompilePlatformConfigs() {
    this.compiledConfigs = {}
    if (!this.configManager) {
      console.warn('[TaskManager] 未注入 ConfigManager，跳过平台配置预编译')
      return
    }
    for (const [platform, compiler] of Object.entries(PLATFORM_COMPILERS)) {
      const rawConfig = this.configManager.getPlatformConfig(platform)
      this.compiledConfigs[platform] = compiler(rawConfig)
    }
  }

  /**
   * 启动前的账号预检：根据 stage 检查对应平台账号是否已选中
   *   - jxgj 阶段：必须有锦绣国际(JXGJ)平台账号（缺则 fail-fast）
   *   - o_combo 阶段：TRIP/O2/O3 至少有一个选中账号（executeOComboTask 会跳过没账号的平台）
   *   - 其他 stage（含 null）：跳过预检，由 runPlatformRequest 自己抛错（兼容老逻辑）
   *
   * 返回 { success: true } 或 { success: false, message }
   * 调用时机：start() 内部、isRunning=true 之前，fail-fast 阻止任务启动
   */
  checkStageCredentials(stage) {
    // 没注入 credentialManager 时不在此处拦，让 runPlatformRequest 抛错带上下文
    if (!this.credentialManager) return { success: true }

    // jxgj 阶段：必须有锦绣国际账号
    if (stage === 'jxgj') {
      if (this.credentialManager.getSelected('jxgj')) return { success: true }
      return {
        success: false,
        message: '锦绣国际未配置账号，请先在「账号管理」里为锦绣国际选中一个账号'
      }
    }

    // o_combo 阶段：TRIP/O2/O3 至少一个有账号（executeOComboTask 内部会跳过没账号的平台）
    if (stage === 'o_combo') {
      const hasAny = ['trip', 'o2', 'o3'].some(p => this.credentialManager.getSelected(p))
      if (hasAny) return { success: true }
      return {
        success: false,
        message: '未选择平台，请先在「账号管理」里为至少一个 O 平台选中账号'
      }
    }

    // 未知 stage（含 null）：跳过预检
    return { success: true }
  }

  // 请求暂停（正在执行的任务让它跑完，跑完后 worker 退出）
  pause() {
    if (!this.isRunning) return { success: false, message: '没有正在运行的任务' }
    // 并发模式下的暂停语义：
    //   - 标记 isPaused=true，空闲 worker 退出循环（不再认领新任务）
    //   - 正在运行的任务（activeCount 个）让它自然跑完，跑完后 worker 退出
    //   - 当 activeCount 归零时由最后一个 worker 把 isRunning 置 false
    this.isPaused = true
    return { success: true, message: '已请求暂停，正在执行的任务完成后停止' }
  }

  // 获取当前队列状态（前端初始化和刷新时调用）
  getState() {
    return {
      tasks: [...this.tasks],
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      currentTaskIndex: this.currentTaskIndex,
      currentStage: this.currentStage,
      // 并发状态：前端用于显示"并发数 N / 当前并发 M"
      concurrency: this.concurrency,
      activeCount: this.activeCount
    }
  }

  /**
   * 并发池 worker：认领-执行-自驱
   *   ┌─ 1. 检查运行状态（暂停/停止 → 退出本 worker）
   *   ├─ 2. 从队列扫描 pending 任务，CAS 式标记为 running（避免多 worker 重复认领）
   *   ├─ 3. 没有 pending：
   *   │     ├─ activeCount===0 → 全部完成，触发 onAllComplete
   *   │     └─ 否则退出本 worker（等正在跑的跑完再说）
   *   ├─ 4. 执行任务（executeTask），activeCount++ / 跑完 activeCount--
   *   └─ 5. 自驱：setImmediate(() => runNextTask()) 继续找下一个
   */
  async runNextTask() {
    // 1. 暂停或已停止：本 worker 退出
    if (!this.isRunning || this.isPaused) {
      // 最后一个 worker 退出时把状态收尾
      if (this.isPaused && this.activeCount === 0) {
        this.isRunning = false
        this.isPaused = false
      }
      return
    }

    // 2. 扫描认领一个 pending 任务（CAS：立即标记为 running，避免其他 worker 重复认领）
    let claimedTask = null
    for (let i = 0; i < this.tasks.length; i++) {
      const t = this.tasks[i]
      if (t.status === 'pending' || t.status === 'paused') {
        t.status = 'running'
        t.progress = 0
        t.startedAt = Date.now()   // ★ 任务真正开始执行的时间戳（前端用它算耗时，排除排队等待）
        claimedTask = t
        break
      }
    }

    // 3. 没有 pending 任务可认领
    if (!claimedTask) {
      // 当前 worker 没活干，但可能其他 worker 还在跑
      if (this.activeCount === 0) {
        // 所有 worker 都空闲 + 没有 pending → 整批完成
        this.isRunning = false
        this.currentTaskIndex = -1
        const completedTasks = this.tasks.filter(t => t.status === 'completed')
        this.onAllComplete(completedTasks, this.currentStage)
        this.currentStage = null
      }
      // 否则：本 worker 退出，等正在跑的 worker 跑完后自驱继续扫描
      return
    }

    // 4. 执行任务
    const task = claimedTask
    this.activeCount++
    this.onProgress(this.serializeProgress(task))

    // 模拟进度更新（并发模式下每个任务独立计时）
    //   注：进度推送体积已由 serializeProgress 精简；16ms 合批在 main.js 层做，此处按正常频率触发即可
    const progressInterval = setInterval(() => {
      if (task.progress < 90) {
        task.progress += Math.random() * 15
        if (task.progress > 95) task.progress = 90
        this.onProgress(this.serializeProgress(task))
      }
    }, 300)

    try {
      const result = await this.executeTask(task)
      clearInterval(progressInterval)
      task.status = 'completed'
      task.progress = 100
      task.result = result
      task.finishedAt = Date.now()
      this.onProgress(this.serializeProgress(task))
    } catch (error) {
      clearInterval(progressInterval)
      task.status = 'failed'
      task.progress = 0
      task.result = { error: error.message }
      task.finishedAt = Date.now()
      this.onProgress(this.serializeProgress(task))
    } finally {
      this.activeCount--
    }

    // 5. 自驱：继续找下一个任务（暂停时由步骤 1 退出）
    setImmediate(() => this.runNextTask())
  }

  /**
   * 内部辅助：执行"某平台请求 + 账密登录"的完整流程
   * @param {string} platform    平台标识，例如 'g1' / 'o1' / 'o2' / 'o3'
   * @param {object} data        业务请求数据
   * @param {Function} loginFn   平台登录函数: (credential) => Promise<loginResult>
   * @param {Function} requestFn 平台请求函数: (data, { credential, loginResult }) => Promise<response>
   */
  async runPlatformRequest(platform, data, loginFn, requestFn) {
    if (!this.credentialManager) {
      throw new Error(`[${platform}] 任务执行失败：未注入 CredentialManager，无法读取平台账密`)
    }

    // 步骤 1：只取"当前平台"的选中账密 —— 这是本次需求的关键
    const credential = this.credentialManager.getSelected(platform)
    if (!credential) {
      throw new Error(`[${platform}] 未配置账号，请先在"账密管理"里为该平台选择一个账号（或选择空则无法执行请求）`)
    }

    // 步骤 2：使用该平台账密登录，拿到 token/session 等
    const loginResult = await loginFn(credential)

    // ★ 取该平台的"预编译后"配置（floorPriceFormula 已是函数）
    //   由 start() 阶段调用 precompilePlatformConfigs() 一次性编译缓存
    const platformConfig = this.compiledConfigs[platform] || {}

    // 步骤 3：把登录上下文连同业务数据一起传给请求函数
    // ★ 把 platformConfig 也塞进 context，平台适配器直接 context.platformConfig 取
    const requestResult = await requestFn(data, { credential, loginResult, platformConfig })


    // 顺带把"本次使用的账号"信息附加在结果头部，方便前端日志/调试展示
    // （不覆盖原请求返回体，避免破坏下游字段读取）
    const usedCredentialInfo = {
      id: credential.id,
      name: credential.name,
      username: credential.username,
      platform: credential.platform
    }

    if (requestResult && typeof requestResult === 'object') {
      return { ...requestResult, _usedCredential: usedCredentialInfo }
    }
    return { payload: requestResult, _usedCredential: usedCredentialInfo }
  }

  // 根据 task.type 分发到对应平台的执行函数
  async executeTask(task) {
    switch (task.type) {
      case 'jxgj':
        return this.executeJxgjTask(task.data)
      case 'trip':
        return this.executeTripTask(task.data)
      case 'o2':
        return this.executeO2Task(task.data)
      case 'o3':
        return this.executeO3Task(task.data)
      case 'o_combo':
        return this.executeOComboTask(task.data)
      default:
        throw new Error(`未知的任务类型: ${task.type}`)
    }
  }

  // 锦绣国际(JXGJ) 任务执行（单平台请求）
  async executeJxgjTask(data) {
    return this.runPlatformRequest('jxgj', data, g1Login, g1Request)
  }

  // 携程OTA(TRIP) 任务执行
  async executeTripTask(data) {
    return this.runPlatformRequest('trip', data, o1Login, o1Request)
  }

  // O2 平台任务执行
  async executeO2Task(data) {
    return this.runPlatformRequest('o2', data, o2Login, o2Request)
  }

  // O3 平台任务执行
  async executeO3Task(data) {
    return this.runPlatformRequest('o3', data, o3Login, o3Request)
  }

  /**
   * O平台组合请求：只调用"已选中账号"的 O 平台并行请求，
   * 没账号的平台直接跳过（不在 result 里出现，下游用可选链读取）。
   *
   * 设计目的：用户允许只配置部分 O 平台账号，任务自动跳过没账号的平台，
   * 而不是 fail-fast 拦截整个 o_combo 任务。
   * 边界：三个都没账号的情况由 addBatchByStage / checkStageCredentials 提前拦截，
   *       走到这里时 platforms 至少有一个元素。
   */
  async executeOComboTask(data) {
    // 1. 扫描 trip/o2/o3 哪些有选中账号，只调用有账号的平台
    const platforms = ['trip', 'o2', 'o3'].filter(p => this.credentialManager?.getSelected(p))

    // 2. 并行调用有账号的平台（每个平台独立登录/请求，互不影响）
    const settled = await Promise.allSettled(
      platforms.map(p => {
        const { login, request } = O_PLATFORM_HANDLERS[p]
        return this.runPlatformRequest(p, data, login, request)
      })
    )

    // 3. 整理 result：fulfilled 放 value，rejected 放 error；没调用的平台不进 result
    const result = {}
    platforms.forEach((p, i) => {
      const r = settled[i]
      result[p] = r.status === 'fulfilled'
        ? r.value
        : { error: r.reason?.message || String(r.reason) }
    })
    return result
  }

  // 已废弃，保留占位（向后兼容）
  async simulateProgress(taskFn) {
    return taskFn()
  }
}
