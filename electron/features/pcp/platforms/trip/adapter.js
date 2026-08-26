// ============================================================
// TRIP（携程 OTA 低价看板）平台 adapter
// 移植自老 o1.js，拆为 prepareRequest / request / mergeResult 三步
// 语义：O 平台（步骤4），a2 → 该平台比价结果（processedData）
// 协议：Json + Gzip HTTPS POST（请求体压缩，响应解压）
// ============================================================

import https from 'node:https'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { configSchema, defaults } from './config.js'

export const key = 'trip'
// 平台中文名：用于导出文件名（携程导入政策{日期}.xlsx / 携程底价检查{日期}.xlsx）和底价列名（携程底价）
export const displayName = '携程'
export { configSchema, defaults }

/** TRIP 无公式编译，透传字符串配置 */
export const compileConfig = (raw = {}) => ({ ...raw })

/** 低价看板无需独立登录，请求头带账密即可，此处透传 */
export async function login(credential) {
  return { loginName: credential?.username || '', password: credential?.password || '' }
}

// ============================================================
// 进程级滑动窗口限流器（携程专用，处理 rateLimitPerMin 阈值 + 429 被动冷却）
// 设计要点（对齐项目硬约束）：
//   1. 模块级单例：跨并发 worker 共享同一计数状态，保证准确计数
//   2. 滑动窗口：维护请求时间戳数组，避免固定窗口的边界尖峰（59s 末 200 + 0s 头 200 = 1s 400 的封号风险）
//   3. acquire 串行化：用 Promise chain 排队所有 acquire 调用，避免并发计数竞态
//   4. 429 被动冷却：服务端返 429 时进入 cooldown，Retry-After 优先，无则默认 30s
//   5. 配置快照：每次 acquire 从 compiledConfig.rateLimitPerMin 动态读取阈值
//      （TaskManager.precompilePlatformConfigs 编译后 cfg.rateLimitPerMin 即用户配置值）
// ============================================================
const RATE_LIMIT_WINDOW_MS = 60_000  // 滑动窗口长度 60s
const DEFAULT_COOLDOWN_MS = 30_000   // 429 默认冷却 30s（无 Retry-After 时）

function createRateLimiter() {
  const state = {
    timestamps: [],                   // 滑动窗口内已发出的请求时间戳
    cooldownUntil: 0,                 // 被动冷却到期时间戳（0 = 无冷却）
    acquireChain: Promise.resolve()   // 串行化 acquire 调用的 Promise chain
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  // 清理超过滑动窗口的过期时间戳
  function pruneExpired(now) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS
    while (state.timestamps.length > 0 && state.timestamps[0] < cutoff) {
      state.timestamps.shift()
    }
  }

  // acquire 的实际工作函数（由外层 chain 包装串行执行）
  async function acquireThunk(rateLimitPerMin) {
    const limit = Number(rateLimitPerMin) || 0
    if (limit <= 0) return  // 0 / NaN / 负数 = 不限流（dev 调试可设 0 关闭限流）

    // 1. 被动冷却检查：429 触发的 cooldown 必须先等完
    if (state.cooldownUntil > Date.now()) {
      await sleep(state.cooldownUntil - Date.now())
    }

    // 2. 主动滑动窗口检查：循环等到窗口内请求数 < limit
    for (;;) {
      const now = Date.now()
      pruneExpired(now)
      if (state.timestamps.length < limit) break
      // 窗口已满 → 等到最早时间戳滑出窗口（+10ms 避免抢刚过期那一瞬）
      const waitMs = state.timestamps[0] + RATE_LIMIT_WINDOW_MS - now + 10
      if (waitMs > 0) await sleep(waitMs)
    }

    // 3. 占一个位置（记录本次请求的时间戳）
    state.timestamps.push(Date.now())
  }

  return {
    // 串行化的 acquire：所有调用排队执行，避免并发计数竞态
    //   state.acquireChain 用 .catch(() => {}) 吞错，保证 chain 永不 reject（否则后续 acquire 全卡）
    //   但返回的 next 保留错误，调用者能收到 acquireThunk 抛的异常
    acquire(rateLimitPerMin) {
      const next = state.acquireChain.then(() => acquireThunk(rateLimitPerMin))
      state.acquireChain = next.catch(() => {})
      return next
    },
    // 429 被动冷却：Retry-After 优先（携程返秒数），无则默认 30s
    //   Math.max 防止短 cooldown 覆盖长 cooldown（连续 429 时取最远到期时间）
    cooldown(retryAfterSec) {
      const ms = Number(retryAfterSec) > 0 ? Number(retryAfterSec) * 1000 : DEFAULT_COOLDOWN_MS
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + ms)
    },
    // 调试用：返回当前状态快照（只读，不发请求）
    snapshot() {
      const now = Date.now()
      pruneExpired(now)
      return {
        windowCount: state.timestamps.length,
        cooldownRemainingMs: Math.max(0, state.cooldownUntil - now)
      }
    }
  }
}

