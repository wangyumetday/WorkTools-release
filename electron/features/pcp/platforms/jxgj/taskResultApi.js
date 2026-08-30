// ============================================================
// 锦绣 TaskResult / GetList 接口客户端
//
// 数据源：https://spider.xxklf.com/taskresult/api/TaskResult/GetList
// Swagger：https://spider.xxklf.com/taskresult/swagger/index.html
// 完整文档：项目根目录 锦绣TaskResult接口文档.md
//
// 设计要点：
//   1. 纯函数客户端：不访问 store、不写全局状态，可独立测试与并发调用
//   2. 复用 adapter.js 的重试/超时模式（指数退避 + AbortController）
//   3. 小接口：fetchList 单页查询 + fetchAllPages 自动翻页，两个函数覆盖全部场景
//   4. 无需登录/Token（接口实测无认证）
// ============================================================

import { JXGJ_RESPONSE_FIELDS } from '../../fieldNames.js'

// ---------- 内部常量 ----------
const BASE_URL = 'https://spider.xxklf.com/taskresult'
const ENDPOINT = '/api/TaskResult/GetList'

const REQUEST_TIMEOUT_MS = 15000
const MAX_RETRIES = 3
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

// 每页默认条数（接口不传 PageSize 时服务端默认 10）
const DEFAULT_PAGE_SIZE = 200

// ---------- 类型定义 ----------

/**
 * GetList 查询参数（全部可选，按需填写）
 * @typedef {Object} TaskResultQuery
 * @property {string}  [fn]           航班号 "HO1729"
 * @property {string}  [depDate]      出发日期 "2026-09-20T00:00:00"
 * @property {string}  [arrDate]      到达日期
 * @property {string}  [depAirPort]   出发机场三字码 "NKG"
 * @property {string}  [arrAirPort]   到达机场三字码 "CGQ"
 * @property {string}  [stopAirPort]  经停机场
 * @property {string}  [cabin]        舱位 "T" / "Y"
 * @property {string}  [carrier]      航司二字码 "HO"
 * @property {boolean} [gn]           是否经停
 * @property {boolean} [zz]           是否中转
 * @property {number}  [dataSource]   数据来源枚举 0-3
 * @property {string}  [spiderName]   爬虫名称
 * @property {number}  [updateSecond] 更新时间窗口（秒）
 * @property {boolean} [isTest]       是否包含测试数据
 * @property {number}  [max_seats]    最大座位数筛选
 * @property {number}  [priceStart]   价格下限（CNY）—— 映射到接口的"价格开始"
 * @property {number}  [priceEnd]     价格上限（CNY）—— 映射到接口的"价格结束"
 * @property {boolean} [priceType]    价格类型标记 —— 映射到接口的"价格类型"
 */

/**
 * GetList 响应
 * @typedef {Object} TaskResultResponse
 * @property {{ Total: number, List: Array }} Content
 */

// ---------- 内部 helper ----------

/**
 * 将查询参数对象转为 URL query string
 * 自动跳过 undefined / null / 空字符串
 * 驼峰名映射到接口实际参数名（中文/ PascalCase）
 * @param {TaskResultQuery} params
 * @returns {string} 形如 "?carrier=HO&PageSize=200"，无参数时返回空串
 */
function buildQueryString(params) {
  const keyMap = {
    priceStart: '价格开始',
    priceEnd: '价格结束',
    priceType: '价格类型',
    currentPage: 'CurrentPage',
    pageSize: 'PageSize',
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
 * 带重试 + 超时的 fetch（移植自 adapter.js fetchG1WithRetry，适配 TaskResult 语义）
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
 * 单页查询：调用一次 GetList，返回一页数据
 *
 * @param {TaskResultQuery} query  查询参数
 * @param {number} [currentPage=1]  页码，从 1 开始
 * @param {number} [pageSize=200]   每页条数
 * @returns {Promise<TaskResultResponse>}  原始响应（Content.Total + Content.List）
 *
 * @example
 * // 查询 HO 航司 NKG→CGQ 航线第一页（200 条/页）
 * const res = await fetchList({ carrier: 'HO', depAirPort: 'NKG', arrAirPort: 'CGQ' })
 * console.log(res.Content.Total, res.Content.List.length)
 */
export async function fetchList(query = {}, currentPage = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const qs = buildQueryString({ ...query, currentPage, pageSize })
  const url = `${BASE_URL}${ENDPOINT}${qs}`
  return await fetchWithRetry(url)
}

/**
 * 自动翻页：循环调用 fetchList 直到取完全部匹配数据
 *
 * @param {TaskResultQuery} query  查询参数（不含分页字段）
 * @param {number} [pageSize=200]  每页条数
 * @param {number} [maxPages=500]  安全上限，防止异常数据无限翻页
 * @returns {Promise<Array>}  全部匹配的 Ticket 数组
 *
 * @example
 * // 拉取 HO 航司 NKG→CGQ 所有日期的航班数据
 * const allTickets = await fetchAllPages({ carrier: 'HO', depAirPort: 'NKG', arrAirPort: 'CGQ' })
 * console.log(`共 ${allTickets.length} 条`)
 */
export async function fetchAllPages(query = {}, pageSize = DEFAULT_PAGE_SIZE, maxPages = 500) {
  const all = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchList(query, page, pageSize)
    const list = res.Content?.List ?? []
    all.push(...list)
    const total = res.Content?.Total ?? 0
    if (all.length >= total || list.length === 0) break
  }
  return all
}

export default { fetchList, fetchAllPages }
