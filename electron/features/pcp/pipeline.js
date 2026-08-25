// ============================================================
// PCP Pipeline - 步骤流编排器（阶段3 核心）
// 职责：步骤流的"单一权威"编排器，收回主进程，移除渲染层 autoChain
//
// 状态机：
//   status: 'idle' | 'running' | 'paused' | 'waiting_next' | 'done'
//     - idle          空闲，未开始
//     - running       某个 stage 正在跑（jxgj 或 o_combo）
//     - paused        用户暂停（taskManager.pause）
//     - waiting_next  dev 模式：某 stage 完成，等用户点下一步
//     - done          o_combo 完成，等用户手动下载
//
// mode: 'auto' | 'dev'
//   - auto  门禁通过后跑到底（jxgj → o_combo → done）
//   - dev   每个 stage 完成后停在 waiting_next，等用户点 StepFlow 触发下一步
//
// step: 'upload' | 'jxgj' | 'o_combo' | 'export'
//   upload/export 始终手动（涉及 dialog），Pipeline 只跟踪状态：
//     upload 完成 = a1.count > 0
//     export 可执行 = a3.count > 0
//
// 依赖：
//   - taskManager:      注入，调 addBatchByStage/start/pause
//   - fileManager:      注入，stage 完成时 saveStageResults + checkGate 时查 a1/a3
//   - configManager:    注入，checkGate 时查 jxgj/o 启用状态
//   - credentialManager:注入，checkGate 时查 jxgj/o 账号
//   - mainWindow:       注入，推 IPC 事件
//   - userDataPath:     注入，持久化 mode
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