// 模块级单例：进程级共享，跨 worker 准确计数（不持久化，进程重启即清零）
const _rateLimiter = createRateLimiter()

// ===== 内部 helper（从 o1.js 移植）=====
function buildSegments(data) {
  const CF_CITY = data.dateValue[0].C出发城市
  const DD_CITY = data.dateValue[0].D到达城市
  const RIQI = data.dateKey
  if (!CF_CITY || !DD_CITY || !RIQI) {
    throw new Error(`O1平台请求失败：缺少必填字段（C出发城市/D到达城市/日期）实际：${JSON.stringify(data)}`)
  }
  const segments = (Array.isArray(data?.segments) && data.segments.length > 0)
    ? data.segments
    : [{ segmentNo: 1, departCity: CF_CITY, arriveCity: DD_CITY, departDate: RIQI }]
  const seg0 = segments[0] || {}
  if (!seg0.departCity || !seg0.arriveCity || !seg0.departDate) {
    throw new Error(`O1平台请求失败：segments 缺少必填字段（departCity/arriveCity/departDate），实际：${JSON.stringify(seg0)}`)
  }
  return segments
}

function buildRequestBody(cfg, loginName, password, segments, validatingCarrier) {
  return {
    requestHeader: { requestID: randomUUID(), loginName, password, language: cfg.language },
    queryCondition: {
      tripType: cfg.tripType, validatingCarrier, segments,
      travelerCount: cfg.travelerCount, childTravelerCount: cfg.childTravelerCount,
      seatGrade: cfg.seatGrade, channel: cfg.channel, subChannel: cfg.subChannel,
      scMarket: cfg.scMarket, specialParam: cfg.specialParam
    }
  }
}

function postGzip(baseURL, gzippedBody, timeout) {
  const url = new URL(baseURL)
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Encoding': 'gzip',
    'Content-Length': gzippedBody.length,
    'Accept-Encoding': 'gzip'
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, port: url.port || 443,
      path: url.pathname + url.search, method: 'POST', headers
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({ statusCode: res.statusCode, headers: res.headers, body })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error(`O1平台请求超时（${timeout}ms）`)))
    req.write(gzippedBody)
    req.end()
  })
}

