import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useTaskStore } from '../stores/task.js'

/**
 * 任务列表共享逻辑(行渲染 + 详情面板 + 折叠状态 + 数据提取)
 * 被 TaskList.vue(真实列表)与 TaskListVirtual.vue(虚拟列表)共用:
 * 两种实现共享同一份逻辑,仅模板与容器 CSS 不同。
 */
export function useTaskList() {
  const store = useTaskStore()

  // ===== 任务行展开详情 =====
  //   - 点击行切换展开/收起（同一行再点关闭）
  //   - 只展开一行（简单，数据不会太挤）
  const expandedTaskId = ref(null)
  function toggleExpand(id) {
    expandedTaskId.value = expandedTaskId.value === id ? null : id
    // 收起行时同步收起该任务的输入/返回数据折叠（避免下次展开残留）
    if (expandedTaskId.value === null) {
      if (inputDataExpandedId.value === id) inputDataExpandedId.value = null
      if (resultDataExpandedId.value === id) resultDataExpandedId.value = null
      // 同步重置航班信息折叠状态
      if (flightPanelExpandedId.value === id) flightPanelExpandedId.value = null
      expandedDates.value = new Set()
    }
  }

  // ===== 输入/返回数据折叠（详情里的二级折叠，每任务独立）=====
  const inputDataExpandedId = ref(null)
  function toggleInputData(id) {
    inputDataExpandedId.value = inputDataExpandedId.value === id ? null : id
  }

  const resultDataExpandedId = ref(null)
  function toggleResultData(id) {
    resultDataExpandedId.value = resultDataExpandedId.value === id ? null : id
  }

  // ===== 航班信息折叠(详情里的三级折叠:jxgj 日期组 → 单个日期 → 航班行)=====
  //   flightPanelExpandedId: "航班信息"外层折叠状态(单任务 id,与 expandedTaskId 同模式)
  //     - jxgj:date_obj 有多个日期时,外层是"日期组"标题,点击展开看日期列表
  //     - OTA:processedData 有多条时,外层是"匹配航班"标题,点击展开看行列表
  //   expandedDates:jxgj 每个日期的展开状态(Set<string>,日期字符串)
  //     用新 Set 替换触发响应式(Vue 3 ref 包 Set 需重新赋值才能 update)
  const flightPanelExpandedId = ref(null)
  function toggleFlightPanel(id) {
    flightPanelExpandedId.value = flightPanelExpandedId.value === id ? null : id
  }
  const expandedDates = ref(new Set())
  function toggleDate(date) {
    const s = new Set(expandedDates.value)
    if (s.has(date)) s.delete(date)
    else s.add(date)
    expandedDates.value = s
  }

  // ===== jxgj 返回数据提取 =====
  //   task.result 结构(来自 jxgj adapter.mergeResult 的返回):
  //     { platform, status, data: { inputData: a2Item, ... } }
  //   a2Item.date_obj 是 { "2026-08-28": [flight,...], "2026-09-06": [...] }
  //   字段名 date_obj / cangwei_arr 对应后端 A2_FIELDS(见 electron/.../fieldNames.js)
  function getJxgjDateEntries(item) {
    const dateObj = item?.result?.data?.inputData?.date_obj
    if (!dateObj || typeof dateObj !== 'object') return []
    return Object.entries(dateObj).map(([date, items]) => ({
      date,
      items: Array.isArray(items) ? items : []
    }))
  }
  // jxgj 航班总数 = date_obj 下所有 items 累加(用于"X 条 / Y 日"标题)
  function getJxgjTotalFlights(item) {
    return getJxgjDateEntries(item).reduce((sum, d) => sum + d.items.length, 0)
  }

  // ===== OTA 返回数据提取 =====
  //   task.result.processedData 是比价匹配上的航班数组(来自 trip adapter.mergeResult)
  //   每项含 C出发日期/H航班号/C舱位/C出发机场/D到达机场/XC_dijia(=携程 sortIndicator=OTA 底价)
  function getOtaFlights(item) {
    const pd = item?.result?.processedData
    return Array.isArray(pd) ? pd : []
  }

  // OTA 差额 = 返回价(XC_dijia) - 请求价(C成人总票价_CNY_INT)
  //   正数=返回高于请求(有毛利空间),负数=返回低于请求
  function getOtaDiff(f) {
    const ret = Number(f?.XC_dijia)
    const req = Number(f?.C成人总票价_CNY_INT)
    if (isNaN(ret) || isNaN(req)) return '-'
    return ret - req
  }

  // 汇总成功任务的结果（提取 processedCount / summary / reason 等字段）
  function summarizeResult(result) {
    if (!result || typeof result !== 'object') return '无详情'
    const parts = []
    // 处理条数
    if (typeof result.processedCount === 'number') parts.push(`处理条数：${result.processedCount}`)
    if (typeof result.processed === 'number') parts.push(`processed=${result.processed}`)
    // 摘要
    if (result.summary && typeof result.summary === 'object') {
      if (typeof result.summary.flightCount === 'number') parts.push(`航班数=${result.summary.flightCount}`)
      if (typeof result.summary.lowPriceCount === 'number') parts.push(`底价条数=${result.summary.lowPriceCount}`)
    }
    // 0 结果原因（BUG-4 记录的 reason）
    if (result.reason) parts.push(`备注：${result.reason}`)
    // 致命标记
    if (result.isFatal) parts.push('（致命错误）')
    return parts.length > 0 ? parts.join('  |  ') : '请求完成'
  }

  // 格式化输入数据为可读 JSON（限制字符数，避免太长）
  function prettyJson(obj, maxLines = 40) {
    try {
      const text = JSON.stringify(obj, null, 2)
      const lines = text.split('\n')
      if (lines.length > maxLines) {
        return lines.slice(0, maxLines).join('\n') + `\n... (共 ${lines.length} 行，已截断)`
      }
      return text
    } catch {
      return String(obj ?? '')
    }
  }

  // ===== 运行时时钟（耗时列刷新） =====
  // 2000ms 精度足够看 MM:SS，比 1000ms 少一半重绘次数
  const now = ref(Date.now())
  let timer = null
  onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 2000) })
  onBeforeUnmount(() => { if (timer) clearInterval(timer) })

  // ===== 类型映射（与后端 task.type 对齐） =====
  const typeMap = {
    jxgj: '锦绣国际',
    trip: '携程OTA',
    o2: 'O2',
    o3: 'O3',
    o_combo: 'O组合',
    process: '处理'
  }

  // ===== 状态映射：文字 =====
  const statusMap = {
    pending: { text: '等待' },
    running: { text: '运行' },
    completed: { text: '完成' },
    failed: { text: '失败' },
    paused: { text: '暂停' }
  }

  // ===== Helpers =====
  function shortId(id) {
    if (typeof id !== 'string') return String(id ?? '').slice(-4)
    if (id.startsWith('task_') || id.startsWith('row_')) return id.slice(-4)
    return id.slice(-4)
  }

  // ============== 背景进度条（核心） ==============
  // 进度宽度：pending/paused=0；running=progress%；completed/failed=100%
  // 实际 CSS 用 transform scaleX(x/100)，这里返回 0~100，模板里再除以 100
  function progressWidth(row) {
    if (row.status === 'completed' || row.status === 'failed') return 100
    if (row.status === 'running') return Math.min(100, Math.max(0, row.progress || 0))
    return 0
  }
  // 进度填充颜色（按状态，半透明色阶，复用 pg-* 类）
  function progressClass(row) {
    return ({
      pending: 'pg-wait',
      running: 'pg-run',
      completed: 'pg-done',
      failed: 'pg-fail',
      paused: 'pg-pause'
    })[row.status] || 'pg-wait'
  }

  // ============== 百分比数字着色 ==============
  function pctClass(row) {
    if (row.status === 'completed') return 'p-done'
    if (row.status === 'failed') return 'p-fail'
    if (row.status === 'running') return 'p-run'
    return 'p-wait'
  }

  // ============== 状态文字着色 ==============
  function statusClass(s) {
    return ({
      pending: 'st-wait',
      running: 'st-run',
      completed: 'st-done',
      failed: 'st-fail',
      paused: 'st-pause'
    })[s] || 'st-wait'
  }

  // ============== 耗时计算（以 startedAt 为基准，排除排队等待时间） ==============
  //   pending：未开始 → 0
  //   paused：先显示 0（暂缺 pausedAt）
  //   running：startedAt → now（前端时钟）
  //   completed/failed：startedAt → finishedAt
  function getDuration(row) {
    if (!row || !row.startedAt) return 0
    if (row.status === 'pending' || row.status === 'paused') return 0
    let end
    if (row.status === 'completed' || row.status === 'failed') {
      end = typeof row.finishedAt === 'number' ? row.finishedAt : row.startedAt
    } else {
      end = now.value
    }
    return Math.max(0, end - row.startedAt)
  }
  // 格式：秒（一位小数）
  function formatDuration(ms) {
    return (ms / 1000).toFixed(1)
  }

  /**
   * 底价调试标签：把 Electron 端 floorPrice.js 的 ComputeResult._floorMeta
   * 压缩成一行可读串："区间[500,700] cost*0.48" / "全局 cost*0.2" / "降级 原价"
   */
  function formatFloorMeta(meta) {
    if (!meta || typeof meta !== 'object') return ''
    const type = meta.formulaType || '?'
    const typeLabel = type === 'range' ? '区间' : (type === 'global' ? '全局' : '降级')
    const rangeStr = Array.isArray(meta.rangeHit) && meta.rangeHit.length === 2
      ? `[${meta.rangeHit[0]},${meta.rangeHit[1]}] `
      : ''
    // 降级原价简化,方便一眼识别
    const formulaStr = (meta.formulaStr === 'cost' && type === 'fallback')
      ? '原价'
      : (meta.formulaStr || '?')
    return `${typeLabel} ${rangeStr}${formulaStr}`
  }

  return {
    store,
    expandedTaskId, toggleExpand,
    inputDataExpandedId, toggleInputData,
    resultDataExpandedId, toggleResultData,
    flightPanelExpandedId, toggleFlightPanel,
    expandedDates, toggleDate,
    getJxgjDateEntries, getJxgjTotalFlights,
    getOtaFlights, getOtaDiff,
    summarizeResult, prettyJson,
    now,
    typeMap, statusMap,
    shortId, progressWidth, progressClass, pctClass, statusClass,
    getDuration, formatDuration, formatFloorMeta
  }
}
