// ============================================================
// PCP TaskScheduler - 任务调度器（阶段2 拆分自 taskManager.js）
// 职责：
//   - 维护任务队列（addTask / addBatch / deleteTask / clearAll）
//   - 并发池调度（start({execute}) / pause / setConcurrency / runNextTask 自驱）
//   - 任务级进度回调（reportTaskProgress）+ 全部完成回调（onAllComplete）
//
// 不关心平台逻辑：execute(task, {onStep}) 回调由 facade 注入（platformRunner.runByType）
// 不关心配置：compiledConfigs 由 facade 持有
// ============================================================

// ★ 请求项状态机：task.stage 的合法取值与转换
//   idle       已入队，预请求已配置，等待调度器拉起
//   credential 取账密中（progress=5）
//   login      登录中（progress=15）
//   prepare    已组请求参数（progress=30）
//   request    请求已发起，等返回（progress=60）
//   merge      已返回，交叉处理中（progress=90）
//   done       完成（progress=100，由 scheduler 在 status='completed' 时设）
//   failed     失败（带 error，由 scheduler 在 catch 时设）
//   skipped    跳过（带 reason，保留给将来"跳过请求"场景，当前 runner 不主动报）
const REQUEST_STAGES = ['idle', 'credential', 'login', 'prepare', 'request', 'merge', 'done', 'failed', 'skipped']

// 合法转换表：from → Set<to>
//   非法转换（如 done→request）打 warn 并拒绝，防调度器 bug 导致 UI 状态错乱
const TRANSITIONS = {
  idle:       new Set(['credential', 'skipped', 'failed']),
  credential: new Set(['login', 'failed']),
  login:      new Set(['prepare', 'failed', 'skipped']),
  prepare:    new Set(['request', 'failed']),
  request:    new Set(['merge', 'failed']),
  merge:      new Set(['done', 'failed']),
  done:       new Set(),
  failed:     new Set(),
  skipped:    new Set()
}

/**
 * 校验 stage 转换合法性
 * @returns {boolean} true=合法，false=非法（调用方应打 warn 并拒绝）
 */
export function transition(current, next) {
  if (!REQUEST_STAGES.includes(next)) return false
  if (current === next) return true // 同 stage 重复推送（如 creep 多次报 request）合法
  const allowed = TRANSITIONS[current]
  return allowed ? allowed.has(next) : false
}

export class TaskScheduler {
  /**
   * @param {object} deps
   *   - onProgress:    (taskSerialized) => void 单任务进度变化时推送（外部合批/IPC 推送）
   *   - onAllComplete: (finishedTasks, stage) => void 全部完成时推送
   *                    finishedTasks = 当前 stage 的全部任务（completed + failed / 含 aborted 标记）
   *                    外部（Pipeline）据此统计 totalTasks / completedTasks / failedTasks
   */
  constructor({ onProgress, onAllComplete }) {
    this.tasks = []
    this.isRunning = false
    this.isPaused = false
    this.concurrency = 6
    this.activeCount = 0
    this.currentTaskIndex = -1
    this.onProgress = onProgress || (() => { })
    this.onAllComplete = onAllComplete || (() => { })
    this.taskIdCounter = 0
    this.currentStage = null
    // execute 回调由 start 注入（避免构造时耦合 platformRunner）
    this._execute = null
    // 防并发链重复触发 onAllComplete：每次 start() 重置，进入 completion 块 CAS 置 true
    this._completionFired = false
  }

