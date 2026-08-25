// ============================================================
// PCP 渲染层 store - 任务/数据状态管理
// 职责：
//   - 维护步骤器数据（a1/a2/a3 计数 + a1 前 100 行预览）
//   - 维护任务监控数据（tasks/isRunning/isPaused/currentStage/concurrency/activeCount）
//   - 提供派生 getter（completedCount/failedCount/pendingCount/a1Columns）
//   - 包装 IPC 调用为高层 action（handleUploadXlsx/handleAddJxgjTasks/...）
//   - 订阅主进程推送（onTaskProgress/onTaskAllComplete）并实时更新本地状态
//
// 与主进程的交互：所有 IPC 通过 @/shared/api.js 调用，方法名前缀 pcp.
// ============================================================

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/shared/api.js'
import message from '@/shared/message.js'

export const useTaskStore = defineStore('pcp-task', () => {
  // ==================== 步骤器数据 ====================
  const selectedFile = ref('')//选择的文件名
  const a1Data = ref([])
  const a1Count = ref(0)
  const a2Count = ref(0)
  const a3Count = ref(0)

  // ==================== 任务监控数据 ====================
  const tasks = ref([])
  const isRunning = ref(false)
  const isPaused = ref(false)
  const currentStage = ref(null)
  // 并发执行：concurrency 同时执行的最大任务数；activeCount 当前正在执行的任务数
  const concurrency = ref(1)
  const activeCount = ref(0)

  // ★ 任务 id → 数组 index 的 Map 缓存（O(1) 查找，代替每次 findIndex O(N)）
  //   重建时机：refreshTasks 时全量重建；handleTaskProgress / handleDeleteTask 增量维护
  const taskIndexMap = new Map()

  // =============== 索引维护辅助 ===============
  function rebuildTaskIndexMap() {
    taskIndexMap.clear()
    for (let i = 0; i < tasks.value.length; i++) {
      const t = tasks.value[i]
      if (t && t.id) taskIndexMap.set(t.id, i)
    }
  }

  // 把"旧 status → 新 status"迁移映射为 activeCount 增量，避免 O(N) 扫数组
  function applyStatusTransition(oldStatus, newStatus) {
    const wasRunning = oldStatus === 'running'
    const nowRunning = newStatus === 'running'
    if (wasRunning && !nowRunning) activeCount.value--
    else if (!wasRunning && nowRunning) activeCount.value++
    // isRunning 用 activeCount 推导：有任务在跑就是 running 状态
    isRunning.value = activeCount.value > 0
  }

  // ==================== 下载相关状态 ====================
  // downloadDir：用户选择的下载目录（onMounted 时拉取，主进程持久化）
  const downloadDir = ref('')
  // downloadProgress：下载进度状态
  //   null    = 空闲（按钮可点）
  //   0~99    = 下载中（按钮 disabled + 背景按百分比填充颜色）
  //   100     = 完成（按钮短暂显示"已下载"，1.5s 后回 null）
  //   -1      = 出错（按钮短暂显示"失败"，1.5s 后回 null）
  const downloadProgress = ref(null)
  // lastDownloadFilename：最近一次下载的最终文件名（可能带序号，如 result (1).xlsx）
  //   供 UI 提示"已保存：result (1).xlsx"，让用户立刻知道是否同名加序号
  const lastDownloadFilename = ref('')

  // ==================== 派生状态 ====================
  // 已完成任务数
  const completedCount = computed(() => tasks.value.filter(t => t.status === 'completed').length)
  // 失败任务数
  const failedCount = computed(() => tasks.value.filter(t => t.status === 'failed').length)
  // 待执行任务数（含 pending + paused）
  const pendingCount = computed(() => tasks.value.filter(t => t.status === 'pending' || t.status === 'paused').length)

  // a1 数据表格的列定义（取第一行的 key，去掉 id 列，最多展示 6 列）
  const a1Columns = computed(() => {
    if (a1Data.value.length === 0) return []
    const firstRow = a1Data.value[0]
    return Object.keys(firstRow)
      .filter(key => key !== 'id')
      .slice(0, 6)
      .map(key => ({ title: key, key }))
  })

  // ==================== 阶段名映射 ====================
  function getStageName(stage) {
    const map = {
      jxgj: '锦绣国际',
      o_combo: 'O平台组合'
    }
    return map[stage] || stage
  }

  // ==================== 刷新方法 ====================
  // 拉取任务队列状态并同步本地
  async function refreshTasks() {
    const state = await api.pcp.taskGetState()
    // 全量替换 tasks（getState 返回完整任务对象，含 data/result）
    tasks.value = state.tasks || []
    isRunning.value = state.isRunning
    isPaused.value = state.isPaused
    currentStage.value = state.currentStage
    // 同步并发状态
    concurrency.value = state.concurrency ?? 1
    activeCount.value = state.activeCount ?? 0
    // ★ 全量任务替换后，重建 id→index 索引
    rebuildTaskIndexMap()
    // 兜底：如果主进程传的 activeCount 不准，就基于本地 tasks 真实 running 状态扫一次
    //   （仅在 refreshTasks 时扫一次 O(N)，代价可接受）
    if (activeCount.value < 0 || activeCount.value > tasks.value.length) {
      activeCount.value = tasks.value.filter(t => t && t.status === 'running').length
      isRunning.value = activeCount.value > 0
    }
  }

  // 拉取 a1/a2/a3 数据计数（含 a1 前 100 行预览）
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

  // 刷新全部（任务 + 数据计数）
  async function refreshAll() {
    await Promise.all([refreshTasks(), refreshDataCounts()])
  }

  // ==================== 步骤器操作 ====================
  // 步骤1：上传 xlsx
  async function handleUploadXlsx() {
    const result = await api.pcp.fileUploadXlsx()
    if (result && result.success) {
      selectedFile.value = result.fileName
      a1Data.value = result.data
      a1Count.value = result.count
      message.success(`成功解析 ${result.count} 条数据`)
    } else if (result && !result.success) {
      message.error(result.error || '上传失败')
    }
  }

  // 步骤2：生成锦绣国际任务并启动
  //   - 正常走"生成任务 + taskStart('jxgj')"流程
  async function handleAddJxgjTasks() {
    const result = await api.pcp.taskAddBatchByStage('jxgj')
    if (result.success) {
      message.success(`已添加 ${result.count} 个锦绣国际任务`)
      await refreshTasks()
      const startResult = await api.pcp.taskStart('jxgj')
      if (startResult.success) {
        currentStage.value = 'jxgj'
        message.success('锦绣国际任务开始执行')
      } else {
        // 启动失败（如账号未配置）：打断自动链路，避免一直挂"autoChain"状态
        autoChain.value = false
        message.warning(startResult.message || '锦绣国际任务启动失败')
      }
    } else {
      autoChain.value = false
      message.warning(result.message)
    }
  }

  // 步骤3：生成 O 平台组合任务并启动
  async function handleAddOTasks() {
    const result = await api.pcp.taskAddBatchByStage('o_combo')
    if (result.success) {
      message.success(`已添加 ${result.count} 个O平台组合任务`)
      await refreshTasks()
      const startResult = await api.pcp.taskStart('o_combo')
      if (startResult.success) {
        currentStage.value = 'o_combo'
        message.success('O平台任务开始执行')
      } else {
        autoChain.value = false
        message.warning(startResult.message || 'O平台任务启动失败')
      }
    } else {
      autoChain.value = false
      message.warning(result.message)
    }
  }

  // 步骤4：下载结果 Excel
  //   - 触发主进程 exportResult，主进程通过 onFileDownloadProgress 推送进度
  //   - 这里只设初始状态 + 处理最终结果，进度由订阅事件驱动
  async function handleDownloadResult() {
    if (downloadProgress.value !== null) return // 防止用户连点
    if (!downloadDir.value) {
      message.warning('未设置下载目录，请先点击「选择下载目录」')
      return
    }
    downloadProgress.value = 0 // 标记开始下载（按钮变 disabled）
    const result = await api.pcp.fileDownloadResult()
    if (result && result.success) {
      // 成功：保存最终文件名（可能带序号），停留显示"已下载"，1.5s 后恢复
      lastDownloadFilename.value = result.filename || ''
      downloadProgress.value = 100
      message.success(`结果文件已保存：${result.filename}`)
      setTimeout(() => {
        // 只有还是完成状态时才恢复，避免覆盖新一轮下载
        if (downloadProgress.value === 100) downloadProgress.value = null
      }, 1500)
    } else if (result && result.canceled) {
      downloadProgress.value = null
      message.info('已取消下载')
    } else {
      // 失败：停留显示"失败"，1.5s 后恢复
      downloadProgress.value = -1
      message.error(result?.error || '下载失败')
      setTimeout(() => {
        if (downloadProgress.value === -1) downloadProgress.value = null
      }, 1500)
    }
  }

  // ==================== 下载目录管理 ====================
  // 拉取当前下载目录（onMounted 时调用，让 UI 显示主进程持久化的目录）
  async function refreshDownloadDir() {
    const result = await api.pcp.fileGetDownloadDir()
    if (result && result.dir) {
      downloadDir.value = result.dir
    }
  }

  // 选择下载目录：调主进程弹文件夹选择框
  async function handleSelectDownloadDir() {
    const result = await api.pcp.fileSelectDownloadDir()
    if (result && result.success) {
      downloadDir.value = result.dir
      message.success('下载目录已设置')
    } else if (result && result.canceled) {
      // 用户取消选择，不弹提示
    } else {
      message.error(result?.error || '设置失败')
    }
  }

  // 打开下载目录：在系统文件管理器中打开
  async function handleOpenDownloadDir() {
    const result = await api.pcp.fileOpenDownloadDir()
    if (!result || !result.success) {
      message.error(result?.error || '打开失败')
    }
  }

  // ==================== 自动阶段串联（一键开始 → 步骤2 → 步骤3 → 停止，等待手动下载） ====================
  // 工作原理：
  //   用户点「开始」后，TopToolbar.handleStartExecution 手动调 handleAddJxgjTasks 启动步骤2
  //   步骤2 任务全完成 → handleAllComplete 回调里检测 stage='jxgj' → 自动调 handleAddOTasks 启动步骤3
  //   步骤3 任务全完成 → handleAllComplete 检测 stage='o_combo' → 提示完成，等待用户手动点「下载」
  //
  // autoChain 开关：handleStartExecution 开始时置 true，走完 O 完成后置 false（或用户中途暂停/清空置 false）
  //   避免用户手动单独点步骤2按钮时，完成后意外再自动跑步骤3
  const autoChain = ref(false)

  // 工具：判断当前 JXGJ 阶段是否有失败任务（可选：O 阶段前弹提醒，用户需求没要求必须全部成功，这里静默继续跑 O）
  async function startNextFromJxgjDone() {
    message.info('锦绣国际阶段已完成，自动进入 O 平台阶段...')
    // 等待 300ms，给 UI 刷新一下"阶段完成"提示，再进下一阶段
    await new Promise(r => setTimeout(r, 300))
    await handleAddOTasks()
  }

  function finishAutoChain() {
    autoChain.value = false
    message.success('全部阶段完成！请点击「下载政策文件」按钮导出结果。')
  }

  // 订阅事件处理：主进程推送的下载进度
  //   - 0~99：下载中，按钮 disabled + 背景按百分比填充颜色
  //   - 100：完成（与 handleDownloadResult 的 100 设置同步确保）
  //   - -1：出错
  function handleFileDownloadProgress(data) {
    if (!data || typeof data.progress !== 'number') return
    const { progress } = data
    downloadProgress.value = progress
    if (progress === 100 || progress === -1) {
      // 完成/出错后停留显示，1.5s 后恢复
      // 注：handleDownloadResult 里也有相同 setTimeout，这里作为兜底
      //   （如果用户从其他入口触发下载，主进程推送进度也能恢复按钮）
      const target = progress
      setTimeout(() => {
        if (downloadProgress.value === target) downloadProgress.value = null
      }, 1500)
    }
  }

  // ==================== 任务监控器操作 ====================
  // 删除单个任务（运行中的不允许删）
  async function handleDeleteTask(taskId) {
    await api.pcp.taskDelete(taskId)
    // 删除后刷新（主进程 tasks 顺序变了，整体刷新最稳，顺便重建索引）
    await refreshTasks()
  }

  // 清空任务队列（保留运行中的）——中断自动链路
  async function handleClearTasks() {
    await api.pcp.taskClear()
    await refreshTasks()
    autoChain.value = false
    message.info('已清空任务队列')
  }

  // 启动任务队列（按当前 stage）——一般只有用户手动单独恢复暂停的某阶段才会调用
  // 一键开始不走这里，走 startAutoChain
  async function handleStart() {
    const result = await api.pcp.taskStart(currentStage.value)
    if (result.success) {
      message.success('任务开始执行')
    } else {
      message.warning(result.message)
    }
    await refreshTasks()
  }

  // 请求暂停（正在执行的任务让它跑完）——暂停后取消自动链路（用户恢复时再手动点即可）
  async function handlePause() {
    const result = await api.pcp.taskPause()
    if (result.success) {
      message.info(result.message)
      autoChain.value = false
    } else {
      message.warning(result.message)
    }
    await refreshTasks()
  }

  // 设置并发数（运行时也可调，主进程会立刻唤醒额外 worker）
  async function handleSetConcurrency(value) {
    const result = await api.pcp.taskSetConcurrency(value)
    if (result && result.success) {
      concurrency.value = result.concurrency
      if (isRunning.value) {
        // 乐观更新，下一轮 progress 推送会修正为真实 activeCount
        activeCount.value = result.concurrency
      }
    }
  }

  // ==================== 任务事件回调（store 内部处理，保证状态一致） ====================
  /**
   * 处理进度推送（兼容单条或合批数组）
   * 优化点：
   *   1. O(1) 索引查找（Map 代替 findIndex）—— 2000 条任务从 O(N) 降到 O(1)
   *   2. Object.assign 局部 merge —— 保留 getState 里带的 data/result 等完整字段（因为 onProgress 精简推送不含这些）
   *   3. status 增量迁移 activeCount/isRunning —— 不再每次 some/filter O(N) 扫数组
   *   4. 支持合批数组 —— 16ms 窗口内一次 flush 带 N 条，一次性处理完
   */
  function handleTaskProgress(input) {
    if (!input) return
    // 兼容单对象 or 数组（主进程合批后传的是数组）
    const patches = Array.isArray(input) ? input : [input]
    if (patches.length === 0) return

    const list = tasks.value
    for (const patch of patches) {
      if (!patch || !patch.id) continue

      const idx = taskIndexMap.get(patch.id)
      // 不在索引里：可能是刚启动还没 refreshTasks（onProgress 先到了），尝试 findIndex 兜底后回写索引
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

      // ★ 局部 merge：只覆盖 onProgress 推送来的字段（id/type/status/progress/startedAt/finishedAt/...）
      //   保留原任务中的 data、result 等完整字段（serializeProgress 推送不带它们）
      Object.assign(oldTask, patch)

      // 处理 status 迁移 → activeCount 增量维护
      if (oldStatus !== patch.status) {
        applyStatusTransition(oldStatus, patch.status)
      }
    }

    // 防御性兜底：如果 activeCount 算出负数或异常大（理论不会有，除非状态迁移漏了边界），
    // 就扫一次 tasks 重置一次，避免 UI 显示错
    if (activeCount.value < 0) {
      activeCount.value = list.filter(t => t && t.status === 'running').length
      isRunning.value = activeCount.value > 0
    }
  }

  // 处理整批完成推送：
  //   1. 弹阶段完成提示 + 刷新本地状态
  //   2. 自动链路模式下（autoChain=true）：
  //        - JXGJ 完成 → 自动跑 O 组合阶段
  //        - O 组合完成 → 关闭 autoChain，提示用户手动点下载
  async function handleAllComplete(data) {
    const { results, stage } = data
    message.success(`${getStageName(stage)}阶段完成，共 ${results.length} 个成功`)
    currentStage.value = null
    await refreshTasks()
    await refreshDataCounts()

    if (!autoChain.value) return

    // 锦绣国际完成 → 自动进入 O 组合
    if (stage === 'jxgj') {
      await startNextFromJxgjDone()
      return
    }
    // O 组合完成 → 链路结束，提示用户下载
    if (stage === 'o_combo') {
      finishAutoChain()
    }
  }

  // ==================== 一键开始入口（TopToolbar 按钮调用） ====================
  // 打开自动链路开关 → 开始跑步骤2（锦绣国际）；步骤2完成 → handleAllComplete 自动触发步骤3 → 结束等用户点下载
  async function startAutoChain() {
    if (autoChain.value || isRunning.value) {
      message.warning('流程执行中，请勿重复操作')
      return
    }
    if (a1Count.value === 0) {
      message.warning('请先选择 Excel 文件')
      return
    }
    autoChain.value = true
    message.info('开始自动执行：锦绣国际 → O平台组合（完成后请手动下载结果）')
    await handleAddJxgjTasks()
  }

  // ==================== 初始化（组件级别的 onMounted 调用来注册监听器） ====================
  let listenersRegistered = false
  function ensureListeners() {
    if (listenersRegistered) return
    try {
      api.pcp.onTaskProgress(handleTaskProgress)
      api.pcp.onTaskAllComplete(handleAllComplete)
      api.pcp.onFileDownloadProgress(handleFileDownloadProgress)
      listenersRegistered = true
    } catch (e) {
      console.warn('[taskStore] 注册事件监听器失败', e)
    }
  }

  // 初始化入口（Stepper/TaskMonitor 组件 onMounted 时调用）
  async function init() {
    ensureListeners()
    await refreshAll()
    // 拉取主进程持久化的下载目录，让 UI 立刻显示当前目录
    await refreshDownloadDir()
  }

  return {
    // state
    selectedFile, a1Data, a1Count, a2Count, a3Count,
    tasks, isRunning, isPaused, currentStage, autoChain,
    concurrency, activeCount,
    downloadDir, downloadProgress, lastDownloadFilename,
    // getters
    completedCount, failedCount, pendingCount, a1Columns,
    // actions
    getStageName,
    refreshTasks, refreshDataCounts, refreshAll,
    handleUploadXlsx, handleAddJxgjTasks, handleAddOTasks, handleDownloadResult,
    handleSelectDownloadDir, handleOpenDownloadDir, refreshDownloadDir,
    handleDeleteTask, handleClearTasks, handleStart, handlePause, handleSetConcurrency,
    startAutoChain,
    init
  }
})