function priceComparisonPolicy(originalData, resData) {
  const resArr = []
  const forData = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  const flights = Array.isArray(resData?.responseBody?.flights) ? resData.responseBody.flights : []
  const lowPrices = Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : []
  const dateKey = originalData?.dateKey || 'unknown-date'

  // [debug] 一次性字段名采样：第一次进 priceComparisonPolicy 时输出 jxgj item / trip flights / lowPrices 的字段名
  //   目的：定位"processedData=0"是字段名不匹配还是业务比价输
  //   定位后可整段删除
  if (!priceComparisonPolicy._sampled) {
    priceComparisonPolicy._sampled = true
    const sampleItem = forData[0] || {}
    const sampleFlight = flights[0] || {}
    const sampleLp = lowPrices[0] || {}
    const samplePrice = (sampleLp.prices && sampleLp.prices[0]) || {}
    // console.log('[trip/debug] ===== 字段名采样（仅一次） =====')
    // console.log('[trip/debug] jxgj item 字段:', Object.keys(sampleItem))
    // console.log('[trip/debug]   item.H航班号 =', sampleItem.H航班号, '| item.C出发机场 =', sampleItem.C出发机场, '| item.D到达机场 =', sampleItem.D到达机场, '| item.C出发日期 =', sampleItem.C出发日期, '| item.dijia =', sampleItem.dijia, '| item.C成人总票价_CNY_INT =', sampleItem.C成人总票价_CNY_INT)
    // console.log('[trip/debug] trip flights 字段:', Object.keys(sampleFlight))
    // console.log('[trip/debug]   f.flightNo =', sampleFlight.flightNo, '| f.departAirport =', sampleFlight.departAirport, '| f.arriveAirport =', sampleFlight.arriveAirport, '| f.takeOffDateTime =', sampleFlight.takeOffDateTime, '| f.flightId =', sampleFlight.flightId)
    // console.log('[trip/debug] trip lowPrices 字段:', Object.keys(sampleLp))
    // console.log('[trip/debug]   lp.flightRefs =', JSON.stringify(sampleLp.flightRefs))
    // console.log('[trip/debug] trip lowPrices[0].prices[0] 字段:', Object.keys(samplePrice))
    // console.log('[trip/debug]   p.baggage =', samplePrice.baggage, '| p.showState =', samplePrice.showState, '| p.isOwn =', samplePrice.isOwn, '| p.sortIndicator =', samplePrice.sortIndicator)
    // console.log('[trip/debug] ====================================')
  }

  let matchedFlights = 0
  let matchedLowPrice = 0
  let wonByPrice = 0
  let lostByPrice = 0  // 接口有低价但 dijia > sortIndicator（业务上比输了）

  forData.forEach(item => {
    const flights_related = flights.find(f =>
      f &&
      String(f.flightNo) === String(item.H航班号) &&
      String(f.departAirport) === String(item.C出发机场) &&
      String(f.arriveAirport) === String(item.D到达机场) &&
      String((f.takeOffDateTime || '').split(' ')[0]) === String(item.C出发日期)
    )
    if (flights_related) matchedFlights++

    let lowPrice_related = null
    if (flights_related?.flightId != null) {
      const relatedLp = lowPrices.find(lp => Array.isArray(lp?.flightRefs) && lp.flightRefs.some(ref => ref?.flightId === flights_related.flightId))
      if (relatedLp) {
        const prices = Array.isArray(relatedLp.prices) ? relatedLp.prices : []
        lowPrice_related = prices.find(lpr => {
          const baggage = String(lpr?.baggage || '')
          return baggage.includes('无免费托运行李额') && Number(lpr?.showState) === 1 && !lpr?.isOwn
        })
        if (!lowPrice_related) {
          lowPrice_related = prices.find(lpr => Number(lpr?.showState) === 1 && !lpr?.isOwn)
        }
      }
    }
    if (lowPrice_related) matchedLowPrice++

    const sortIndicator = Number(lowPrice_related?.sortIndicator)
    const hasXcPrice = !isNaN(sortIndicator) && sortIndicator > 0
    const dijia = Number(item.dijia) || 0
    const totalCNY = Number(item.C成人总票价_CNY_INT) || 0
    if (hasXcPrice && dijia > 0 && dijia <= sortIndicator) {
      wonByPrice++
      item.XC_dijia = sortIndicator
      item.CUT_VALUE = new Decimal(sortIndicator).minus(totalCNY || 0).minus(1).toNumber()
      resArr.push(item)
    } else if (hasXcPrice && dijia > sortIndicator) {
      lostByPrice++
    }
  })

  // [debug] 每个任务的比价计数：定位"processedData=0"是哪一步断了
  //   航班匹配=0 → 字段名问题（H航班号/C出发机场 等）
  //   低价套餐匹配=0 → flightId 链接或 lowPrices 字段问题
  //   比赢入队=0 + 比输=N → 业务上 dijia 普遍 > 携程底价（数据问题，不是 bug）
  //   定位后可整段删除
  // console.log(`[trip/debug] dateKey=${dateKey} 舱位项=${forData.length} → 航班匹配=${matchedFlights} 低价套餐匹配=${matchedLowPrice} 比赢=${wonByPrice} 比输=${lostByPrice} → processedData=${resArr.length}`)

  return resArr
}

// ===== PlatformAdapter 接口 =====
/**
 * 前置：合并配置 + 构造行程段 + 取开票航司
 * @param {object} a2Item - O 任务数据（含 dateValue[0].C出发城市/H航司名 等 + dateKey）
 * @returns {{ segments, validatingCarrier, cfg }}
 */
