// 任务对象 → 渲染层 IPC 快照（2026-09-30）
//
// 背景：scheduler.tasks 里的任务对象带着「仅供主进程导出/复盘使用」的胖字段。
//   主进程每次 webContents.send / ipcMain.handle 返回都要在**主线程同步**做 V8 结构化克隆：
//   真实跑批（110 航线 → 1143 任务）下单帧可达数百 MB，克隆自身就是数秒的**不可打断**阻塞
//   → Windows 判定窗口"未响应"。这类阻塞无法靠"多 yield"化解（克隆是原子的），
//   只能在 IPC 出口把渲染层用不到的数据摘掉。
//
// 剥离字段（已核对 src/ 全量引用，渲染层从不读取）：
//   - result.payload      ：携程原始响应（多渠道合并后，百 KB ~ MB 级）
//   - result.originalData ：锦绣 a2 原始行（与 task.data.source 内容重复）
//   - task.data.source    ：整条 a2 行 —— 每个"航线+日期"任务各带一份，同一航线重复 9~14 份
//
// 保留字段（渲染层实际用到）：
//   - result.processedData（OTA 航班列表/比价计数）、result.quoteRows（对比块表格）、
//     result.summary（统计）、result.data（jxgj 的 date_obj / cangwei_arr）
//   - task.data.{id,dateKey,dateValue}、task.preRequest
//
// 主进程内部（运行日志、政策复盘、a3 导出、ExcelExporter）读的一直是 scheduler.tasks
//   原对象（如 pipeline._exportRunLog / handleStageComplete 的 results），不受本模块影响。

/**
 * 单个任务 → IPC 精简快照（无需要剥离的字段时原样返回，不产生多余拷贝）
 * @param {object} task scheduler.tasks 中的任务对象
 * @returns {object} 可安全过 IPC 的浅拷贝
 */
export function slimTaskForIpc(task) {
  if (!task || typeof task !== 'object') return task
  let out = task

  // task.data.source：整条 a2 行（每个日期任务重复一份）
  const data = task.data
  if (data && typeof data === 'object' && data.source !== undefined) {
    const { source, ...restData } = data
    out = { ...out, data: restData }
  }

  // result.payload / result.originalData：原始响应用于主进程导出与复盘溯源
  const r = task.result
  if (r && typeof r === 'object' && (r.payload !== undefined || r.originalData !== undefined)) {
    const { payload, originalData, ...restResult } = r
    out = { ...out, result: restResult }
  }

  return out
}

/** 任务数组 → IPC 精简快照 */
export function slimTasksForIpc(tasks) {
  return Array.isArray(tasks) ? tasks.map(slimTaskForIpc) : tasks
}

/** scheduler.getState() 结果 → IPC 精简快照（tasks 逐个精简） */
export function slimTaskStateForIpc(state) {
  if (!state || typeof state !== 'object') return state
  return { ...state, tasks: slimTasksForIpc(state.tasks) }
}