const PIPELINE_STATE_FILE = 'pipelineState.json'

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

    // 内部状态
    this.mode = this.loadMode() // 'auto' | 'dev'
    this.status = 'idle'        // 'idle'|'running'|'paused'|'waiting_next'|'done'
    this.step = 'upload'        // 当前应执行的下一步
    this.lastGateFail = null    // 上次门禁失败信息 { missing: [...] }

    // 接管 taskManager 的 onAllComplete：stage 完成后 saveStageResults + 推 IPC + 决定下一步
    if (this.taskManager?.scheduler) {
      this.taskManager.scheduler.onAllComplete = (results, stage) => this.handleStageComplete(results, stage)
    }
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

  // ========== 对外 API ==========

  /**
   * 启动流程（auto 模式入口）
   *   门禁通过 → runStage('jxgj') → 完成后自动 runStage('o_combo') → done
   *   门禁失败 → 推 pcp:pipeline:gateFail，渲染层闪烁引导
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
    this.status = 'running'
    this.step = 'jxgj'
    this.emitState()
    await this.runStage('jxgj')
    return { success: true }
  }

  /**
   * dev 模式：用户点 StepFlow 触发某一步
   * @param {string} step  'jxgj' | 'o_combo'
   */
  async triggerStep(step) {
    if (this.status === 'running') return { success: false, message: '流程执行中，请勿重复操作' }
    if (step !== 'jxgj' && step !== 'o_combo') {
      return { success: false, message: '未知的步骤' }
    }

    // 首次进入或门禁曾失败：重新 checkGate
    const gate = this.checkGate()
    if (!gate.success) {
      this.lastGateFail = gate
      this.emit('pcp:pipeline:gateFail', gate)
      return gate
    }

    this.lastGateFail = null
    this.status = 'running'
    this.step = step
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

  /**
   * 终止（硬中断）：立即打断当前流程
   *   - taskManager.abort() → scheduler 标记 running 任务为 'aborted'，
   *     isRunning=false → 在途 HTTP 回来后被 runNextTask 丢弃，进度条冻在当前值
   *   - 状态回到 idle/upload → 下次 start() 不被挡，从头跑（clearAll 清旧任务）
   *   - 推送 pcp:task:state 让前端 TaskMonitor 刷新任务状态（显示 aborted）
   */
  abort() {
    if (this.status !== 'running') return { success: false, message: '没有正在运行的流程' }
    this.taskManager?.abort()
    this.status = 'idle'
    this.step = 'upload'
    this.lastGateFail = null
    // 推送任务状态：前端看到 aborted 任务的冻结进度
    this.emit('pcp:task:state', this.taskManager.getState())
    this.emitState()
    return { success: true }
  }

  /**
   * 重置整个流程到初始态（idle / upload）
   *   - 清空 pipeline 内部状态：status='idle', step='upload', lastGateFail=null
   *   - 清空任务队列（taskManager.clearAll → scheduler.tasks = []）
   *   - 清空 a1/a2/a3 数据（fileManager.clearAll → 内存+磁盘）
   *   - 推送状态让渲染层 StepFlow 回到初始（可重新选文件开始）
   *
   * 时机：下载完成后由渲染层调 pcp:pipeline:reset
   *   （用户拿到 xlsx 后，这一轮流程结束，把"完成态"清掉，便于下一轮）
   */
  reset() {
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

  getState() {
    return {
      mode: this.mode,
      status: this.status,
      step: this.step,
      lastGateFail: this.lastGateFail
    }
  }

  // ========== 内部：门禁检查 ==========
  /**
   * 前置门禁：选文件 → JXGJ 配置启用 → 至少一个 O 配置启用
   * 返回 { success, missing: ['file'|'jxgj_config'|'jxgj_credential'|'o_config'|'o_credential'] }
   *   注：门禁只查"配置启用 + 账号选中"，渲染层据此闪烁引导用户去对应 tab
   */
  checkGate() {
    const missing = []

    // 1. 选文件
    const a1Count = this.fileManager?.getA1()?.count || 0
    if (a1Count === 0) missing.push('file')

    // 2. JXGJ 配置启用 + 账号选中
    if (!this.configManager?.isEnabled('jxgj')) {
      missing.push('jxgj_config')
    } else if (!this.credentialManager?.getSelected('jxgj')) {
      missing.push('jxgj_credential')
    }

    // 3. 至少一个 O 平台启用 + 账号选中
    const oPlatforms = ['trip', 'o2', 'o3']
    const enabledO = oPlatforms.filter(p => this.configManager?.isEnabled(p))
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
   * 执行某 stage：addBatchByStage + taskStart
   * @param {string} stage  'jxgj' | 'o_combo'
   */
  async runStage(stage) {
    const addResult = await this._invokeAddBatchByStage(stage)
    if (!addResult.success) {
      this.status = 'idle'
      this.emitState()
      return
    }
    // ★ 任务已入队（pending）：立即推送完整 task state，让渲染层 TaskMonitor 显示新任务
    //   并重建 id 索引。后续进度 patch 才能匹配到 id，进度条才会动（否则 patch 被丢弃 → 卡住）
    //   场景：jxgj 入队、o_combo 拆分后的 trip/o2/o3 入队；尤其 auto 模式 jxgj→o_combo 衔接时
    //   若不推，渲染层 tasks.value 仍是旧 id，新阶段进度 patch 全被丢，直到 allComplete 才整体刷新
    this.emit('pcp:task:state', this.taskManager.getState())
    const startResult = await this.taskManager.start(stage)
    if (!startResult.success) {
      this.status = 'idle'
      this.emitState()
      this.emit('pcp:pipeline:gateFail', { success: false, missing: [], message: startResult.message })
    }
  }

  _invokeAddBatchByStage(stage) {
    // 通过 taskManager 间接调 controller 的 addBatchByStage 逻辑
    // controller.js 里 addBatchByStage 是 IPC handler，逻辑封装在 controller 内
    // 这里复用 fileManager + taskManager 直接实现，避免绕 IPC
    const stageMap = {
      jxgj: { source: () => this.fileManager.getA1().data, type: 'jxgj' },
      o_combo: { source: () => this.fileManager.getA2().data, type: 'o_combo' }
    }
    const config = stageMap[stage]
    if (!config) return Promise.resolve({ success: false, message: '未知的阶段' })

    const sourceData = config.source()
    if (sourceData.length === 0) {
      return Promise.resolve({ success: false, message: '数据源为空，请先完成上一阶段' })
    }

    // o_combo 阶段账号前置检查（与 controller addBatchByStage 一致）
    if (stage === 'o_combo' && this.credentialManager) {
      const hasAnyO = ['trip', 'o2', 'o3'].some(p => this.credentialManager.getSelected(p))
      if (!hasAnyO) {
        return Promise.resolve({ success: false, message: '未选择平台，请先在「账号管理」里为至少一个 O 平台选中账号' })
      }
    }

    this.taskManager.clearAll()

    let tasks
    if (stage === 'o_combo') {
      // ★ O 平台任务拆分：每个启用的 O 平台（trip/o2/o3）各自独立成任务
      //   原由 runCombo 内部并行三平台、进度聚合 → 渲染层看不到单平台进度（卡住）
      //   现按 task.type=单平台 直接由 runByType → run 执行，各平台独立跑、独立进度
      //   过滤条件：配置启用 && 账号选中（两者都满足才生成任务，避免无效任务）
      const enabledO = ['trip', 'o2', 'o3'].filter(p =>
        this.configManager?.isEnabled(p) && this.credentialManager?.getSelected(p))
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
   * stage 完成：saveStageResults + 推 IPC + 根据 mode 决定下一步
   * @param {Array} results  完成的任务结果
   * @param {string} stage   'jxgj' | 'o_combo'
   */
  async handleStageComplete(results, stage) {
    // 1. 落盘（保持原 main.js 行为）
    if (this.fileManager) this.fileManager.saveStageResults(stage, results)

    // 2. 推 pcp:task:allComplete 给渲染层（渲染层据此刷新 a1/a2/a3 计数）
    this.emit('pcp:task:allComplete', { results, stage })

    // 3. 决定下一步
    if (stage === 'jxgj') {
      if (this.mode === 'auto') {
        // 自动衔接 O 平台
        this.step = 'o_combo'
        this.status = 'running'
        this.emitState()
        await new Promise(r => setTimeout(r, 300)) // 给 UI 刷新一下
        await this.runStage('o_combo')
      } else {
        // dev 模式：停在 waiting_next，等用户点 StepFlow
        this.step = 'o_combo'
        this.status = 'waiting_next'
        this.emitState()
      }
    } else if (stage === 'o_combo') {
      // O 完成：流程结束，等用户手动下载
      this.step = 'export'
      this.status = 'done'
      this.emitState()
    }
  }

  // ========== 工具：事件推送 ==========
  emit(channel, payload) {
    this.getMainWindow()?.webContents.send(channel, payload)
  }

  emitState() {
    this.emit('pcp:pipeline:state', this.getState())
  }
}