export function prepareRequest(a2Item, _dateKey, compiledConfig) {
  const cfg = { ...defaults, ...compiledConfig }
  const segments = buildSegments(a2Item)
  const validatingCarrier = a2Item.dateValue[0].H航司名 || cfg.validatingCarrier || ''
  return { segments, validatingCarrier, cfg }
}

/**
 * 请求：注入账密 + 组装请求体 + gzip 压缩 + 发送
 * @returns {Promise<{statusCode, headers, body}>} 原始 HTTP 响应
 */
export async function request(prepared, ctx) {
  const { segments, validatingCarrier, cfg } = prepared
  const { credential, loginResult = {} } = ctx
  const loginName = loginResult.loginName || credential?.username || ''
  const password = loginResult.password || credential?.password || ''
  if (!loginName || !password) {
    throw new Error('O1平台请求失败：缺少账密（credential.username/password 或 loginResult 未提供）')
  }

  // ★ 滑动窗口限流：acquire 串行排队，等到窗口内请求数 < rateLimitPerMin 才放行
  //   rateLimitPerMin 来自 cfg（= compiledConfig.rateLimitPerMin，TaskManager 启动时已编译为快照）
  //   设为 0 / 负数 = 关闭限流（dev 调试可设 0 跳过限流）
  await _rateLimiter.acquire(cfg.rateLimitPerMin)

  const requestBody = buildRequestBody(cfg, loginName, password, segments, validatingCarrier)
  const gzippedBody = gzipSync(Buffer.from(JSON.stringify(requestBody), 'utf-8'))
  const rawResponse = await postGzip(cfg.baseURL, gzippedBody, cfg.timeout)

  // ★ 429 被动冷却：携程服务端限流时返 429 + Retry-After（秒）
  //   触发 cooldown 后，后续所有 acquire 会自动等待冷却到期再放行
  //   这里抛错让 platformRunner 标记本任务 fail（避免无效重试打爆携程）
  if (rawResponse.statusCode === 429) {
    const retryAfterSec = rawResponse.headers?.['retry-after']
    _rateLimiter.cooldown(retryAfterSec)
    const cooldownDesc = Number(retryAfterSec) > 0 ? `${retryAfterSec}s` : '30s（默认）'
    throw new Error(`O1平台 429 限流：触发被动冷却 ${cooldownDesc}（Retry-After: ${retryAfterSec || '(无)'}）`)
  }

  return rawResponse
}

/**
 * 交叉：解压 → 解析 → 状态校验 → 比价（priceComparisonPolicy）→ 该平台结果
 * @param {object} rawResponse - request 返回的原始 HTTP 响应
 * @param {object} a2Item - 原 O 任务数据（用于比价时拿 dijia/成人总票价）
 * @returns {object} { platform:'trip', processedData, payload, ... }
 */
export function mergeResult(rawResponse, a2Item, _compiledConfig) {
  let bodyBuf = rawResponse.body
  const contentEncoding = String(rawResponse.headers['content-encoding'] || '').toLowerCase()
  if (contentEncoding.includes('gzip') && bodyBuf.length > 0) {
    try { bodyBuf = gunzipSync(bodyBuf) }
    catch (e) { throw new Error(`O1平台响应 gunzip 解压失败：${e.message}`) }
  }
  const bodyText = bodyBuf.toString('utf-8')
  let resData
  try { resData = JSON.parse(bodyText) }
  catch (e) { throw new Error(`O1平台响应 JSON 解析失败：${e.message}（前 200 字符：${bodyText.slice(0, 200)}）`) }
  if (rawResponse.statusCode < 200 || rawResponse.statusCode >= 300) {
    throw new Error(`O1平台 HTTP ${rawResponse.statusCode}：${resData?.responseHeader?.message || bodyText.slice(0, 200)}`)
  }
  const ack = resData?.ResponseStatus?.Ack
  if (ack && ack !== 'Success') {
    const errors = resData?.ResponseStatus?.Errors || []
    const errMsg = errors.map(e => e?.Message || e?.message || JSON.stringify(e)).join('; ')
    throw new Error(`O1平台请求业务失败：Ack=${ack} - ${errMsg}`)
  }
  const processedDataArr = priceComparisonPolicy(a2Item, resData)
  const flightCount = resData?.responseBody?.flights?.length || 0
  const lowPriceCount = resData?.responseBody?.lowPrices?.length || 0
  return {
    platform: 'trip', status: 'ok', code: rawResponse.statusCode,
    message: resData?.responseHeader?.message || 'success',
    payload: resData, originalData: a2Item || null,
    processedData: processedDataArr,
    summary: { flightCount, lowPriceCount },
    processedAt: new Date().toISOString()
  }
}