  setConcurrency(n) {
    // 并发上限 16（前端加减按钮同步此值）
    const next = Math.max(1, Math.min(16, Math.floor(Number(n) || 1)))
    const prev = this.concurrency
    this.concurrency = next
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

  serializeProgress(t) {
    return {
      id: t.id,
      type: t.type,
      status: t.status,
      progress: t.progress ?? 0,
      // ★ 状态机字段：stage/preRequest/error 透传给前端 RequestItem 渲染
      stage: t.stage ?? 'idle',
      preRequest: t.preRequest ?? null,
      error: t.error ?? null,
      startedAt: t.startedAt ?? null,
      finishedAt: t.finishedAt ?? null,
      createdAt: t.createdAt ?? null,
      result: t.result ?? null   // 透传 result（含 error / errorType / isFatal 等失败详情），供前端 TaskMonitor 展开查看
    }
  }

  addTask(task) {
    const newTask = {
      id: `task_${++this.taskIdCounter}`,
      type: task.type || 'jxgj',
      status: 'pending',
      progress: 0,
      // ★ 状态机：stage 从 idle 起步，随 platformRunner report(p, stage) 推进
      //   preRequest 由调用方（pipeline._invokeAddBatchByStage）入队时挂上（adapter.prepareRequest 算出的参数）
      //   error 在 failed 终态时填充失败原因
      stage: 'idle',
      preRequest: task.preRequest ?? null,
      error: null,
      data: task.data || {},
      result: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null
    }
    this.tasks.push(newTask)
    return newTask
  }

  addBatch(tasks) {
    const results = []
    for (const task of tasks) {
      results.push(this.addTask(task))
    }
    return results
  }

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

  /**
   * 清空已结束的任务（completed/failed/aborted），保留 pending/paused/running
   *   任务列表跨阶段累积，不再自动清除；用户点「清空」按钮按需清理
   */
  clearAll() {
    const keepStatus = new Set(['pending', 'paused', 'running'])
    this.tasks = this.tasks.filter(t => keepStatus.has(t.status))
    this.currentTaskIndex = -1
    return true
  }

  /**
   * 启动并发池
   * @param {object} opts
   *   - stage:    'jxgj' | 'o_combo' | null  当前阶段标识（onAllComplete 回调时透传）
   *   - execute:  async (task, { onStep }) => result  任务执行回调（facade 注入 platformRunner.runByType）
   */
  start({ stage = null, execute } = {}) {
    if (this.isRunning) return { success: false, message: '任务已在运行中' }
    const pendingTasks = this.tasks.filter(t => t.status === 'pending' || t.status === 'paused')
    if (pendingTasks.length === 0) return { success: false, message: '没有待执行的任务' }

    this._execute = execute || null
    this.isRunning = true
    this.isPaused = false
    this.currentStage = stage
    this.activeCount = 0
    this._completionFired = false

    const initialWorkers = Math.min(this.concurrency, pendingTasks.length)
    for (let i = 0; i < initialWorkers; i++) {
      setImmediate(() => this.runNextTask())
    }
    return { success: true }
  }

  pause() {
    if (!this.isRunning) return { success: false, message: '没有正在运行的任务' }
    this.isPaused = true
    return { success: true, message: '已请求暂停，正在执行的任务完成后停止' }
  }

  /**
   * 终止（硬中断）：
   *   - isRunning=false → runNextTask 自驱循环停止，不再领取新任务
   *   - running 任务标记 'aborted' → reportTaskProgress 的 status!=='running' 检查
   *     自动挡掉在途 creep 进度推送，进度条冻在当前值
   *   - 在途 HTTP 回来后 runNextTask 的 await 后检查 task.status==='aborted' →
   *     丢弃结果（不更新 completed、不推 onProgress、不减 activeCount、不继续循环）
   *   - 不触发 onAllComplete（流程被中断，不算"全部完成"）
   *   - 下次 start() 时 clearAll 清掉 aborted 任务，从头跑
   */
  abort() {
    this.isRunning = false
    this.isPaused = false
    for (const t of this.tasks) {
      if (t.status === 'running') t.status = 'aborted'
    }
    return { success: true }
  }

  getState() {
    return {
      tasks: [...this.tasks],
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      currentTaskIndex: this.currentTaskIndex,
      currentStage: this.currentStage,
      concurrency: this.concurrency,
      activeCount: this.activeCount
    }
  }

  /**
   * 外部（platformRunner）每完成一个业务步骤时调用，更新 task.progress 并推送
   * 进度只增不减（避免回退）；运行外任务的状态变化被忽略
   *
   * ★ 状态机升级：payload 支持两种形式
   *   - 旧形式（数字）：reportTaskProgress(task, 30) → 仅更新 progress
   *   - 新形式（对象）：reportTaskProgress(task, {progress, stage, error?, reason?})
   *     → transition() 校验 stage 合法性后更新 task.stage（非法转换打 warn 拒绝）
   *   两种形式都更新 progress，并触发 onProgress 推送
   *
   * @param {object} task       任务对象引用（scheduler.tasks 中的元素）
   * @param {number|object} payload  0-100 数字 或 {progress, stage, error?, reason?}
   */
  reportTaskProgress(task, payload) {
    if (!task || task.status !== 'running') return

    // 解析 payload：数字或对象
    let nextProgress
    let nextStage = null
    let errMsg = null
    if (typeof payload === 'object' && payload !== null) {
      nextProgress = payload.progress
      nextStage = payload.stage ?? null
      errMsg = payload.error ?? null
    } else {
      nextProgress = payload
    }

    const next = Math.max(0, Math.min(100, nextProgress))
    // 进度只增不减：但 stage 转换仍要尝试（同 progress 不同 stage 合法，如 30→30 但 stage=prepare→request 不合法）

    // ★ 状态机转换校验：非法转换打 warn 拒绝（防调度器 bug 导致 UI 状态错乱）
    if (nextStage !== null && nextStage !== task.stage) {
      if (!transition(task.stage, nextStage)) {
        console.warn(`[TaskScheduler] 非法 stage 转换: ${task.stage} → ${nextStage} (task=${task.id})`)
        // 仍更新 progress，但不更新 stage
      } else {
        task.stage = nextStage
      }
    }

    // failed 终态由 catch 分支处理，这里不覆盖
    if (errMsg && task.stage !== 'failed') {
      task.error = errMsg
    }

    if (next > task.progress) {
      task.progress = next
    }
    this.onProgress(this.serializeProgress(task))
  }

  async runNextTask() {
    if (!this.isRunning || this.isPaused) {
      if (this.isPaused && this.activeCount === 0) {
        this.isRunning = false
        this.isPaused = false
      }
      return
    }

    // 并发上限：activeCount 达到 concurrency 时不再领取新任务
    // 该回调链停止；其他 worker 完成任务后 activeCount-- 并 setImmediate 唤醒新链
    if (this.activeCount >= this.concurrency) return

    let claimedTask = null
    for (let i = 0; i < this.tasks.length; i++) {
      const t = this.tasks[i]
      if (t.status === 'pending' || t.status === 'paused') {
        t.status = 'running'
        t.progress = 0
        t.startedAt = Date.now()
        claimedTask = t
        break
      }
    }

    if (!claimedTask) {
      if (this.activeCount === 0) {
        this.isRunning = false
        this.currentTaskIndex = -1
        // 防并发链重复触发：多 worker 同时回零可能同时走到这
        // 用一次性旗标保证 onAllComplete 每次 start() 只跑一次
        if (!this._completionFired) {
          this._completionFired = true
          // 传全部任务（包含失败）给回调：Pipeline 需要算 failed 统计、
          // fileManager 需要失败任务兜底生成 0 行不崩
          const finishedTasks = this.tasks.slice()
          const stage = this.currentStage
          this.currentStage = null
          // BUG-3 修复：onAllComplete 可能返回 Promise（Pipeline.handleStageComplete 是 async）
          // 不 await 会导致 auto 模式阶段衔接 fire-and-forget + 未捕获 rejection
          try {
            const ret = this.onAllComplete(finishedTasks, stage)
            if (ret && typeof ret.then === 'function') {
              await ret
            }
          } catch (err) {
            console.error('[TaskScheduler] onAllComplete 抛错', err)
          }
        }
      }
      return
    }

    const task = claimedTask
    this.activeCount++
    this.onProgress(this.serializeProgress(task))

    try {
      if (typeof this._execute !== 'function') {
        throw new Error('TaskScheduler 未注入 execute 回调')
      }
      const result = await this._execute(task, {
        onStep: (p) => this.reportTaskProgress(task, p)
      })
      // ★ 终止检查：如果在 await 期间被 abort() 标记为 'aborted'，
      //   丢弃结果——不更新状态、不推进度、不减 activeCount、不继续循环
      if (task.status === 'aborted') return
      task.status = 'completed'
      task.progress = 100
      // ★ 状态机终态：completed → stage='done'（transition('merge','done') 或 ('request','done') 合法性不校验，因为这是终态强制）
      //   防御性：如果 stage 已经是 failed/skipped（异常路径），不覆盖
      if (task.stage !== 'failed' && task.stage !== 'skipped') {
        task.stage = 'done'
      }
      task.result = result
      task.finishedAt = Date.now()
      this.onProgress(this.serializeProgress(task))
    } catch (error) {
      // 终止后抛出的错误也丢弃
      if (task.status === 'aborted') return
      task.status = 'failed'
      task.progress = 0
      // ★ 状态机终态：failed → stage='failed' + error 填充原因
      task.stage = 'failed'
      task.error = error.message
      task.result = { error: error.message }
      task.finishedAt = Date.now()
      this.onProgress(this.serializeProgress(task))
    } finally {
      // aborted 任务不递减 activeCount（下次 start 会重置为 0）
      if (task.status !== 'aborted') {
        this.activeCount--
      }
    }

    // aborted 任务不继续循环
    if (task.status === 'aborted') return
    setImmediate(() => this.runNextTask())
  }
}
