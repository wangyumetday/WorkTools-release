// ============================================================
// ASS BatchRunner - 批量自动请求流水线
// 职责：
//   1. 保存已选文件的内容与提取出的查询队列
//   2. 按「并发数 + 请求间隔」自动持续请求（走 userHooks.extractQueries 拆出的每一条）
//   3. 每条请求完成后回调 userHooks.processQueryResult
//   4. 进度事件推送给渲染层（ass:batch:progress）
//
// 状态机：idle → running ⇄ paused → finished / stopped
//   - finished：队列全部跑完
//   - stopped：用户手动停止，或登录失效（LOGIN_EXPIRED）强制停止（剩余记为跳过）
//
// 反爬约定：默认并发 1 + 间隔 500ms，且并发上限 3、间隔下限 300ms，
//   避免高频请求触发携程风控（网页自测接口无正式 SLA）。
// ============================================================

import { extractQueries, processQueryResult } from './userHooks.js'

const MIN_INTERVAL_MS = 300
const MAX_CONCURRENCY = 3

export class AssBatchRunner {
  /**
   * @param {object} deps
   *   - getMainWindow: 主窗口获取器（进度推送）
   *   - queryClient:  AssQueryClient 实例（携程请求 + 对比价展开）
   *   - log:          错误日志回调（可选）
   */
  constructor({ getMainWindow, queryClient, log }) {
    this.getMainWindow = getMainWindow
    this.queryClient = queryClient
    this.log = log ?? console.warn
    this.fileContent = null // { filePath, fileName, ext, rows?, text? }
    this.runId = 0 // 批次号：防止上一批 worker 收尾回调覆盖新批次状态
    this.reset()
  }

  /** 重置运行态（idle：队列/计数/状态清空） */
  reset() {
    this.runId++
    this.queue = []
    this.status = 'idle' // idle | running | paused | finished | stopped
    this.total = 0
    this.nextIndex = 0
    this.done = 0
    this.success = 0
    this.requestFailed = 0
    this.processFailed = 0
    this.skipped = 0
    this.error = null
    this.concurrency = 1
    this.intervalMs = 500
    this.paused = false
    this.stopped = false
    this.workers = []
    this.sleepTimers = []
  }

  // ------------------------------------------------------------
  // 文件与队列
  // ------------------------------------------------------------

  /**
   * 设置文件内容并立即提取一次（用于界面预览条数）。
   * 提取失败时返回错误，不改变当前队列。
   */
  setSource(fileContent) {
    this.fileContent = fileContent
    const queries = this.tryExtract()
    if (queries.error) return queries
    this.queue = queries.queries
    return { ok: true, count: this.queue.length, fileName: fileContent?.fileName ?? '' }
  }

  /** 调用用户钩子提取查询队列，返回 { queries } 或 { error } */
  tryExtract() {
    try {
      const queries = extractQueries(this.fileContent)
      if (!Array.isArray(queries)) {
        return { error: 'extractQueries 必须返回数组' }
      }
      return { queries }
    } catch (err) {
      return { error: `文件解析失败: ${err?.message || err}` }
    }
  }

  getState() {
    return {
      status: this.status,
      fileName: this.fileContent?.fileName ?? '',
      total: this.total,
      done: this.done,
      success: this.success,
      requestFailed: this.requestFailed,
      processFailed: this.processFailed,
      skipped: this.skipped,
      error: this.error,
      concurrency: this.concurrency,
      intervalMs: this.intervalMs
    }
  }

  /**
   * 开始（或重新开始）：
   *   - 每次开始时重新提取文件内容（用户在界面上改过文件也能生效）
   *   - 处于 paused 时调用 = 继续；否则从头跑
   */
  start(options = {}) {
    // 暂停中 → 直接继续
    if (this.status === 'paused') {
      this.resume()
      return { ok: true }
    }

    this.stopSilently()
    this.reset()

    // 重新解析文件（保证与磁盘一致），队列为批处理的唯一来源
    const extracted = this.tryExtract()
    if (extracted.error) {
      this.error = extracted.error
      return { ok: false, error: extracted.error }
    }
    this.queue = extracted.queries
    this.total = this.queue.length
    if (this.total === 0) {
      this.error = '提取到 0 条查询请求，请检查 extractQueries 实现或文件内容'
      return { ok: false, error: this.error }
    }

    this.concurrency = Math.min(Math.max(1, options.concurrency ?? 1), MAX_CONCURRENCY)
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? 500)

