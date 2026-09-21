// ============================================================
// ASS 专用 — 锦绣 TaskResult / GetList 接口客户端
//
// 数据源：https://spider.xxklf.com/TaskResult/api/TaskResult/GetList （POST JSON）
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
const BASE_URL = 'https://spider.xxklf.com/TaskResult'
const ENDPOINT = '/api/TaskResult/GetList'

const REQUEST_TIMEOUT_MS = 15000
const MAX_RETRIES = 3
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

// 每页默认条数（接口不传 pageSize 时服务端默认 10；ASS/PCP 统一用 200 以减少截断概率）
const DEFAULT_PAGE_SIZE = 200

// ---------- 类型定义 ----------

/*
 * ==================== GetList POST body 参数 ↔ 锦绣网页 UI 对照 ====================
 * 依据：_local/JXAPI参数/image.png（抓包参数）+ 同目录 Snipaste 截图（网页中文控件）
 * 全部参数均可选；标【程序在用】的是本项目当前实际会传的字段，其余已预留但暂未使用。
 * （本块与 PCP taskResultApi.js 保持一致——ADR-4）
 *
 * 序号  body 键名(线上实际)      代码侧入参(本文件)   UI 控件名        说明/实测结论
 * ────  ───────────────────────  ───────────────────  ──────────────   ─────────────────────────────────────────────
 *  1    currentPage               currentPage          （分页）         页码，从 1 开始
 *  2    pageSize                  pageSize             （分页）         每页条数，服务端默认 10，本项目统一 200
 *  3    carrier                   carrier【程序在用】  航司             二字码，如 "XQ"
 *  4    fn                        fn                   航班号           如 "XQ983"
 *  5    spiderName                spiderName           爬虫名           如 "XQ"
 *  6    cabin                     cabin                舱位             舱位代码；留空=不限
 *  7    depDate                   depDate【ASS 在用】  起飞开始日期     YYYY-MM-DD。★两个框都筛「起飞日期」，与到达日期无关：
 *                                                                       只传 depDate = 起飞日期为当天的航班（ASS 用法，直连实测 + 网页复测一致）
 *  8    arrDate                   arrDate              起飞结束日期     YYYY-MM-DD。★筛的同样是起飞日期，不是到达日期：
 *                                                                       只传 arrDate = 起飞当天（与单传 depDate 的结果集 Ticket_ID 完全相同）；
 *                                                                       两个都传 = 起飞日期落在 [depDate, arrDate] 闭区间；
 *                                                                       区间内跨夜航班即使次日到达也会返回（实测有 51 条次日到达）
 *  9    depAirPort                depAirPort【程序在用】出发/到达机场-出发 三字码，如 "CGN"
 * 10    arrAirPort                arrAirPort【程序在用】出发/到达机场-到达 三字码，如 "ADB"
 * 11    max_seats                 max_seats            最大座位数       注意是下划线命名，如 2
 * 12    index                     index                套餐索引         对应响应里的「套餐索引」字段，如 1
 * 13    价格开始（中文键）         priceStart           价格开始         人民币总票价下限；buildRequestBody 负责别名映射
 * 14    价格结束（中文键）         priceEnd             价格结束         人民币总票价上限；实测 50~100 过滤掉千元级票
 * 15    价格类型（中文键）         priceType            价格类型（下拉） true=总票价（截图取值）；下拉另一项疑为净票价
 * 16    zz                        zz                   中转/直达（下拉）null=全部；true=中转；false=直达
 *                                                                       实测 XQ 样本：null 2819 = true 1350 + false 1469
 * 17    gn                        gn                   国内/国际（下拉）★gn=国内(GuoNei)，与"经停"无关：
 *                                                                       true=国内；false=国际（截图取值）；null=全部
 * 18    updateSecond              updateSecond         最后更新时间     数据新鲜度窗口，单位秒；30 分钟=1800
 * 19    dataSource                dataSource           数据来源（下拉） 0=全部（实测 1 与 0 同结果，2/3 当前无数据；其余枚举待确认）
 *  —    （抓包中未出现）           isTest               测试数据（勾选框）未勾选时请求体不含该字段；勾选时应为 true
 *
 * 注：旧版 GET 接口注释里的 stopAirPort（经停机场）在新接口抓包参数中不存在，已移除。
 *     价格三字段线上是中文 JSON 键，代码侧统一用英文别名 priceStart/priceEnd/priceType，
 *     由 buildRequestBody 的 PRICE_KEY_MAP 转换，调用方不要直接写中文键。
 * ================================================================================
 */

