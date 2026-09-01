// ============================================================
// ASS 专用 — 锦绣 TaskResult / GetList 接口客户端
//
// 数据源：https://spider.xxklf.com/taskresult/api/TaskResult/GetList
//
// ★ 来源与解耦说明（ADR-4 红线）：
//   本文件的 HTTP 层行为（常量值/重试/超时/参数映射/响应兜底）
//   严格复制自 PCP 模块 `electron/features/pcp/platforms/jxgj/taskResultApi.js`
//   及 `adapter.js` L54-58。但作为 ass 独立模块存在，
//   绝不 import / require / 调用任何 pcp 路径下的文件或对象。
//
// 设计要点：
//   1. 纯函数客户端，无外部依赖，可独立并发调用
//   2. 指数退避重试 + AbortController 超时
//   3. 只保留 fetchList（单页查询），ASS 不需要翻页
//   4. 无需登录 / Token（接口无认证）
// ============================================================

// ---------- 内部常量（与 PCP taskResultApi.js 逐行一致）----------
const BASE_URL = 'https://spider.xxklf.com/taskresult'
const ENDPOINT = '/api/TaskResult/GetList'

const REQUEST_TIMEOUT_MS = 15000
const MAX_RETRIES = 3
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

// 每页默认条数（接口不传 PageSize 时服务端默认 10；ASS/PCP 统一用 200 以减少截断概率）
const DEFAULT_PAGE_SIZE = 200

// ---------- 类型定义 ----------
/**
 * GetList 查询参数（全部可选，按需填写）
 * @typedef {Object} TaskResultQuery
 * @property {string}  [fn]           航班号
 * @property {string}  [depDate]      出发日期 "2026-09-20T00:00:00"
 * @property {string}  [arrDate]      到达日期
 * @property {string}  [depAirPort]   出发机场三字码
 * @property {string}  [arrAirPort]   到达机场三字码
 * @property {string}  [stopAirPort]  经停机场
 * @property {string}  [cabin]        舱位
 * @property {string}  [carrier]      航司二字码
 * @property {boolean} [gn]           是否经停
 * @property {boolean} [zz]           是否中转
 * @property {number}  [dataSource]   数据来源枚举
 * @property {string}  [spiderName]   爬虫名称
 * @property {number}  [updateSecond] 更新时间窗口（秒）
 * @property {boolean} [isTest]       是否包含测试数据
 * @property {number}  [max_seats]    最大座位数筛选
 * @property {number}  [priceStart]   价格下限 → 映射到"价格开始"
 * @property {number}  [priceEnd]     价格上限 → 映射到"价格结束"
 * @property {boolean} [priceType]    价格类型标记 → 映射到"价格类型"
 */

/**
 * GetList 响应
 * @typedef {Object} TaskResultResponse
 * @property {string}                    [Msg]    业务状态消息
 * @property {{ Total: number, List: Array }} [Content]
 */

// ---------- 内部 helper（与 PCP 逐行一致）----------

/**
 * 驼峰 → 接口实际参数名（中文 / PascalCase）映射 + 空值过滤
 * @param {TaskResultQuery} params
 * @returns {string} 形如 "?carrier=HO&PageSize=200"，无参数时返回空串
 */
function buildQueryString(params) {
  const keyMap = {
    priceStart: '价格开始',
    priceEnd:   '价格结束',
    priceType:  '价格类型',
    currentPage:'CurrentPage',
    pageSize:   'PageSize',
  }
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const key = keyMap[k] ?? k
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`
    })
  return entries.length ? '?' + entries.join('&') : ''
}

/**
 * 带重试 + 超时的 fetch（逐行对齐 PCP）
 * @param {string} url
 * @returns {Promise<TaskResultResponse>}
 */
async function fetchWithRetry(url) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      if (res.ok) {
        try {
          return await res.json()
        } catch {
          throw new Error('TaskResult 响应非 JSON 数据（服务可能正在维护）')
        }
      }
      if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        lastError = new Error(`TaskResult HTTP ${res.status}`)
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw new Error(`TaskResult HTTP ${res.status}`)
    } catch (err) {
      clearTimeout(timeoutId)
      if (err.message?.startsWith('TaskResult')) throw err
      if (attempt < MAX_RETRIES) {
        lastError = new Error(`TaskResult 网络请求失败：${err.message}`)
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw new Error(`TaskResult 网络请求失败：${err.message}`)
    }
  }
  throw lastError || new Error('TaskResult 请求失败：未知原因')
}

// ---------- 对外接口 ----------

/**
 * 单页查询：调用一次 GetList，返回一页原始响应（含 Msg 兜底）
 *
 * @param {TaskResultQuery} query         查询参数
 * @param {number}          [currentPage]  页码（默认 1）
 * @param {number}          [pageSize]     每页条数（默认 200）
 * @returns {Promise<TaskResultResponse>}  原始响应（若 Msg 缺失，补 Msg='OK'）
 */
export async function fetchList(query = {}, currentPage = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const qs = buildQueryString({ ...query, currentPage, pageSize })
  const url = `${BASE_URL}${ENDPOINT}${qs}`
  const res = await fetchWithRetry(url)
  // 对齐 PCP adapter.js L56：Msg 缺失补 'OK'
  if (res.Msg === undefined) res.Msg = 'OK'
  return res
}
