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
import { A2_FIELDS, A3_FIELDS, TRIP_RESPONSE_FIELDS, JXGJ_RESPONSE_FIELDS } from '../../fieldNames.js'
import { resolvePolicyField } from '../../policyFieldResolver.js'
import { formatPolicyAdjust } from '../../policyAdjust.js'

export const key = 'trip'
// 平台中文名：用于导出文件名（携程导入政策{日期}.xlsx / 携程底价检查{日期}.xlsx）和底价列名（携程底价）
export const displayName = '携程'
export { configSchema, defaults }

// ===== 请求写死参数（原 o1.js 硬编码在请求里的固定值，不作为配置项）=====
const REQUEST_CONST = {
  baseURL: 'https://intlresource-exchdata.ctrip.com/api/lowPriceSearch',
  timeout: 10000,
  language: 'zh_CN',
  tripType: 'OW',
  travelerCount: 1,
  childTravelerCount: 0,
  seatGrade: 'Y',
  channel: 'EnglishSite',
  subChannel: 0,
  specialParam: null//'SpecialSupply-特价产品'
}

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
    acquireChain: Promise.resolve(),  // 串行化 acquire 调用的 Promise chain
    listeners: new Set()              // 状态变化订阅者（请求放行 / 429 冷却触发时通知）
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  // 通知订阅者状态已变（通常是 pipeline 的实时推送回调；同步执行、订阅者极少，开销可忽略）
  function notify() {
    for (const fn of state.listeners) fn()
  }

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
    for (; ;) {
      const now = Date.now()
      pruneExpired(now)
      if (state.timestamps.length < limit) break
      // 窗口已满 → 等到最早时间戳滑出窗口（+10ms 避免抢刚过期那一瞬）
      const waitMs = state.timestamps[0] + RATE_LIMIT_WINDOW_MS - now + 10
      if (waitMs > 0) await sleep(waitMs)
    }

    // 3. 占一个位置（记录本次请求的时间戳）→ 立即通知（前端额度 +1 与请求发出时刻对齐）
    state.timestamps.push(Date.now())
    notify()
  }

  return {
    // 串行化的 acquire：所有调用排队执行，避免并发计数竞态
    //   state.acquireChain 用 .catch(() => {}) 吞错，保证 chain 永不 reject（否则后续 acquire 全卡）
    //   但返回的 next 保留错误，调用者能收到 acquireThunk 抛的异常
    acquire(rateLimitPerMin) {
      const next = state.acquireChain.then(() => acquireThunk(rateLimitPerMin))
      state.acquireChain = next.catch(() => { })
      return next
    },
    // 429 被动冷却：Retry-After 优先（携程返秒数），无则默认 30s
    //   Math.max 防止短 cooldown 覆盖长 cooldown（连续 429 时取最远到期时间）→ 立即通知
    cooldown(retryAfterSec) {
      const ms = Number(retryAfterSec) > 0 ? Number(retryAfterSec) * 1000 : DEFAULT_COOLDOWN_MS
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + ms)
      notify()
    },
    // 订阅状态变化（请求放行 / 429 冷却触发时回调）
    onChange(listener) {
      state.listeners.add(listener)
    },
    // 返回当前状态快照（只读，不发请求；供前端实时额度监控读取）
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

// 实时额度监控：供主进程读取当前限流状态（只读，不发请求）
//   返回 { windowCount, cooldownRemainingMs }，limit 阈值由调用方从 compiledConfigs 合并（保持"一条路径"）
export function getRateLimitState() {
  return _rateLimiter.snapshot()
}

// 订阅限流器状态变化：请求放行（额度 +1）或 429 冷却触发时回调
//   供 pipeline 事件驱动实时推送，数值与请求发出时刻对齐（无需等 1s 轮询）
export function onRateLimitChange(listener) {
  _rateLimiter.onChange(listener)
}