/**
 * GetList 查询参数（代码侧入参；全部可选，按需填写）
 * @typedef {Object} TaskResultQuery
 * @property {string}  [carrier]      航司二字码 "XQ"【程序在用：PCP prepareRequest / ASS buildJinXiuQuery】
 * @property {string}  [fn]           航班号 "XQ983"（UI：航班号）
 * @property {string}  [spiderName]   爬虫名 "XQ"（UI：爬虫名）
 * @property {string}  [cabin]        舱位代码，空=不限（UI：舱位）
 * @property {string}  [depDate]      起飞开始日期 "YYYY-MM-DD"，单传=起飞当天（UI：起飞开始日期）【ASS 在用】
 * @property {string}  [arrDate]      起飞结束日期 "YYYY-MM-DD"；★筛的也是起飞日期，单传=起飞当天（与 depDate 结果相同），两者同传=起飞日期闭区间（UI：起飞结束日期）
 * @property {string}  [depAirPort]   出发机场三字码 "CGN"（UI：出发机场）【程序在用】
 * @property {string}  [arrAirPort]   到达机场三字码 "ADB"（UI：到达机场）【程序在用】
 * @property {number}  [max_seats]    最大座位数，下划线命名（UI：最大座位数）
 * @property {number}  [index]        套餐索引，对应响应「套餐索引」字段（UI：套餐索引）
 * @property {number}  [priceStart]   人民币总票价下限 → 线上键「价格开始」（UI：价格开始）
 * @property {number}  [priceEnd]     人民币总票价上限 → 线上键「价格结束」（UI：价格结束）
 * @property {boolean} [priceType]    true=总票价 → 线上键「价格类型」（UI：价格类型下拉）
 * @property {boolean|null} [zz]      中转/直达：null=全部 / true=中转 / false=直达（UI：中转/直达）
 * @property {boolean|null} [gn]      国内/国际：true=国内 / false=国际 / null=全部（UI：国内/国际，非"经停"）
 * @property {number}  [updateSecond] 数据新鲜度窗口（秒），1800=30 分钟（UI：最后更新时间）
 * @property {number}  [dataSource]   数据来源：0=全部，其余枚举待确认（UI：数据来源）
 * @property {boolean} [isTest]       是否含测试数据；勾选框不勾时线上请求不带此字段（UI：测试数据）
 */

/**
 * GetList 响应
 * @typedef {Object} TaskResultResponse
 * @property {number} [Status]                          业务状态码（实测 1）
 * @property {string} [Msg]                             业务状态消息（实测 "OK"，缺失时 fetchList 补 'OK'）
 * @property {{ Total: number, List: Array }} [Content]
 */

// ---------- 内部 helper（与 PCP 逐行一致）----------

// 代码侧英文别名 → 线上 POST body 中文键（仅价格三字段；其余字段线上即小驼峰，直接透传）
// 实测：JSON body 必须带 UTF-8 中文键价格过滤才生效（Node fetch 默认 UTF-8，无编码问题）
const PRICE_KEY_MAP = {
  priceStart: '价格开始',
  priceEnd: '价格结束',
  priceType: '价格类型',
}

/**
 * 构建 POST JSON 请求体：合并查询参数与分页字段
 * 自动跳过 undefined / null / 空字符串；价格别名经 PRICE_KEY_MAP 转成线上中文键，其余键名原样透传
 * @param {TaskResultQuery} params
 * @param {number} currentPage
 * @param {number} pageSize
 * @returns {Object} 可直接 JSON.stringify 的请求体
 */
function buildRequestBody(params, currentPage, pageSize) {
  const merged = { ...params, currentPage, pageSize }
  const body = {}
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '') continue
    body[PRICE_KEY_MAP[k] ?? k] = v
  }
  return body
}

/**
 * 带重试 + 超时的 fetch（POST JSON；逐行对齐 PCP）
 * @param {string} url
 * @param {Object} body JSON 请求体
 * @returns {Promise<TaskResultResponse>}
 */
async function fetchWithRetry(url, body) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
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
 * 单页查询：调用一次 GetList（POST JSON），返回一页原始响应（含 Msg 兜底）
 *
 * @param {TaskResultQuery} query         查询参数
 * @param {number}          [currentPage]  页码（默认 1）
 * @param {number}          [pageSize]     每页条数（默认 200）
 * @returns {Promise<TaskResultResponse>}  原始响应（若 Msg 缺失，补 Msg='OK'）
 */
export async function fetchList(query = {}, currentPage = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const body = buildRequestBody(query, currentPage, pageSize)
  const url = `${BASE_URL}${ENDPOINT}`
  const res = await fetchWithRetry(url, body)
  // 对齐 PCP adapter.js L56：Msg 缺失补 'OK'
  if (res.Msg === undefined) res.Msg = 'OK'
  return res
}