// ============================================================
// 导出模板（阶段4）：每 O 平台一份异构 xlsx 列模板
//   columns 定义 xlsx 的列顺序 + 每列值如何从 processedData item + 平台配置 算出
//   - value: 静态字面量（优先级/是否启用/OTAType 等）
//   - from(item, cfg): 动态从比价结果 item + 平台配置 cfg 取值
//   cfg.agentName / cfg.agentRemark 写入政策 Name / Remark 列（业务员信息）
// ============================================================
export const exportTemplate = {
  platform: 'trip',
  columns: [
    { key: 'Name',             from: (item, cfg) => `${cfg.agentName || '王宇'}_${item.H航司名}_携程/${item.C出发机场}-${item.D到达机场}` },
    { key: 'Remark',           from: (_item, cfg) => cfg.agentRemark || '王宇_出官网' },
    { key: '优先级',            value: '90' },
    { key: '是否启用',          value: 'TRUE' },
    { key: '航程类型',          value: null },
    { key: '航司匹配',          from: (item) => item.H航司名 },
    { key: '出发机场',          from: (item) => item.C出发机场 },
    { key: '到达机场',          from: (item) => item.D到达机场 },
    { key: '航班号',            value: null },
    { key: '舱位',              from: (item) => item.C舱位 },
    { key: '起飞时间Start',     value: null },
    { key: '起飞时间End',       value: null },
    { key: '去程时间匹配排除',   value: null },
    { key: '返程时间匹配排除',   value: null },
    { key: '班期',              value: null },
    { key: '销售时间Start',     value: null },
    { key: '销售时间End',       value: null },
    { key: '时间段匹配',        value: null },
    { key: '提前销售天数',       value: null },
    { key: '出票时长匹配',       value: null },
    { key: '儿童人数最小',       value: 0 },
    { key: '儿童人数最大',       value: 0 },
    { key: '成人人数最小',       value: 0 },
    { key: '成人人数最大',       value: 0 },
    { key: '乘客人数最小',       value: null },
    { key: '乘客人数最大',       value: null },
    { key: '数据有效期Start',   value: null },
    { key: '数据有效期End',     value: null },
    { key: '出发城市',          value: null },
    { key: '到达城市',          value: null },
    { key: '出发国家',          value: null },
    { key: '到达国家',          value: null },
    { key: '最低票面价',        value: null },
    { key: '最高票面价',        value: null },
    { key: '销售天数',          value: null },
    { key: '套餐索引v2',        value: null },
    { key: '座位数',            value: null },
    { key: '是否中转',          value: null },
    { key: '是否国内',          value: null },
    { key: 'OTAType',          value: '携程' },
    { key: 'OTAConfigID',      value: 11 },
    { key: '行程索引',          value: null },
    { key: '数据来源',          value: '爬虫' },
    { key: '政策代码',          value: null },
    { key: '爬虫名',            value: null },
    { key: '去程时间匹配',       value: null },
    { key: '返程时间匹配',       value: null },
    { key: '搜索出发城市',       value: null },
    { key: '搜索到达城市',       value: null },
    { key: '最长停留时间',       value: null },
    { key: '最短停留时间',       value: null },
    { key: '去程班期',          value: null },
    { key: '返程班期',          value: null },
    { key: '调价阶段',          value: '搜索' },
    { key: '调价增加百分比',     value: 0 },
    { key: '调价固定加减钱',     from: (item) => item.CUT_VALUE },
    { key: '儿童调价增加百分比', value: 0 },
    { key: '儿童调价固定加减钱', value: 0 },
    { key: '价格基础类型',       value: '总价' },
    { key: '市场',              value: null },
    { key: 'ID',                value: 0 }
  ]
}

export default {
  key, displayName, configSchema, defaults,
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate
}
