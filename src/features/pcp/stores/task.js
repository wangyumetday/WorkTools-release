// ============================================================
// PCP 渲染层 store - 任务/数据状态管理（阶段3 重构）
// 职责：
//   - 维护步骤器数据（a1/a2/a3 计数 + a1 前 100 行预览）
//   - 维护任务监控数据（tasks/isRunning/isPaused/currentStage/concurrency/activeCount）
//   - 维护 Pipeline 状态（mode/status/step）+ 闪烁引导（blinkTarget）
//   - 订阅主进程推送（onTaskProgress/onTaskAllComplete/onPipelineState/onPipelineGateFail）
//
// 阶段3 重构要点：
//   - 移除渲染层 autoChain 链式编排（步骤流收回主进程 Pipeline）
//   - 渲染层只发：pipelineStart / pipelineTriggerStep / pipelineSetMode / pipelinePause
//   - 收到 pipeline:gateFail 时设 blinkTarget，各组件据此闪烁引导用户补全
//   - handleAllComplete 不再自动衔接下一步（衔接由 Pipeline 在主进程完成）
// ============================================================

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/shared/api.js'
import message from '@/shared/message.js'

export const useTaskStore = defineStore('pcp-task', () => {
  // ==================== 步骤器数据 ====================
  const selectedFile = ref('')
  const a1Data = ref([])
  const a1Count = ref(0)
  const a2Count = ref(0)
  const a3Count = ref(0)

  // ==================== 任务监控数据 ====================
  const tasks = ref([])
  const isRunning = ref(false)
  const isPaused = ref(false)
  const currentStage = ref(null)
  const concurrency = ref(1)
  const activeCount = ref(0)

  const taskIndexMap = new Map()

  // ==================== Pipeline 状态（阶段3）====================
  // mode:   'auto' | 'dev'
  // status: 'idle' | 'running' | 'paused' | 'waiting_next' | 'done'
  // step:   'upload' | 'jxgj' | 'o_combo' | 'export'
  const pipelineState = ref({ mode: 'auto', status: 'idle', step: 'upload', lastGateFail: null })

  // ==================== 闪烁引导（阶段3）====================
  // blinkTarget: 'file'|'jxgj_config'|'jxgj_credential'|'o_config'|'o_credential' | null
  //   收到 pipeline:gateFail 时设为 missing[0]，各组件监听匹配自己的 key 启动抖动动画
  //   3.5s 后自动清空（避免用户没补全就一直闪；用户补全后重新点"开始"会再次触发）
  const blinkTarget = ref(null)
  let blinkTimer = null
  function triggerBlink(target) {
    blinkTarget.value = target
    if (blinkTimer) clearTimeout(blinkTimer)
    blinkTimer = setTimeout(() => { blinkTarget.value = null }, 1500)
  }

  // ==================== 下载相关状态 ====================
  const downloadDir = ref('')
  const downloadProgress = ref(null)
  const lastDownloadFilename = ref('')
  // 最近下载文件的完整路径（用于点击文件名时定位到文件，而非只打开文件夹）
  const lastDownloadPath = ref('')

  // ==================== 派生状态 ====================
  const completedCount = computed(() => tasks.value.filter(t => t.status === 'completed').length)
  const failedCount = computed(() => tasks.value.filter(t => t.status === 'failed').length)
  const pendingCount = computed(() => tasks.value.filter(t => t.status === 'pending' || t.status === 'paused').length)

  const a1Columns = computed(() => {
    if (a1Data.value.length === 0) return []
    const firstRow = a1Data.value[0]
    return Object.keys(firstRow)
      .filter(key => key !== 'id')
      .slice(0, 6)
      .map(key => ({ title: key, key }))
  })

  function getStageName(stage) {
    const map = { jxgj: '锦绣国际', o_combo: 'O平台组合' }
    return map[stage] || stage
  }

  // ==================== 索引维护辅助 ====================
  function rebuildTaskIndexMap() {
    taskIndexMap.clear()
    for (let i = 0; i < tasks.value.length; i++) {
      const t = tasks.value[i]
      if (t && t.id) taskIndexMap.set(t.id, i)
    }
  }

  function applyStatusTransition(oldStatus, newStatus) {
    const wasRunning = oldStatus === 'running'
    const nowRunning = newStatus === 'running'
    if (wasRunning && !nowRunning) activeCount.value--
    else if (!wasRunning && nowRunning) activeCount.value++
    isRunning.value = activeCount.value > 0
  }

  // ==================== 刷新方法 ====================
  async function refreshTasks() {
    const state = await api.pcp.taskGetState()
    tasks.value = state.tasks || []
    isRunning.value = state.isRunning
    isPaused.value = state.isPaused
    currentStage.value = state.currentStage
    concurrency.value = state.concurrency ?? 1
    activeCount.value = state.activeCount ?? 0
    rebuildTaskIndexMap()
    if (activeCount.value < 0 || activeCount.value > tasks.value.length) {
      activeCount.value = tasks.value.filter(t => t && t.status === 'running').length
      isRunning.value = activeCount.value > 0
    }
  }

  async function refreshDataCounts() {
    const [a1, a2, a3] = await Promise.all([
      api.pcp.fileGetA1(),
      api.pcp.fileGetA2(),
      api.pcp.fileGetA3()
    ])
    a1Count.value = a1.count
    if (a1.data && a1.data.length > 0) {
      a1Data.value = a1.data.slice(0, 100)
    }
    a2Count.value = a2.count
    a3Count.value = a3.count
  }

  async function refreshAll() {
    await Promise.all([refreshTasks(), refreshDataCounts()])
  }

  async function refreshPipelineState() {
    const s = await api.pcp.pipelineGetState()
    if (s) pipelineState.value = s
  }

  // ==================== 步骤1：上传 xlsx ====================
  async function handleUploadXlsx() {
    // 先重置 Pipeline：清空旧 a1/a2/a3 + 状态回到 idle/upload + 清空任务队列
    //   防止上一个流程的 a2/a3 残留导致 StepFlow 误判步骤为「已完成」
    await api.pcp.pipelineReset()

    const result = await api.pcp.fileUploadXlsx()
    if (result && result.success) {
      selectedFile.value = result.fileName
      a1Data.value = result.data
      a1Count.value = result.count
      // 刷新所有计数和状态（a2/a3 应为 0，pipelineState 应为 idle/upload）
      await refreshAll()
      await refreshPipelineState()
      message.success(`成功解析 ${result.count} 条数据`)
    } else if (result && !result.success) {
      message.error(result.error || '上传失败')
    }
  }

  // ==================== Pipeline 操作（阶段3）====================
  /**
   * 开始执行（TopToolbar "开始"按钮调用）
   *   auto 模式：门禁通过 → 跑到底（jxgj → o_combo → done）
   *   dev  模式：触发 jxgj（与 StepFlow 点 jxgj 步骤等价）；后续步骤靠 StepFlow triggerStep
   */
  async function handleStartExecution() {
    if (pipelineState.value.status === 'running') {
      message.warning('流程执行中，请勿重复操作')
      return
    }
    if (pipelineState.value.mode === 'dev') {
      await pipelineTriggerStep('jxgj')
    } else {
      const result = await api.pcp.pipelineStart()
      if (!result.success && result.message) {
        message.warning(result.message)
      }
      // 任务已入队（pending），立即拉取让 TaskMonitor 显示并开始进度动画
      // await refreshTasks()
    }
  }

  /** dev 模式：用户点 StepFlow 某步触发 */
  async function pipelineTriggerStep(step) {
    const result = await api.pcp.pipelineTriggerStep(step)
    if (!result.success && result.message) {
      message.warning(result.message)
    }
    // 任务已入队（pending），立即拉取让 TaskMonitor 显示并开始进度动画
    // await refreshTasks()
  }

  /** 切换 auto/dev 模式（Home 左下角 dev 按钮调用） */
  async function setMode(mode) {
    const result = await api.pcp.pipelineSetMode(mode)
    if (result?.success) {
      pipelineState.value = { ...pipelineState.value, mode: result.mode }
      message.success(`已切换为${mode === 'dev' ? 'Dev' : '自动'}模式`)
    }
  }

  /** 暂停流程（调 Pipeline.pause → taskManager.pause） */
  async function handlePause() {
    const result = await api.pcp.pipelinePause()
    if (result.success) {
      message.info(result.message || '已暂停')
    } else {
      message.warning(result.message)
    }
    await refreshTasks()
  }

  /** 终止流程（硬中断）：进度条冻在当前值，下次 start 从头跑 */
  async function handleAbort() {
    const result = await api.pcp.pipelineAbort()
    if (result.success) {
      message.warning('已终止')
    } else {
      message.info(result.message || '没有正在运行的流程')
    }
    // 刷新任务列表：显示 aborted 任务的冻结进度
    // await refreshTasks()
  }

  // ==================== 下载相关 ====================
  async function handleDownloadResult() {
    if (downloadProgress.value !== null) return
    if (!downloadDir.value) {
      message.warning('未设置下载目录，请先点击「选择下载目录」')
      return
    }
    downloadProgress.value = 0
    const result = await api.pcp.fileDownloadResult()
    if (result && result.success) {
      // 阶段4：每 O 平台一份 xlsx，files 为数组
      const files = Array.isArray(result.files) ? result.files : []
      lastDownloadFilename.value = files.map(f => f.filename).join(', ') || '已保存'
      // 记住第一个文件的完整路径，用于点击文件名时定位到文件
      lastDownloadPath.value = files[0]?.path || ''
      downloadProgress.value = 100
      const summary = files.map(f => `${f.platform}(${f.count}条)`).join('、')
      message.success(summary ? `已导出：${summary}` : '结果文件已保存')
      // 下载完成 = 本轮流程结束：重置 pipeline 到初始态 + 清空 a1/a2/a3，
      //   步骤流回到"可重新选文件"，dev 模式下步骤重新可点（避免一直停在 done 无法重新开始）
      await api.pcp.pipelineReset()
      await refreshAll()
      setTimeout(() => {
        if (downloadProgress.value === 100) downloadProgress.value = null
      }, 1500)
    } else if (result && result.canceled) {
      downloadProgress.value = null
      message.info('已取消下载')
    } else {
      downloadProgress.value = -1
      message.error(result?.error || '下载失败')
      setTimeout(() => {
        if (downloadProgress.value === -1) downloadProgress.value = null
      }, 1500)
    }
  }

  async function refreshDownloadDir() {
    const result = await api.pcp.fileGetDownloadDir()
    if (result && result.dir) {
      downloadDir.value = result.dir
    }
  }

  async function handleSelectDownloadDir() {
    const result = await api.pcp.fileSelectDownloadDir()
    if (result && result.success) {
      downloadDir.value = result.dir
      message.success('下载目录已设置')
    } else if (result && result.canceled) {
      // 用户取消
    } else {
      message.error(result?.error || '设置失败')
    }
  }

  // 点击「最近保存：xxx」→ 定位到该文件（打开所在文件夹并选中）
  //   传 lastDownloadPath；没记到路径时回退为只打开下载目录
  async function handleOpenDownloadDir() {
    const result = await api.pcp.fileOpenDownloadDir(lastDownloadPath.value || undefined)
    if (!result || !result.success) {
      message.error(result?.error || '打开失败')
    }
  }

  // ==================== 任务监控器操作 ====================
  async function handleDeleteTask(taskId) {
    await api.pcp.taskDelete(taskId)
    await refreshTasks()
  }

  async function handleClearTasks() {
    await api.pcp.taskClear()
    await refreshTasks()
    message.info('已清空任务队列')
  }

  async function handleSetConcurrency(value) {
    const result = await api.pcp.taskSetConcurrency(value)
    if (result && result.success) {
      concurrency.value = result.concurrency
      if (isRunning.value) {
        activeCount.value = result.concurrency
      }
    }
  }

  // ==================== 任务事件回调 ====================
  function handleTaskProgress(input) {
    if (!input) return
    const patches = Array.isArray(input) ? input : [input]
    if (patches.length === 0) return

    const list = tasks.value
    for (const patch of patches) {
      if (!patch || !patch.id) continue

      const idx = taskIndexMap.get(patch.id)
      let targetIndex = idx
      if (targetIndex === undefined) {
        const fallback = list.findIndex(t => t && t.id === patch.id)
        if (fallback === -1) continue
        targetIndex = fallback
        taskIndexMap.set(patch.id, fallback)
      }

      const oldTask = list[targetIndex]
      if (!oldTask) continue
      const oldStatus = oldTask.status

      Object.assign(oldTask, patch)

      if (oldStatus !== patch.status) {
        applyStatusTransition(oldStatus, patch.status)
      }
    }

    if (activeCount.value < 0) {
      activeCount.value = list.filter(t => t && t.status === 'running').length
      isRunning.value = activeCount.value > 0
    }
  }

  // 主进程推送完整任务列表 state（runStage addBatch 后 / stage 切换时主动推）
  //   修复"任务列表卡住直到 allComplete 才整体刷新"——拆分后 o 阶段每平台任务实时可见、进度条实时动
  //   入队动画：新任务 stagger 增量追加（每 25ms 一条），让用户看到一条条进入队列而非瞬间全显
  let staggerTimer = null
  function handleTaskState(state) {
    if (!state) return
    // 新 state 到来，取消未完成的 stagger，以最新为准
    if (staggerTimer) { clearTimeout(staggerTimer); staggerTimer = null }

    isRunning.value = state.isRunning
    isPaused.value = state.isPaused
    currentStage.value = state.currentStage
    concurrency.value = state.concurrency ?? 1
    activeCount.value = state.activeCount ?? 0

    const incoming = state.tasks || []
    const incomingIds = new Set(incoming.map(t => t && t.id).filter(Boolean))
    const currentIds = new Set(tasks.value.map(t => t && t.id).filter(Boolean))

    // 1. 移除不在 incoming 的旧任务（阶段衔接时清掉上一阶段已完成任务）
    tasks.value = tasks.value.filter(t => incomingIds.has(t.id))
    // 2. 已存在的任务 in-place 更新（保留响应式对象引用，不触发列表 reflow）
    const incomingMap = new Map(incoming.map(t => [t.id, t]))
    for (const t of tasks.value) {
      const fresh = incomingMap.get(t.id)
      if (fresh) Object.assign(t, fresh)
    }
    rebuildTaskIndexMap()

    // 3. 新任务（addBatch 后入队）→ stagger 增量追加
    const newTasks = incoming.filter(t => t && !currentIds.has(t.id))
    if (newTasks.length === 0) return
    // 大批量直接一次性追加，避免 stagger 过长卡住界面
    if (newTasks.length > 40) {
      tasks.value.push(...newTasks)
      rebuildTaskIndexMap()
      return
    }
    // 小批量 stagger：每 25ms 追加一条，给"逐条入队"视觉
    let i = 0
    const step = () => {
      if (i >= newTasks.length) { staggerTimer = null; return }
      tasks.value.push(newTasks[i])
      i++
      rebuildTaskIndexMap()
      staggerTimer = setTimeout(step, 25)
    }
    staggerTimer = setTimeout(step, 25)
  }

  // Pipeline 状态变化推送
  function handlePipelineState(state) {
    if (!state) return
    pipelineState.value = state
    // 同步 currentStage（兼容老 UI 逻辑：currentStage 反映 taskManager 当前 stage）
    if (state.status === 'running' && (state.step === 'jxgj' || state.step === 'o_combo')) {
      currentStage.value = state.step
    } else {
      currentStage.value = null
    }
  }

  // Pipeline 门禁失败推送：取 missing[0] 触发对应元素闪烁引导
  function handlePipelineGateFail(fail) {
    if (!fail) return
    if (fail.message) message.warning(fail.message)
    if (!Array.isArray(fail.missing) || fail.missing.length === 0) return

    const firstMissing = fail.missing[0]
    const msgMap = {
      file: '请先选择 Excel 文件',
      jxgj_config: '锦绣国际配置未启用，请在「平台配置」里启用',
      jxgj_credential: '锦绣国际未选中账号，请在「账号管理」里选中',
      o_config: '至少需要启用一个 O 平台配置（携程OTA/O2/O3）',
      o_credential: '已启用的 O 平台未选中账号，请在「账号管理」里选中'
    }
    message.warning(msgMap[firstMissing] || '前置条件未满足')
    triggerBlink(firstMissing)
  }

  // 整批完成（Pipeline 推送，含 stage）：刷新数据计数 + 提示
  //   注：不再自动衔接下一步，衔接由 Pipeline 在主进程完成
  //   results = 当前 stage 全部任务（包含失败 → 要显示成功数需按 status==='completed' 过滤）
  async function handleAllComplete(data) {
    const { results, stage } = data
    const total = Array.isArray(results) ? results.length : 0
    const completed = Array.isArray(results)
      ? results.filter(t => t && t.status === 'completed').length
      : 0
    const failed = total - completed
    const stageName = getStageName(stage)
    if (failed > 0) {
      message.warning(
        `${stageName}阶段结束：共 ${total} 任务 · 成功 ${completed} · 失败 ${failed}（失败详情见任务面板）`
      )
    } else {
      message.success(`${stageName}阶段完成：${completed} 任务全部成功`)
    }
    currentStage.value = null
    await refreshTasks()
    await refreshDataCounts()
    await refreshPipelineState()
  }

  function handleFileDownloadProgress(data) {
    if (!data || typeof data.progress !== 'number') return
    const { progress } = data
    downloadProgress.value = progress
    if (progress === 100 || progress === -1) {
      const target = progress
      setTimeout(() => {
        if (downloadProgress.value === target) downloadProgress.value = null
      }, 1500)
    }
  }

  // ==================== 初始化 ====================
  let listenersRegistered = false
  function ensureListeners() {
    if (listenersRegistered) return
    try {
      api.pcp.onTaskProgress(handleTaskProgress)
      api.pcp.onTaskState(handleTaskState)
      api.pcp.onTaskAllComplete(handleAllComplete)
      api.pcp.onFileDownloadProgress(handleFileDownloadProgress)
      api.pcp.onPipelineState(handlePipelineState)
      api.pcp.onPipelineGateFail(handlePipelineGateFail)
      listenersRegistered = true
    } catch (e) {
      console.warn('[taskStore] 注册事件监听器失败', e)
    }
  }

  async function init() {
    ensureListeners()
    await refreshAll()
    await refreshDownloadDir()
    await refreshPipelineState()
  }

  return {
    // state
    selectedFile, a1Data, a1Count, a2Count, a3Count,
    tasks, isRunning, isPaused, currentStage,
    concurrency, activeCount,
    pipelineState, blinkTarget,
    downloadDir, downloadProgress, lastDownloadFilename, lastDownloadPath,
    // getters
    completedCount, failedCount, pendingCount, a1Columns,
    // actions
    getStageName,
    refreshTasks, refreshDataCounts, refreshAll, refreshPipelineState,
    handleUploadXlsx, handleDownloadResult,
    handleSelectDownloadDir, handleOpenDownloadDir, refreshDownloadDir,
    handleDeleteTask, handleClearTasks, handlePause, handleAbort, handleSetConcurrency,
    handleStartExecution, pipelineTriggerStep, setMode,
    init
  }
})
