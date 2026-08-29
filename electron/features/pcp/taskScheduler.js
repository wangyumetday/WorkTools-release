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

  clearAll() {
    const runningTasks = this.tasks.filter(t => t.status === 'running')
    this.tasks = runningTasks
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
   * @param {object} task   任务对象引用（scheduler.tasks 中的元素）
   * @param {number} progress  0-100
   */
  reportTaskProgress(task, progress) {
    if (!task || task.status !== 'running') return
    const next = Math.max(0, Math.min(100, progress))
    if (next <= task.progress) return
    task.progress = next
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
      task.result = result
      task.finishedAt = Date.now()
      this.onProgress(this.serializeProgress(task))
    } catch (error) {
      // 终止后抛出的错误也丢弃
      if (task.status === 'aborted') return
      task.status = 'failed'
      task.progress = 0
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