    this.status = 'running'
    this.paused = false
    this.stopped = false

    // 起 N 个 worker，各自从共享指针取任务
    const myRunId = this.runId // start 前 reset() 已递增，捕获本批批次号
    for (let i = 0; i < this.concurrency; i++) {
      this.workers.push(this.workerLoop(i))
    }
    // worker 自管理退出；全部结束后统一收尾并推最终状态
    Promise.all(this.workers)
      .catch(() => {})
      .then(() => this.onAllWorkersFinish(myRunId))

    this.pushProgress()
    return { ok: true, total: this.total }
  }

  pause() {
    if (this.status !== 'running') return
    this.status = 'paused'
    this.paused = true
    this.pushProgress()
  }

  resume() {
    if (this.status !== 'paused') return
    this.status = 'running'
    this.paused = false
    this.pushProgress()
  }

  /** 用户手动停止：剩余任务记为跳过 */
  stop() {
    if (this.status !== 'running' && this.status !== 'paused') return
    this.stopSilently()
    this.status = 'stopped'
    this.skipped = this.total - this.done
    this.pushProgress()
  }

  /** 静默设置停止位（worker 会尽快退出），不改状态 */
  stopSilently() {
    this.stopped = true
    this.paused = false
    // 唤醒所有等待中的 worker 定时器，让其立刻检测停止位退出
    for (const t of this.sleepTimers) clearTimeout(t)
    this.sleepTimers = []
  }

  // ------------------------------------------------------------
  // Worker
  // ------------------------------------------------------------

  /**
   * 单个 worker：从共享指针取一条 → 等待暂停解除 → 请求 → 回调用户处理 → 间隔后取下一条
   */
  async workerLoop(workerNo) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.stopped) return

      // 暂停等待：轮询直到恢复或停止
      while (this.paused && !this.stopped) {
        await this.sleep(150)
      }
      if (this.stopped) return

      const index = this.nextIndex++
      if (index >= this.total) return
      const context = this.queue[index]

      // ----- 请求 -----
      let result
      try {
        result = await this.queryClient.run(context, 1)
      } catch (err) {
        result = { ok: false, code: 'UNKNOWN', error: err?.message || String(err) }
      }
      if (result.ok) {
        this.success++
      } else {
        this.requestFailed++
        // 登录失效：不发无意义的后续请求，强制停止流水线
        if (result.code === 'LOGIN_EXPIRED') {
          this.stopSilently()
          this.status = 'stopped'
          this.error = result.error || '登录已失效'
          this.skipped = this.total - this.done - 1
          this.markDone()
          continue // 循环内下一轮会因 stopped 退出
        }
      }

      // ----- 用户处理回调 -----
      try {
        await processQueryResult(context, result, {
          expand: (token) => this.queryClient.expand(context, token)
        })
      } catch (err) {
        this.processFailed++
        this.log('[ass] processQueryResult 异常:', err?.message || err)
      }

      this.markDone()
      if (!this.stopped) await this.sleep(this.intervalMs)
    }
  }

  markDone() {
    this.done++
    this.pushProgress()
  }

  /** 本批 worker 全部退出后的收尾（批号不符说明已开新批，不动状态） */
  onAllWorkersFinish(runId) {
    if (runId !== this.runId) return
    if (this.status === 'stopped') {
      this.pushProgress()
      return
    }
    this.status = 'finished'
    this.skipped = this.total - this.done
    this.pushProgress()
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      this.sleepTimers.push(t)
      // 防泄漏：定时器用后即时移除
      t && t.unref && t.unref()
    })
  }

  // ------------------------------------------------------------
  // 进度推送
  // ------------------------------------------------------------

  pushProgress() {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send('ass:batch:progress', this.getState())
    } catch {
      // 窗口销毁瞬间忽略
    }
  }
}