// ===== 内部 helper（从 o1.js 移植）=====
function buildSegments(data) {
  const CF_CITY = data.dateValue[0][A3_FIELDS.C出发城市]
  const DD_CITY = data.dateValue[0][A3_FIELDS.D到达城市]
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

function buildRequestBody(loginName, password, segments, validatingCarrier) {
  return {
    requestHeader: { requestID: randomUUID(), loginName, password, language: REQUEST_CONST.language },
    queryCondition: {
      tripType: REQUEST_CONST.tripType, validatingCarrier, segments,
      travelerCount: REQUEST_CONST.travelerCount, childTravelerCount: REQUEST_CONST.childTravelerCount,
      seatGrade: REQUEST_CONST.seatGrade, channel: REQUEST_CONST.channel, subChannel: REQUEST_CONST.subChannel,
      specialParam: REQUEST_CONST.specialParam
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
// ===== 行李归一化匹配（业务模式重构新增）=====
/**
 * 携程 prices[].baggage 存在两种格式，无法预知本次返回哪种：
 *   格式1：'BFN-JNB:成人:1件，每件20.0KG'   （带件数 + 单件重量）
 *   格式2：'成人:20KG'                      （只有重量，无件数 → 按单件 1 件处理）
 *   无托运：'BFN-JNB:成人:无免费托运行李额'
 * 业务口径：只匹配托运行李，手提不参与——字符串里含「手提」的分段先剔除再解析；
 *   剔除后为空（只有手提信息）→ 托运维度视为无托运（free）。
 * 解析成统一结构 { free, pieces, weight }；解析不出来返回 null（匹配不到就留空，不兜底）。
 */
function parseTripBaggage(str) {
  if (typeof str !== 'string' || !str.trim()) return null
  const s = str.trim()
  if (/无免费托运/.test(s)) return { free: true, pieces: 0, weight: null }
  // 只匹配托运：剔除含「手提」的分段后再做托运正则
  const checkedOnly = s.split(/[，,;；]/).filter(seg => seg && !/手提/.test(seg)).join('，')
  const m1 = checkedOnly.match(/(\d+)\s*件[，,]\s*每件\s*([\d.]+)\s*KG/i)
  if (m1) return { free: false, pieces: Number(m1[1]), weight: Number(m1[2]) }
  const m2 = checkedOnly.match(/成人[:：]\s*([\d.]+)\s*KG/i)
  if (m2) return { free: false, pieces: 1, weight: Number(m2[1]) }
  // 剔掉手提后没有任何托运信息 → 托运维度视为无托运
  return checkedOnly.trim() ? null : { free: true, pieces: 0, weight: null }
}

/**
 * 我方（jxgj 数据体/套餐项）行李签名：数 行李信息 里「托运」条目 → { free, pieces, weight }
 *   pieces = 托运条目数；weight = 单件重量（沿用老逻辑取最后一个托运条目的重量）
 *   只统计托运，手提不参与匹配（锦绣源数据为中文「托运」，兼容 '2' 写法）
 */
function parseOurBaggage(list) {
  if (!Array.isArray(list)) return null
  let pieces = 0, weight = null
  for (const x of list) {
    if (x && (x.类型 == '2' || x.类型 == '托运')) {//1手提、2托运；锦绣源数据为中文「托运」，兼容两种写法
      pieces++
      if (x.重量 != null) weight = Number(x.重量)
    }
  }
  return { free: pieces === 0, pieces, weight }
}

/**
 * 行李短文案（仅展示）：把 'AYT-HAJ:成人:1件，每件20.0KG' 压成 '1×20KG'
 *   无免费托运 → '无托运'；只有重量 → '20KG'；解析不出 → '—'（hover 看 title 原文）
 */
function formatBaggageShort(str) {
  const bag = parseTripBaggage(str)
  if (!bag) return '—'
  if (bag.free) return '无托运'
  const w = bag.weight == null ? '' : `${Number(bag.weight)}KG` // 20.0 → '20'
  return bag.pieces > 0 ? `${bag.pieces}×${w}` : w
}

/**
 * 政策调价金额写入规则见 @{link ../../policyAdjust.js}（政策文件与底价检查文件共用）：
 *   计算阶段（CUT_VALUE / 套餐差值）只保留精确价差、不含 −1；
 *   写入两个文件前统一「向下取整再 −1」（平台只接受整数）。
 */

/** 数字相等（20 与 20.0 视为相等），null/NaN 一律不匹配 */
function numEq(a, b) {
  if (a == null || b == null) return false
  const na = Number(a), nb = Number(b)
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb
}

/** 行李匹配（只比托运，手提不参与）：都无托运 → 匹配；否则件数相等且单件重量相等 */
function baggageMatchs(our, xc) {
  if (!our || !xc) return false
  if (our.free || xc.free) return our.free && xc.free
  return our.pieces === xc.pieces && numEq(our.weight, xc.weight)
}

/**
 * 匹配到的多条携程报价 → 按价格从低到高排序的有效报价清单（价格无效 ≤0 的剔除）
 *   业务规则（单个套餐可能匹配到多条携程外显报价）：
 *   先按价格升序排，再从最低价开始逐条比，第一个「我方底价 ≤ 其价」的报价命中
 *   —— 即"能比过的价格里最低的那条"；全部比不过 → 调用方走无价可打分支。
 *   ★ 携程价口径：一律向下取整（正常返回就是整数；万一非整数如 19.9 → 19），
 *     排序、比价、生效价 = 携程价(取整) − 1 均基于取整后的价格。
 * @param {Array} cands 已按行李等条件过滤后的携程报价
 * @returns {Array<{quote:object, price:number}>} 升序；空数组 = 无有效报价
 */
function sortedValidPrices(cands) {
  return (Array.isArray(cands) ? cands : [])
    .map(q => ({ quote: q, price: Math.floor(Number(q?.[TRIP_RESPONSE_FIELDS.sortIndicator])) }))
    .filter(x => x.quote && Number.isFinite(x.price) && x.price > 0)
    .sort((a, b) => a.price - b.price)
}

// 价格比较策略 price——Comparison——Policy
//   ★ matchSink（可选，仅展示用）：Map<携程报价对象, {outcome:'won'|'lost', cw, ourPrice, dijia}>
//     业务判定命中哪个报价对象（rowPrice）时，把判定结果挂到该对象引用上，
//     供 mergeResult 随后枚举「全部报价」时标注比赢/比输 —— 探针只记录、不参与任何判定，
//     processedData/CUT_VALUE/导出等业务结果与无探针时完全一致。
//   ★ mainRowEnabled（主行参与开关，来自政策字段配置，默认关闭）：
//     - 开启：主行参与比价（行级比价 → won/lost → 主行进入结果），现状行为
//     - 关闭：主行只作为套餐的公用信息来源（机场/城市/航班号/时间等）；
//       仅匹配到携程报价的套餐各生成一条结果行（公用信息继承主行，舱位用套餐
//       自己的，调价金额用该套餐差值），主行本身不参与比价、不进入结果
function priceComparisonPolicy(originalData, resData, matchSink = null, mainRowEnabled = false) {
  const resArr = []
  const forData = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  // flights用于查询检验，看是否查询错航数据，lowPrices是比价数据
  const flights = Array.isArray(resData?.responseBody?.flights) ? resData.responseBody.flights : []
  const lowPrices = Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : []
  const dateKey = originalData?.dateKey || 'unknown-date'

  // [debug] 一次性字段名采样：第一次进 priceComparisonPolicy 时输出 jxgj item / trip flights / lowPrices 的字段名

  if (!priceComparisonPolicy._sampled) {
    priceComparisonPolicy._sampled = true
    const sampleItem = forData[0] || {}//元数据
    const sampleFlight = flights[0] || {}//trip flights航班
    const sampleLp = lowPrices[0] || {}//trip lowPrices套餐
    const samplePrice = (sampleLp[TRIP_RESPONSE_FIELDS.prices] && sampleLp[TRIP_RESPONSE_FIELDS.prices][0]) || {}
    
  }

  let matchedFlights = 0//
  let matchedLowPrice = 0//
  let wonByPrice = 0
  let lostByPrice = 0  // 接口有低价但 dijia > sortIndicator（业务上比输了）

  forData.forEach(item => {
    // BUG-5 修复：增加 null/undefined 检查，避免 String(undefined)==='undefined' 误匹配
    //   任一字段为 null/undefined 时跳过该 item（不匹配）
    const itemFlightNo = item[A3_FIELDS.H航班号]//元数据航班号
    const itemDepAirport = item[A3_FIELDS.C出发机场]//元数据出发机场
    const itemArrAirport = item[A3_FIELDS.D到达机场]//元数据到达机场
    const itemDate = item[JXGJ_RESPONSE_FIELDS.C出发日期]//元数据出发日期
    const itemCangWei = item[A3_FIELDS.C舱位]

    // 判空弹出
    if (itemFlightNo == null || itemDepAirport == null || itemArrAirport == null || itemDate == null) {
      return
    }

    const flights_related = flights.find(f =>
      f &&
      f[TRIP_RESPONSE_FIELDS.flightNo] != null && f[TRIP_RESPONSE_FIELDS.departAirport] != null && f[TRIP_RESPONSE_FIELDS.arriveAirport] != null && f[TRIP_RESPONSE_FIELDS.takeOffDateTime] != null &&
      String(f[TRIP_RESPONSE_FIELDS.flightNo]) === String(itemFlightNo) &&
      String(f[TRIP_RESPONSE_FIELDS.departAirport]) === String(itemDepAirport) &&
      String(f[TRIP_RESPONSE_FIELDS.arriveAirport]) === String(itemArrAirport) &&
      String(f[TRIP_RESPONSE_FIELDS.takeOffDateTime].split(' ')[0]) === String(itemDate)
    )
    if (flights_related) matchedFlights++

    // ★ 收集与该 flightId 相关的全部携程套餐报价（prices 是平级套餐列表，可能分散在多个 lowPrices 组里）
    const relatedPrices = []
    if (flights_related?.[TRIP_RESPONSE_FIELDS.flightId] != null) {
      const fid = flights_related[TRIP_RESPONSE_FIELDS.flightId]
      for (const lp of lowPrices) {
        const refs = Array.isArray(lp?.[TRIP_RESPONSE_FIELDS.flightRefs]) ? lp[TRIP_RESPONSE_FIELDS.flightRefs] : []
        const hit = refs.some(ref => ref?.[TRIP_RESPONSE_FIELDS.flightId] === fid)
        if (!hit) continue
        const prices = Array.isArray(lp?.[TRIP_RESPONSE_FIELDS.prices]) ? lp[TRIP_RESPONSE_FIELDS.prices] : []
        for (const pr of prices) {
          if (pr) relatedPrices.push(pr)
        }
      }
    }

    // ===== 套餐富化（两种模式共用）：给每个套餐挂「携程底价 / 差值 / isOwn」 =====
    //   匹配只按行李，舱位不参与；无法匹配的套餐不打错误，只在套餐上补「套餐数据说明」属性
    const taocan = Array.isArray(item.套餐信息) ? item.套餐信息 : []
    for (const acai of taocan) {
      if (!acai || typeof acai !== 'object') continue
      const acaiSig = parseOurBaggage(acai.行李信息)
      if (!acaiSig) {
        acai['套餐数据说明'] = '套餐无行李信息，无法匹配携程报价'
        continue
      }
      const pkgCands = relatedPrices.filter(p =>
        p && baggageMatchs(acaiSig, parseTripBaggage(p[TRIP_RESPONSE_FIELDS.baggage]))
      )//&& !p[TRIP_RESPONSE_FIELDS.isOwn]
      if (pkgCands.length === 0) {
        acai['套餐数据说明'] = '未匹配到携程报价'
        continue
      }
      // ★ 多条匹配报价：按价格从低到高，取第一个「我方底价 ≤ 其价」的（能比过的价格里最低的）
      const ourFloor = Number(acai['我方底价'])
      const pkgHit = (Number.isFinite(ourFloor) && ourFloor > 0)
        ? sortedValidPrices(pkgCands).find(x => ourFloor <= x.price)
        : null
      if (!pkgHit) {
        acai['套餐数据说明'] = '匹配报价均低于我方底价，无可比过的价格'
        continue
      }
      const pkgPrice = pkgHit.quote
      acai['差值'] = ''
      acai['isOwn'] = pkgPrice[TRIP_RESPONSE_FIELDS.isOwn]
      acai['携程底价'] = pkgHit.price
      // 差值只保留精确价差（不含 −1），写入文件前由 policyAdjust 统一「向下取整再 −1」
      acai['差值'] = new Decimal(pkgHit.price).minus(acai['套餐价格_CNY']).toNumber()
      // ★ 套餐索引（政策导入文件「去程套餐索引v2」列来源，仅套餐政策行填）：
      //   锦绣套餐元素自带的「套餐索引」属性；缺失不报错 → 政策行该列留空 + 套餐补说明
      if (acai['套餐索引'] == null) {
        acai['套餐数据说明'] = (acai['套餐数据说明'] ? acai['套餐数据说明'] + '；' : '') + '套餐索引缺失'
      }
    }

    if (!mainRowEnabled) {
      // ===== 主行不参与（开关关闭）：匹配到携程报价的套餐各生成一条结果行 =====
      //   公用信息（机场/城市/航班号/时间等）继承主行；舱位用套餐自己的（无则用主行舱位）；
      //   调价金额 = 该套餐差值（写文件时再按截断-1规则取整）；未匹配套餐跳过
      for (const acai of taocan) {
        if (!acai || typeof acai !== 'object' || acai['携程底价'] == null) continue
        const entry = { ...acai }
        // ★ 去程套餐索引v2：值 = 该套餐自带的「套餐索引」（文本写入由导出模板统一转字符串）
        entry['去程套餐索引v2'] = acai['套餐索引']
        entry[A3_FIELDS.H航班号] = itemFlightNo
        entry[A3_FIELDS.H航司名] = item[A3_FIELDS.H航司名]
        entry[A3_FIELDS.C出发机场] = itemDepAirport
        entry[A3_FIELDS.D到达机场] = itemArrAirport
        entry[A3_FIELDS.C出发城市] = item[A3_FIELDS.C出发城市]
        entry[A3_FIELDS.D到达城市] = item[A3_FIELDS.D到达城市]
        entry[A3_FIELDS.C出发时间_Date] = item[A3_FIELDS.C出发时间_Date]
        entry[A3_FIELDS.D到达时间_Date] = item[A3_FIELDS.D到达时间_Date]
        entry[A3_FIELDS.C舱位] = (acai.舱位 != null && String(acai.舱位).trim() !== '') ? acai.舱位 : itemCangWei
        entry[A3_FIELDS.仓等] = acai.舱等 ?? item[A3_FIELDS.仓等]
        entry[A3_FIELDS.C成人总票价_CNY] = acai.套餐价格_CNY
        entry[A3_FIELDS.XC_dijia] = acai['携程底价']
        entry[A3_FIELDS.CUT_VALUE] = acai['差值']
        entry[A3_FIELDS.isOwn] = acai['isOwn']
        resArr.push(entry)
      }
      return
    }

    // ===== 主行参与（开关开启）：行级比价 =====
    //   匹配到多条携程报价时同套餐规则：按价格从低到高，命中的是第一个「我方底价 ≤ 其价」的报价
    //   （能比过的价格里最低的那条）；全部比不过 → lost（不贴底价卖、政策导入文件排除，
    //   底价检查文件展示参考全场最低有效报价）
    const rowSig = parseOurBaggage(item.行李信息)
    const dijia = Number(item[A2_FIELDS.dijia]) || 0
    const totalCNY = Number(item[A2_FIELDS.C成人总票价_CNY_INT]) || 0
    const rowCands = relatedPrices.filter(p =>
      p && !p[TRIP_RESPONSE_FIELDS.isOwn]
      && baggageMatchs(rowSig, parseTripBaggage(p[TRIP_RESPONSE_FIELDS.baggage]))
    )
    const sortedRow = sortedValidPrices(rowCands)
    const rowHit = dijia > 0 ? sortedRow.find(x => dijia <= x.price) : null
    const rowPrice = rowHit ? rowHit.quote : null
    const refPrice = sortedRow[0]?.quote ?? null
    const sortIndicator = rowHit ? rowHit.price : (sortedRow[0]?.price ?? NaN)
    const hasXcPrice = Number.isFinite(sortIndicator) && sortIndicator > 0
    if (rowPrice) matchedLowPrice++
    item[A3_FIELDS.isOwn] = rowPrice?.[TRIP_RESPONSE_FIELDS.isOwn]
    if (rowPrice) {
      wonByPrice++
      item[A3_FIELDS.XC_dijia] = sortIndicator
      // 比赢：打「可以胜出」标记
      item[A3_FIELDS._outcome] = 'won'
      resArr.push(item)
      // ★ 展示探针：记录业务判定实际命中的报价对象（不参与判定）；item=我方条目引用（基准行用）
      matchSink?.set(rowPrice, { outcome: 'won', cw: itemCangWei, ourPrice: totalCNY, dijia, item })
    } else if (hasXcPrice && dijia > 0) {
      lostByPrice++
      // 比输不再贴底价卖：打「无法胜出」标记并入队（仅作底价检查文件展示），
      //   不设调价金额；政策导入文件导出时排除 lost 行
      item[A3_FIELDS.XC_dijia] = sortIndicator // 全场最低有效报价，仅展示参考
      item[A3_FIELDS._outcome] = 'lost'
      resArr.push(item)
      // ★ 展示探针：记录业务判定实际命中的报价对象（不参与判定）；item=我方条目引用（基准行用）
      matchSink?.set(refPrice, { outcome: 'lost', cw: itemCangWei, ourPrice: totalCNY, dijia, item })
    }
    // ★ 调价固定加减钱（政策导入文件「调价固定加减钱」列 + 底价检查文件「预计减价」列，同源）：
    //   内存里保留精确价差（不含 −1），写入文件前由 policyAdjust 统一「向下取整再 −1」：
    //   仅 won（可以胜出）计算：价差 = 携程价(取整) − 官网显示价，写入后生效价 = 携程价(取整) − 1
    //   lost（无法胜出）不贴底价卖：CUT_VALUE 留空（底价检查文件「预计减价」为空）
    if (item[A3_FIELDS._outcome] === 'won') {
      item[A3_FIELDS.CUT_VALUE] = new Decimal(sortIndicator).minus(totalCNY || 0).toNumber()
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

/** 我方行李解析结果 → 短文案（诊断明细用，口径同携程侧 formatBaggageShort） */
function formatOurBaggageShort(sig) {
  if (!sig) return '—'
  if (sig.free) return '无托运'
  const w = sig.weight == null ? '' : `${Number(sig.weight)}KG`
  return sig.pieces > 0 ? `${sig.pieces}×${w}` : w
}

/** 组合航班号拆航段：'XQ9291-X0123' → ['XQ9291','X0123']（兼容 - – — / 分隔符） */
function splitCombinedFlightNo(v) {
  return String(v ?? '').split(/[-–—/]/).map(s => s.trim()).filter(Boolean)
}

/**
 * ★ 未匹配原因诊断（只用于 UI，绝不参与比价/导出）
 *
 * 对一条「他人报价且未被业务命中」的 price，按业务匹配链同款条件（见
 * priceComparisonPolicy 内 rowPrice 查找）逐级排查首个不通过的参数：
 *   flight  我方 dateValue 无此航班（航班号/出发/到达/日期 对不上）
 *   baggage 航班有，但行李件数/重量对不上（或我方缺行李信息）
 *   price   航班+行李全中却未入胜负分支（携程价无效 ≤0，或我方底价 dijia=0）
 *
 * 联程支持：携程 flights[] 按航段存放、flightRefs 挂多个航段；我方锦绣条目联程
 *   H航班号 为组合号（XQ9291-X0123）、机场为首起/末降。直飞走业务同款四元组全等，
 *   联程按「航段号序列一致 + 首起/末降/首段日期一致」判为同一行程。
 *
 * @param {Array<{no:string,dep:string,arr:string,date:string}>} segments 报价航段（按序）
 * @returns {{reason:string, detail:string}|null} 已匹配（won/lost）时返回 null
 */
/**
 * 按航段序列在我方数据中找同行程条目（直飞=业务同款四元组全等；联程=组合号航段序列+首起末降+日期）。
 * 供 diagnoseUnmatch（第 1 级）与 buildQuoteRows（锦绣官网基准行）共用，条件与业务匹配链一致。
 */
function findOurFlightRows(segments, forData) {
  if (!segments || segments.length === 0) return []
  const segNos = segments.map(s => s.no)
  const segDep = segments[0].dep
  const segArr = segments[segments.length - 1].arr
  const segDate = segments[0].date
  return forData.filter(it => {
    if (!it ||
      it[A3_FIELDS.H航班号] == null || it[A3_FIELDS.C出发机场] == null ||
      it[A3_FIELDS.D到达机场] == null || it[JXGJ_RESPONSE_FIELDS.C出发日期] == null) {
      return false
    }
    const oursNos = splitCombinedFlightNo(it[A3_FIELDS.H航班号])
    const sameAirports =
      String(it[A3_FIELDS.C出发机场]) === segDep &&
      String(it[A3_FIELDS.D到达机场]) === segArr &&
      String(it[JXGJ_RESPONSE_FIELDS.C出发日期]) === segDate
    if (!sameAirports || oursNos.length === 0) return false
    if (segments.length === 1 || oursNos.length === 1) {
      return oursNos[0] === segNos[0]
    }
    return oursNos.length === segNos.length && segNos.every((n, i) => oursNos[i] === n)
  })
}

function diagnoseUnmatch(p, segments, forData, F) {
  // 报价经 flightRefs 找不到任何航段（携程数据异常）：不是我方参数问题
  if (!segments || segments.length === 0) {
    return { reason: 'flight', detail: '携程报价未关联到航班（flightRefs/flights 数据异常）' }
  }
  const segNos = segments.map(s => s.no)
  const segDep = segments[0].dep
  const segArr = segments[segments.length - 1].arr
  const segDate = segments[0].date
  const itineraryLabel = `${segNos.join('-')} ${segDep}-${segArr}${segDate ? ' ' + segDate : ''}`

  // 第 1 级：航班身份（直飞=业务同款四元组全等；联程=组合号航段序列+首起末降+日期）
  const sameFlight = findOurFlightRows(segments, forData)
  if (sameFlight.length === 0) {
    // ★ 临时诊断（定位"无此航班"误判）：附我方前 3 条原始字段值，hover 标签即可核对
    const sample = forData.length === 0
      ? '（dateValue 为空，上游未传入我方数据）'
      : forData.slice(0, 3).map(it =>
          `[${it[A3_FIELDS.H航班号]}|${it[A3_FIELDS.C出发机场]}→${it[A3_FIELDS.D到达机场]}|${it[JXGJ_RESPONSE_FIELDS.C出发日期]}]`
        ).join(' ')
    return { reason: 'flight', detail: `我方数据无此航班：${itineraryLabel}；我方共${forData.length}条，样本：${sample}` }
  }

  // 第 2 级：行李（policy: parseOurBaggage(行李信息) vs parseTripBaggage(baggage)）
  const xcSig = parseTripBaggage(p[F.baggage])
  const bagHit = sameFlight.some(it => baggageMatchs(parseOurBaggage(it.行李信息), xcSig))
  if (!bagHit) {
    const oursBag = [...new Set(sameFlight.map(it => formatOurBaggageShort(parseOurBaggage(it.行李信息))))].join('/')
    return { reason: 'baggage', detail: `行李不符：携程 ${formatBaggageShort(p[F.baggage])}，我方 ${oursBag || '无行李信息'}` }
  }

  // 两关全过但 matchSink 无结果 → 胜负分支门槛（hasXcPrice 需携程价>0；won 另需 dijia>0）
  return { reason: 'price', detail: '航班/行李均匹配，但未进入胜负判定（携程价无效或我方底价为0）' }
}

/**
 * ★ 构建「携程全部报价」展示行（只用于 UI，绝不参与比价/导出）
 *
 * 枚举携程本次返回的 lowPrices[].prices[] 里的每一条报价，结合 flightRefs 还原航班信息，
 * 再用 matchSink（priceComparisonPolicy 业务判定时记录的 报价对象→胜负）逐条标注：
 *   won        业务判定命中且比赢（dijia ≤ 携程价）
 *   lost       业务判定命中但比输（dijia > 携程价，不贴底价卖、政策导入文件排除，底价检查文件展示）
 *   ownShown   携程侧 isOwn=true 且 showState=1（我方投放且在售卖平台外显）→ 绿
 *   ownHidden  携程侧 isOwn=true 但 showState≠1（我方投放未外显）→ 黄
 *   unmatched  其余他人报价（unmatchedReason 标出首个不通过的参数）→ 白
 *
 * 另：isInit = quantifyFlagRemark 含 initSelected（OTA 航班卡折叠栏展示的那一条）。
 *
 * 设计：胜负标签只从 matchSink 取（即业务循环里实际命中的那个对象引用），
 *   诊断函数只镜像匹配条件、不回写任何数据 → 展示口径与 processedData 业务结果天然一致。
 *
 * @param {object} resData      携程响应 JSON
 * @param {Map}    matchSink   Map<报价对象, {outcome,cw,ourPrice,dijia}>
 * @param {object} originalData O 任务数据（含 dateValue 我方条目，仅供未匹配诊断）
 * @returns {Array} quoteRows
 */
function buildQuoteRows(resData, matchSink, originalData) {
  const flights = Array.isArray(resData?.responseBody?.flights) ? resData.responseBody.flights : []
  const lowPrices = Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : []
  const forData = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  const F = TRIP_RESPONSE_FIELDS

  // flightId → 航班信息（一个报价可挂多个 flightRef，OW 单程通常 1 个）
  const flightById = new Map()
  for (const f of flights) {
    if (f?.[F.flightId] != null) flightById.set(f[F.flightId], f)
  }

  const rows = []
  for (const lp of lowPrices) {
    const refs = Array.isArray(lp?.[F.flightRefs]) ? lp[F.flightRefs] : []
    const prices = Array.isArray(lp?.[F.prices]) ? lp[F.prices] : []
    for (const p of prices) {
      if (!p) continue
      // 还原该报价关联的全部航段（flightRefs 顺序=航段顺序，按 flightId 去重）：
      //   直飞 1 段；联程多段（flights[] 按航段存放，如 XQ9291 AYT→ADB + X0123 ADB→WAW）
      const seenFid = new Set()
      const segments = []
      for (const r of refs) {
        const fid = r?.[F.flightId]
        if (fid == null || seenFid.has(fid)) continue
        const sf = flightById.get(fid)
        if (!sf) continue
        seenFid.add(fid)
        segments.push({
          no: String(sf[F.flightNo] ?? ''),
          dep: String(sf[F.departAirport] ?? ''),
          arr: String(sf[F.arriveAirport] ?? ''),
          date: sf[F.takeOffDateTime] ? String(sf[F.takeOffDateTime]).split(' ')[0] : ''
        })
      }
      // 展示用行程：组合航班号 XQ9291-X0123，机场取首起/末降（同携程 OTA）
      const flightNo = segments.length > 0 ? segments.map(s => s.no).join('-') : '—'
      const depAirport = segments[0]?.dep || '—'
      const arrAirport = segments[segments.length - 1]?.arr || '—'
      const takeOffDate = segments[0]?.date || '—'
      const sink = matchSink?.get(p) || null
      // 对比基准：必须与该报价 同航线+同航班 才允许对比，否则 null（不显示对比行）
      //   ① 业务命中（won/lost 探针记录的 item，已过航班/行李两关）
      //   ② findOurFlightRows 同行程（同机场+同日期+同航班号序列）条目（舱位不参与匹配）
      //   不再做"同机场忽略航班号"或 forData[0] 兜底——那会拿 XQ1350 去对比 XQ9159-XQ958
      const basisItem = sink?.item
        ?? findOurFlightRows(segments, forData)[0]
        ?? null
      const isOwn = !!p[F.isOwn]
      // showState===1：本条投价在售卖平台外显（见 ass/tjStats.js 语义）
      const shown = Number(p[F.showState]) === 1
      // OTA 航班卡展示标记：price 自身没有就取父 lowPrices
      const flagRemark = p[F.quantifyFlagRemark] ?? lp?.[F.quantifyFlagRemark] ?? ''
      const isInit = /initSelected/i.test(String(flagRemark))
      const status = sink?.outcome || (isOwn ? (shown ? 'ownShown' : 'ownHidden') : 'unmatched')
      rows.push({
        flightNo,
        date: takeOffDate,
        depAirport,
        arrAirport,
        seatClass: p[F.seatClass] ?? '—',
        sortIndicator: p[F.sortIndicator] ?? '—',
        baggage: p[F.baggage] ?? '',
        baggageShort: formatBaggageShort(p[F.baggage]),
        isOwn,
        shown,
        flagRemark: String(flagRemark ?? ''),
        isInit,
        // 状态：业务命中优先（won/lost，必为他人报价）；自有报价按外显与否拆分；其余未匹配
        status,
        // 未匹配诊断：首个不通过的参数（flight/baggage/price）+ 人话明细
        unmatchedReason: status === 'unmatched' ? diagnoseUnmatch(p, segments, forData, F) : null,
        matchedCabin: sink?.cw ?? '',      // 命中我方哪个舱位（won/lost 才有）
        ourPrice: sink?.ourPrice ?? null, // 我方官网价（won/lost 才有）
        ourFloor: sink?.dijia ?? null,    // 我方底价（won/lost 才有）
        // 锦绣官网基准行（同航班我方条目）：航班/航线/舱位/价格/底价/行李
        ourBasis: basisItem
          ? {
              flightNo: String(basisItem[A3_FIELDS.H航班号] ?? ''),
              route: `${basisItem[A3_FIELDS.C出发机场] ?? '—'}→${basisItem[A3_FIELDS.D到达机场] ?? '—'}`,
              cabin: String(basisItem[A3_FIELDS.C舱位] ?? '—'),
              price: basisItem[A2_FIELDS.C成人总票价_CNY_INT] ?? null,
              floor: basisItem[A2_FIELDS.dijia] ?? null,
              baggageShort: formatOurBaggageShort(parseOurBaggage(basisItem.行李信息))
            }
          : null
      })
    }
  }
  return rows
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
  const validatingCarrier = a2Item.dateValue[0][A3_FIELDS.H航司名] || ''
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

  const requestBody = buildRequestBody(loginName, password, segments, validatingCarrier)
  const gzippedBody = gzipSync(Buffer.from(JSON.stringify(requestBody), 'utf-8'))
  const rawResponse = await postGzip(REQUEST_CONST.baseURL, gzippedBody, REQUEST_CONST.timeout)

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
  // BUG-2 修复：检查 responseHeader.replyStatus（携程错误响应 Ack 可能仍=Success，但 replyStatus=ERROR）
  //   例如密码错误时 HTTP 200 + Ack=Success + replyStatus=ERROR + message="用户名或者密码不正确"
  //   不检查会导致错误被吞 → 任务标 completed → 148 个"成功"任务 processed=0
  const replyStatus = String(resData?.responseHeader?.replyStatus || '').toLowerCase()
  if (replyStatus && replyStatus !== 'success') {
    const errMsg = resData?.responseHeader?.message || `replyStatus=${replyStatus}`
    throw new Error(`O1平台业务错误：${errMsg}`)
  }
  // matchSink：业务比价时记录「实际命中的携程报价对象 → 比赢/比输」，供全量报价展示标注
  const matchSink = new Map()
  // 主行参与开关：来自政策字段配置快照（TaskManager.reloadRuntimeConfigs 注入），默认关闭
  const mainRowEnabled = _compiledConfig?.policyFields?.['主行参与'] === true
  const processedDataArr = priceComparisonPolicy(a2Item, resData, matchSink, mainRowEnabled)
  // 携程本次返回的全部报价条目（只用于 UI 展示，不参与比价/导出）
  const quoteRows = buildQuoteRows(resData, matchSink, a2Item)
  const flightCount = resData?.responseBody?.flights?.length || 0
  const lowPriceCount = resData?.responseBody?.lowPrices?.length || 0
  return {
    platform: 'trip', status: 'ok', code: rawResponse.statusCode,
    message: resData?.responseHeader?.message || 'success',
    payload: resData, originalData: a2Item || null,
    processedData: processedDataArr,
    // 全量报价展示：每行带 status（won/lost/own/unmatched），前端按状态着色不丢任何条目
    quoteRows,
    summary: {
      flightCount,
      lowPriceCount,
      quoteTotal: quoteRows.length,
      quoteWon: quoteRows.filter(r => r.status === 'won').length,
      quoteLost: quoteRows.filter(r => r.status === 'lost').length,
      quoteOwn: quoteRows.filter(r => r.status === 'ownShown' || r.status === 'ownHidden').length,
      quoteOwnShown: quoteRows.filter(r => r.status === 'ownShown').length,
      quoteOwnHidden: quoteRows.filter(r => r.status === 'ownHidden').length,
      quoteUnmatched: quoteRows.filter(r => r.status === 'unmatched').length
    },
    processedAt: new Date().toISOString()
  }
}

// ============================================================
// 导出模板（阶段4）：每 O 平台一份异构 xlsx 列模板
//   新格式 147 列（对齐 政导文件样例.xlsx 的表头与单元格数据类型）：
//     - 数字列（16 个，t:'n'）：Y优先级/OTAConfigID/数据有效期End/退票增加百分比/退票固定加减钱/
//       改签增加百分比/改签固定加减钱/调价增加百分比/调价固定加减钱/儿童调价增加百分比/
//       儿童调价固定加减钱/上浮百分比/上浮人民币/下浮百分比/下浮人民币/创建人id
//       （样例里 ID 也是数字列，但业务上不需要 → 留空）
//     - 其余全部为字符串；留空列写空字符串（t:'s' v:''，与样例一致，不用 null）
//   列值来源分四类：
//     A. 锦绣政策字段配置传入：from(item, ctx) 经 resolvePolicyField 解析 ${变量} 拼接
//        （11 个文本字段：Name/Remark/Y优先级/OTAConfigID/航程类型/数据有效期End/航司名/销售天数/座位数/爬虫名/创建人id；
//         其中 Y优先级/OTAConfigID/数据有效期End/创建人id 是数字列，配置字符串转 Number）
//     B. 对接旧格式字段：from(item) 取 a3 行字段
//        （机场航线匹配=出发机场-到达机场 / 舱位 / 调价固定加减钱=CUT_VALUE / UpdateTime=导出行生成时刻）
//     C. 固定值：value 写死（必填项按样例取值：是否启用=是 / 退改模式=不退不改 /
//        各标识=未设置 / 各百分比与加减钱=0 / 价格基础类型=总价 / 团体资质=正常票 /
//        是否包机产品=否 / 同程resouceCategory=普通资源 等）
//     D. 留空列：value:''（空字符串单元格；ID/CreateTime 也留空）
// ============================================================

// 锦绣配置列：ctx.policyFields[key] 用户配置值（含 ${变量}），导出时逐行解析
const pf = (key) => ({ from: (item, ctx) => resolvePolicyField(ctx?.policyFields?.[key], item) })
// 锦绣配置数字列：解析后的纯数字字符串转 Number（样例里这些列是数字类型）；空/非数字原样透传
const numPf = (key) => ({
  from: (item, ctx) => {
    const v = resolvePolicyField(ctx?.policyFields?.[key], item)
    if (v == null || v === '') return v
    const n = Number(v)
    return Number.isNaN(n) ? v : n
  }
})
// 留空列：空字符串单元格（与样例空值类型一致，t:'s' v:''）
const e = (key) => ({ key, value: '' })

/** UpdateTime 列：行生成时刻，格式 YYYY-MM-DD HH:mm:ss（样例里该列是字符串） */
function formatNow() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const exportTemplate = {
  platform: 'trip',
  columns: [
    // 1-2：锦绣配置
    { key: 'Name', ...pf('Name') },
    { key: 'Remark', ...pf('Remark') },
    // 3：固定值
    { key: '是否启用', value: '是' },
    // 4,7,8：锦绣配置（数字列）
    { key: 'Y优先级', ...numPf('Y优先级') },
    e('去程班期'), e('返程班期'),
    { key: 'OTAConfigID', ...numPf('OTAConfigID') },
    { key: '航程类型', ...pf('航程类型') },
    // 9-21：留空
    e('最长停留时间'), e('最短停留时间'),
    e('儿童人数最小'), e('儿童人数最大'),
    e('成人人数最小'), e('成人人数最大'),
    e('乘客人数最小'), e('乘客人数最大'),
    e('去程日期'), e('去程日期排除'), e('返程日期'), e('返程日期排除'),
    e('数据有效期Start'),
    // 22：锦绣配置（数字列）；23：锦绣配置
    { key: '数据有效期End', ...numPf('数据有效期End') },
    { key: '航司名', ...pf('航司名') },
    // 24：对接旧字段（出发机场-到达机场 拼接）
    { key: '机场航线匹配', from: (item) => `${item[A3_FIELDS.C出发机场]}-${item[A3_FIELDS.D到达机场]}` },
    // 25-33：留空
    e('机场航线排除'), e('城市航线匹配'), e('城市航线排除'),
    e('国家航线匹配'), e('国家航线排除'),
    e('去程航班号'), e('去程航班号排除'), e('返程航班号'), e('返程航班号排除'),
    // 34：对接旧字段（舱位）
    { key: '舱位', from: (item) => item[A3_FIELDS.C舱位] },
    // 35-48：留空
    e('舱等'), e('舱位排除'), e('舱等排除'),
    e('返程舱位'), e('返程舱等'), e('返程舱位排除'), e('返程舱等排除'),
    e('价格区间币种'), e('最低票面价'), e('最高票面价'),
    e('最低总价'), e('最高总价'), e('最低税价'), e('最高税价'),
    // 49,50：锦绣配置
    { key: '销售天数', ...pf('销售天数') },
    { key: '座位数', ...pf('座位数') },
    // 51-62：大部分留空（市场渠道/主渠道 也留空）
    e('是否中转'), e('是否国内'), e('是否共享'),
    e('适用共享航班号'), e('不适用共享航班号'),
    e('适用共享航司'), e('不适用共享航司'),
    // ★ 去程套餐索引v2（文本类型，仅套餐政策行有值）：值 = 锦绣套餐元素自带的「套餐索引」；
    //   主行政策行/索引缺失 → 留空；返程套餐索引v2 保持留空
    { key: '去程套餐索引v2', from: (item) => item['去程套餐索引v2'] != null ? String(item['去程套餐索引v2']) : '' },
    e('返程套餐索引v2'),
    e('政策代码'), e('市场渠道'), e('主渠道'),
    // 63：锦绣配置
    { key: '爬虫名', ...pf('爬虫名') },
    // 64-69：留空
    e('去程起飞时间'), e('返程起飞时间'),
    e('销售日期'), e('销售日期排除'), e('销售班期'), e('销售时间'),
    // 70：固定值
    { key: '退改模式', value: '不退不改' },
    // 71：留空
    e('币种'),
    // 72：固定值
    { key: '退票标识', value: '未设置' },
    // 73：留空
    e('退票规定'),
    // 74：固定值
    { key: '退税标识', value: '未设置' },
    // 75-77：留空
    e('不可退税金额'), e('退票备注'), e('可退税金额规定'),
    // 78：固定值
    { key: '部分退票标识', value: '未设置' },
    // 79-84：留空
    e('部分退票规定'), e('部分可退税金额规定'), e('部分未使用退票费收费方式'),
    e('改期标识'), e('改期备注'), e('改期规定'),
    // 85：固定值
    { key: '部分改期标识', value: '未设置' },
    // 86-88：留空
    e('部分改期规定'), e('改期费'), e('退票费'),
    // 89-92：固定值 0（数字）
    { key: '退票增加百分比', value: 0 },
    { key: '退票固定加减钱', value: 0 },
    { key: '改签增加百分比', value: 0 },
    { key: '改签固定加减钱', value: 0 },
    // 93-96：调价（固定 0 + CUT_VALUE 对接）
    { key: '调价增加百分比', value: 0 },
    // ★ 写入前统一「向下取整再 −1」（计算阶段保留精确价差，见 policyAdjust.js）
    { key: '调价固定加减钱', from: (item) => formatPolicyAdjust(item[A3_FIELDS.CUT_VALUE]) },
    { key: '儿童调价增加百分比', value: 0 },
    { key: '儿童调价固定加减钱', value: 0 },
    // 97-99：留空
    e('指定占比'), e('指定金额'), e('指定价格类型'),
    // 100：固定值
    { key: '价格基础类型', value: '总价' },
    // 101-104：固定值 0（数字）
    { key: '上浮百分比', value: 0 },
    { key: '上浮人民币', value: 0 },
    { key: '下浮百分比', value: 0 },
    { key: '下浮人民币', value: 0 },
    // 105-108：留空
    e('竞价价格基础类型'), e('竞价类型'), e('fareBasis'),
    e('旅客资质'),
    // 109：固定值
    { key: '团体资质', value: '正常票' },
    // 110-114：留空
    e('最小适用人数'), e('最大适用人数'), e('最小年龄'), e('最大年龄'),
    e('报销凭证'),
    // 115：固定值
    { key: '是否包机产品', value: '否' },
    // 116-117：留空
    e('出票时限'), e('运价类型'),
    // 118：运行时生成（行生成时刻，字符串）
    { key: 'UpdateTime', from: () => formatNow() },
    // 119：固定值
    { key: '同程resouceCategory', value: '普通资源' },
    // 120-135：留空
    e('同程是否需要证件'),
    e('去哪gdsType'), e('去哪posArea'), e('同程brandCode'),
    e('去哪产品类型'), e('去哪strategyProduct'), e('去哪是否官网出票'),
    e('同程visaLimitType'), e('同程visaLimit'),
    e('同程voidSupported'), e('同程voidRule'), e('同程platformAllow'),
    e('同程supportNations'), e('同程notSupportNations'),
    e('飞猪availableMarket'), e('飞猪nameLanguage'),
    // 136,137：固定值（字符串，与样例类型一致）
    { key: '去哪飞猪携程nationalityType', value: '2' },
    { key: '去哪飞猪携程nationality', value: 'TR' },
    // 138-144：留空
    e('飞猪gvChildRule'), e('携程planCategory'),
    e('携程penalties'), e('携程fareType'), e('携程tariffNo'),
    e('同程offsiteBid'), e('用户标识'),
    // 145：锦绣配置（数字列）
    { key: '创建人id', ...numPf('创建人id') },
    // 146-147：留空
    e('ID'),
    e('CreateTime')
  ]
}

/**
 * 账密验证：用最小化请求验证账密是否正确（添加/更新账号时调用）
 *   发 1 条 OW 单程请求（固定测试航线 BKK→HKT），只看 replyStatus/Ack
 *   不走限流器（验证是单次请求，不会触发 429）
 *   不走 mergeResult 的比价逻辑（只关心账密对不对）
 * @param {object} credential - { username, password }
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export async function verifyCredential(credential) {
  const loginName = credential?.username || ''
  const password = credential?.password || ''
  if (!loginName || !password) {
    return { success: false, message: '用户名和密码不能为空' }
  }
  // 最小测试请求：1 条 OW 单程，固定航线 BKK→HKT（文档示例航线）
  const segments = [{ segmentNo: 1, departCity: 'BKK', arriveCity: 'HKT', departDate: '2025-12-31' }]
  const requestBody = buildRequestBody(loginName, password, segments, '')
  let rawResponse
  try {
    const gzippedBody = gzipSync(Buffer.from(JSON.stringify(requestBody), 'utf-8'))
    rawResponse = await postGzip(REQUEST_CONST.baseURL, gzippedBody, REQUEST_CONST.timeout)
  } catch (err) {
    return { success: false, message: `网络请求失败：${err.message}` }
  }
  // 解析响应，只检查鉴权相关字段
  let bodyBuf = rawResponse.body
  const contentEncoding = String(rawResponse.headers['content-encoding'] || '').toLowerCase()
  if (contentEncoding.includes('gzip') && bodyBuf.length > 0) {
    try { bodyBuf = gunzipSync(bodyBuf) }
    catch (e) { return { success: false, message: `响应解压失败：${e.message}` } }
  }
  let resData
  try { resData = JSON.parse(bodyBuf.toString('utf-8')) }
  catch (e) { return { success: false, message: `响应解析失败：${e.message}` } }

  // 账密验证判定：只区分"账密错误"vs"正常业务响应"
  //   正常响应：Ack=Success + replyStatus ∈ {SUCCESS, NO_RESULT}
  //     - SUCCESS：有结果，账密正确
  //     - NO_RESULT：无匹配记录（如测试航线当天无航班），账密也正确
  //   账密错误：Ack≠Success 或 replyStatus=ERROR
  //     - 例如密码错误时 replyStatus=ERROR + message="用户名或者密码不正确"
  const ack = resData?.ResponseStatus?.Ack
  const replyStatus = resData?.responseHeader?.replyStatus
  const message = resData?.responseHeader?.message || resData?.ResponseStatus?.Errors?.[0]?.Message || ''

  if (rawResponse.statusCode === 429) {
    return { success: false, message: '触发限流（429），请稍后再试' }
  }
  if (rawResponse.statusCode < 200 || rawResponse.statusCode >= 300) {
    return { success: false, message: `HTTP ${rawResponse.statusCode}：${message}` }
  }
  if (ack && ack !== 'Success') {
    return { success: false, message: message || `Ack=${ack}` }
  }
  // replyStatus=ERROR 才是账密/业务错误；SUCCESS/NO_RESULT 都是正常（账密正确）
  if (replyStatus === 'ERROR') {
    return { success: false, message: message || `replyStatus=ERROR` }
  }
  // 账密正确（SUCCESS 有结果 / NO_RESULT 无航班，都是正常响应）
  return { success: true }
}

export default {
  key, displayName, configSchema, defaults,
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate, verifyCredential,
  getRateLimitState, onRateLimitChange
}
