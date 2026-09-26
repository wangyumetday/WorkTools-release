// TRIP（携程 OTA 低价看板）平台 adapter
// 移植自老 o1.js，拆为 prepareRequest / request / mergeResult 三步
// 语义：O 平台（步骤4），a2 → 该平台比价结果（processedData）
// 协议：Json + Gzip HTTPS POST（请求体压缩，响应解压）

import https from 'node:https'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { configSchema, defaults } from './config.js'
import { A2_FIELDS, A3_FIELDS, TRIP_RESPONSE_FIELDS, JXGJ_RESPONSE_FIELDS } from '../../fieldNames.js'
import { resolvePolicyField } from '../../policyFieldResolver.js'
import { formatPolicyAdjust } from '../../policyAdjust.js'
import { keepPolicyRow } from '../../policyWriteback.js'

export const key = 'trip'
// 平台中文名：用于导出文件名（携程导入政策{日期}.xlsx / 携程底价检查{日期}.xlsx）和底价列名（携程底价）
export const displayName = '携程'
export { configSchema, defaults }

// ===== 请求写死参数（原 o1.js 硬编码在请求里的固定值，不作为配置项）=====
// ★ channel 不在其中（2026-09-24 起）：渠道做成平台配置项（config.js schema），
//   实测我方未外显报价只在主渠道返回，EnglishSite 查不到 → 由用户配置，空值=不携带该字段
const REQUEST_CONST = {
  baseURL: 'https://intlresource-exchdata.ctrip.com/api/lowPriceSearch',
  timeout: 10000,
  language: 'zh_CN',
  tripType: 'OW',
  travelerCount: 1,
  childTravelerCount: 0,
  seatGrade: 'Y',
  subChannel: 0,
  specialParam: null//'SpecialSupply-特价产品'
}

/** TRIP 无公式编译，透传字符串配置 */
export const compileConfig = (raw = {}) => ({ ...raw })

/** 低价看板无需独立登录，请求头带账密即可，此处透传 */
export async function login(credential) {
  return { loginName: credential?.username || '', password: credential?.password || '' }
}

// 进程级滑动窗口限流器（携程专用，处理 rateLimitPerMin 阈值 + 429 被动冷却）
// 设计要点（对齐项目硬约束）：
//   1. 模块级单例：跨并发 worker 共享同一计数状态，保证准确计数
//   2. 滑动窗口：维护请求时间戳数组，避免固定窗口的边界尖峰（59s 末 200 + 0s 头 200 = 1s 400 的封号风险）
//   3. acquire 串行化：用 Promise chain 排队所有 acquire 调用，避免并发计数竞态
//   4. 429 被动冷却：服务端返 429 时进入 cooldown，Retry-After 优先，无则默认 30s
//   5. 配置快照：每次 acquire 从 compiledConfig.rateLimitPerMin 动态读取阈值
//      （TaskManager.precompilePlatformConfigs 编译后 cfg.rateLimitPerMin 即用户配置值）
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

function buildRequestBody(loginName, password, segments, validatingCarrier, channel = '') {
  const queryCondition = {
    tripType: REQUEST_CONST.tripType, validatingCarrier, segments,
    travelerCount: REQUEST_CONST.travelerCount, childTravelerCount: REQUEST_CONST.childTravelerCount,
    seatGrade: REQUEST_CONST.seatGrade, subChannel: REQUEST_CONST.subChannel,
    specialParam: REQUEST_CONST.specialParam
  }
  // ★ channel（2026-09-24 起配置化）：空值/不传 = 请求体不携带 channel 字段
  //   （实测携程按全量主渠道返回，含我方未外显报价；EnglishSite 渠道会查不到我方投放）
  if (channel) queryCondition.channel = channel
  return {
    requestHeader: { requestID: randomUUID(), loginName, password, language: REQUEST_CONST.language },
    queryCondition
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
 *   计算阶段（CUT_VALUE / 套餐差值）只保留精确价差、不含让利额；
 *   写入两个文件前统一「向下取整再 − cutOffset」（平台只接受整数）；
 *   cutOffset = 平台配置「比携程低多少元」（ctx.cutOffset，默认 1）。
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
/**
 * 共用套餐政策行构造（主行关闭/开启两模式复用）：
 *   {...acai} + 主行公用信息（航班/航司/机场/城市/时间）+ 去程套餐索引v2 + 航程类型 + 舱位 fallback
 * 命中行由调用方再补 XC_dijia / CUT_VALUE / isOwn；原价行再打 _原价政策=true（不写调价三字段）
 */
function buildPackagePolicyEntry(acai, item) {
  const itemFlightNo = item[A3_FIELDS.H航班号]
  const entry = { ...acai }
  // ★ 去程套餐索引v2：值 = 该套餐自带的「套餐索引」（文本写入由导出模板统一转字符串）
  entry['去程套餐索引v2'] = acai['套餐索引']
  // ★ 航程类型：中转=多程、直飞=单程（{...acai} 不含主行字段，须显式拷贝）
  entry['航程类型'] = item['航程类型']
  entry[A3_FIELDS.H航班号] = itemFlightNo
  entry[A3_FIELDS.H航司名] = item[A3_FIELDS.H航司名]
  entry[A3_FIELDS.C出发机场] = item[A3_FIELDS.C出发机场]
  entry[A3_FIELDS.D到达机场] = item[A3_FIELDS.D到达机场]
  entry[A3_FIELDS.C出发城市] = item[A3_FIELDS.C出发城市]
  entry[A3_FIELDS.D到达城市] = item[A3_FIELDS.D到达城市]
  entry[A3_FIELDS.C出发时间_Date] = item[A3_FIELDS.C出发时间_Date]
  entry[A3_FIELDS.D到达时间_Date] = item[A3_FIELDS.D到达时间_Date]
  entry[A3_FIELDS.C舱位] = (acai.舱位 != null && String(acai.舱位).trim() !== '') ? acai.舱位 : item[A3_FIELDS.C舱位]
  entry[A3_FIELDS.仓等] = acai.舱等 ?? item[A3_FIELDS.仓等]
  entry[A3_FIELDS.C成人总票价_CNY] = acai.套餐价格_CNY
  return entry
}

/**
 * 携程报价携带的成人品牌名列表（adtBrandNames）：归一 trim+大写，过滤 null/''/'-1' 等缺失形态
 * @param {object} q prices[] 报价条目
 * @returns {string[]}
 */
function quoteBrands(q) {
  const arr = q?.[TRIP_RESPONSE_FIELDS.adtBrandNames]
  return Array.isArray(arr)
    ? arr.map(b => String(b?.brandName ?? '').trim().toUpperCase()).filter(v => v && v !== '-1')
    : []
}

/** 携程报价品牌名展示串（原文，顿号连接；空 → 空串；只用于 UI/日志展示） */
function formatQuoteBrandNames(q) {
  const arr = q?.[TRIP_RESPONSE_FIELDS.adtBrandNames]
  if (!Array.isArray(arr)) return ''
  return arr.map(b => String(b?.brandName ?? '').trim()).filter(v => v && v !== '-1').join(', ')
}

/**
 * 品牌兼容：忽略大小写 + 前缀包含（任一方以另一方开头）
 *   样本口径：锦绣 SUNVALUE/SUNECOPLUS vs 携程 SunValue/SUNECO
 */
function brandCompatible(ourBrand, qBrands) {
  return qBrands.some(b => b === ourBrand || b.startsWith(ourBrand) || ourBrand.startsWith(b))
}

function priceComparisonPolicy(originalData, resData, matchSink = null, mainRowEnabled = false, consumedQuotes = null) {
  const resArr = []
  const forData = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  // flights用于查询检验，看是否查询错航数据，lowPrices是比价数据
  const flights = Array.isArray(resData?.responseBody?.flights) ? resData.responseBody.flights : []
  const lowPrices = Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : []
  const dateKey = originalData?.dateKey || 'unknown-date'
  const F = TRIP_RESPONSE_FIELDS

  // ★ 联程支持：预构建 flightById 与每条 lowPrice 的航段序列
  //   （航段号序列全等 + 首起末降 + 首段日期一致 才算同一行程；直飞=单段，走原四元组逻辑保持不变）
  const flightById = new Map()
  for (const f of flights) {
    if (f?.[F.flightId] != null) flightById.set(f[F.flightId], f)
  }
  const journeys = lowPrices.map(lp => ({
    lp,
    segments: journeySegmentsOf(flightById, lp?.[F.flightRefs])
  }))
  // 报价→其父级 lowPrices 的 quantifyFlagRemark（展示 isInit 用；price 自身优先、父级兜底）
  const priceParentRemark = new Map()
  for (const lp of lowPrices) {
    for (const pr of (Array.isArray(lp?.[F.prices]) ? lp[F.prices] : [])) {
      if (pr && !priceParentRemark.has(pr)) priceParentRemark.set(pr, lp?.[F.quantifyFlagRemark] ?? '')
    }
  }

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

    // ★ 防串态（2026-09-24）：同一 item 可能被重复 mergeResult 处理（任务重试/重复跑），
    //   先清掉上一次运行写下的比价结果字段，避免残留旧值（携程底价/命中/说明）参与本次判定
    item[A3_FIELDS.XC_dijia] = undefined
    item[A3_FIELDS.CUT_VALUE] = undefined
    item[A3_FIELDS.isOwn] = undefined
    item['_outcome'] = undefined
    item._hitQuote = undefined
    item._matchedQuotes = undefined

    // ★ 中转判定（数据驱动）：Z中转机场 三字码优先；否则取 分段信息 首段到达（段间机场）；
    //   分段信息 ≥2 段 或 组合航班号拆段 ≥2 → 视为中转（多程）
    const fenduan = Array.isArray(item['分段信息']) ? item['分段信息'] : []
    const myTransitCode = normalizeTransitCode(item['Z中转机场']) ?? normalizeTransitCode(fenduan[0]?.ap)
    const isTransit = fenduan.length >= 2 || splitCombinedFlightNo(itemFlightNo).length >= 2
    // 航程类型自动口径：中转=多程、直飞=单程（政策导入文件「航程类型」列；主行/套餐行共用）
    item['航程类型'] = isTransit ? '多程' : '单程'

    // ★ 收集与该行程相关的全部携程套餐报价（prices 是平级套餐列表，可能分散在多个 lowPrices 组里）
    //   直飞：沿用原四元组全等 + flightId 关联（结果与改造前一致）；
    //   中转/联程：航段号序列逐段全等（两端连接符归一）+ 中转三字码一致
    //     + 首起末降一致 + 首段日期一致（全部满足才算同一行程）
    const oursNos = splitCombinedFlightNo(itemFlightNo)
    const relatedPrices = []
    if (isTransit || oursNos.length >= 2) {
      for (const j of journeys) {
        const segs = j.segments
        // 连接符归一：携程单条组合号（XQ152-XQ4162）也拆成多段号再逐段比
        const flatNos = segs.flatMap(s => splitCombinedFlightNo(s.no))
        if (flatNos.length !== oursNos.length) continue
        if (!flatNos.every((n, i) => n === oursNos[i])) continue
        if (String(segs[0].dep) !== String(itemDepAirport)) continue
        if (String(segs[segs.length - 1].arr) !== String(itemArrAirport)) continue
        if (segs[0].date == null || String(segs[0].date) !== String(itemDate)) continue
        // 中转三字码校验（我方有码才校验）：多段旅程取首段到达（段间机场）；
        //   携程把多段坍缩进单 flightRef 时无法从航段边界取码 → 逐报价用 baggage 前缀兜底
        let segTransit = null
        if (myTransitCode) {
          if (segs.length >= 2) {
            segTransit = normalizeTransitCode(segs[0].arr)
            if (segTransit !== myTransitCode) continue
          }
        }
        matchedFlights++
        for (const pr of (Array.isArray(j.lp?.[F.prices]) ? j.lp[F.prices] : [])) {
          if (!pr) continue
          if (myTransitCode && segTransit == null && extractTripTransitCode(pr[F.baggage]) !== myTransitCode) continue
          relatedPrices.push(pr)
        }
      }
    } else {
      const flights_related = flights.find(f =>
        f &&
        f[F.flightNo] != null && f[F.departAirport] != null && f[F.arriveAirport] != null && f[F.takeOffDateTime] != null &&
        String(f[F.flightNo]) === String(itemFlightNo) &&
        String(f[F.departAirport]) === String(itemDepAirport) &&
        String(f[F.arriveAirport]) === String(itemArrAirport) &&
        String(f[F.takeOffDateTime].split(' ')[0]) === String(itemDate)
      )
      if (flights_related) matchedFlights++
      if (flights_related?.[F.flightId] != null) {
        const fid = flights_related[F.flightId]
        for (const lp of lowPrices) {
          const refs = Array.isArray(lp?.[F.flightRefs]) ? lp[F.flightRefs] : []
          const hit = refs.some(ref => ref?.[F.flightId] === fid)
          if (!hit) continue
          const prices = Array.isArray(lp?.[F.prices]) ? lp[F.prices] : []
          for (const pr of prices) {
            if (pr) relatedPrices.push(pr)
          }
        }
      }
    }

    // ===== 套餐分配（两种模式共用，2026-09-23 分配制）=====
    //   ① 品牌分配：带品牌的携程报价按品牌兼容（忽略大小写/前缀包含）分给对应套餐——
    //      须行李匹配；同品牌挂多个套餐时按行李细分（行李对上几个套餐就进几个组）
    //   ② 无品牌报价：按「价格最接近该套餐官网价（套餐价格_CNY）」+ 行李匹配分配给单个套餐
    //      （最近者得，距离相同时取先出现的套餐；无任何套餐行李匹配则不下发）
    //   ③ 品牌对不上：不进任何套餐组，标无匹配（不消费 → 落对比块附加行）
    //   ④ 回退老规则：套餐无品牌、或候选中没有任何带品牌报价 → 行李匹配即候选（不按品牌过滤）
    //   依次比价命中规则不变：候选按价升序，取第一个「我方底价 ≤ 携程价」的报价
    const taocan = Array.isArray(item.套餐信息) ? item.套餐信息 : []
    // 先收集各套餐的行李签名与品牌（无行李套餐直接贴说明跳过）
    const pkgInfos = []
    for (const acai of taocan) {
      if (!acai || typeof acai !== 'object') continue
      // ★ 防串态（2026-09-24）：与 item 级同款——清掉上次 mergeResult 残留的套餐比价字段
      acai['携程底价'] = undefined
      acai['差值'] = undefined
      acai['isOwn'] = undefined
      acai['套餐数据说明'] = undefined
      acai['showState'] = undefined
      acai['携程行李原文'] = undefined
      acai['flagRemark'] = undefined
      acai._hitQuote = undefined
      acai._matchedQuotes = undefined
      acai._compareCands = undefined
      const sig = parseOurBaggage(acai.行李信息)
      if (!sig) {
        acai['套餐数据说明'] = '套餐无行李信息，无法匹配携程报价'
        acai._matchedQuotes = [] // 展示用候选（无行李 → 空；原价判定依赖此字段）
        continue
      }
      const rawBrand = acai['品牌名']
      const ourBrand = (() => {
        if (rawBrand == null) return ''
        const s = String(rawBrand).trim().toUpperCase()
        return s === '-1' ? '' : s
      })()
      pkgInfos.push({ acai, sig, ourBrand, brandCands: [], priceAssigned: [] })
    }
    // ① 品牌分配（全局一轮分完）
    for (const p of relatedPrices) {
      if (!p) continue
      const qBrands = quoteBrands(p)
      if (qBrands.length === 0) continue // 无品牌报价留到第②步
      for (const info of pkgInfos) {
        if (!info.ourBrand) continue
        if (!brandCompatible(info.ourBrand, qBrands)) continue
        const xcSig = parseTripBaggage(p[F.baggage])
        if (xcSig && baggageMatchs(info.sig, xcSig)) info.brandCands.push(p)
      }
      // 没进任何套餐组 → 品牌对不上，不消费（buildQuoteRows 落附加行标无匹配）
    }
    // ② 无品牌报价价格最近邻分配
    for (const p of relatedPrices) {
      if (!p || quoteBrands(p).length > 0) continue
      const price = Math.floor(Number(p?.[F.sortIndicator]))
      if (!Number.isFinite(price) || price <= 0) continue
      let best = null
      let bestDiff = Infinity
      for (const info of pkgInfos) {
        const gw = Number(info.acai['套餐价格_CNY'])
        if (!Number.isFinite(gw)) continue
        const xcSig = parseTripBaggage(p[F.baggage])
        if (!xcSig || !baggageMatchs(info.sig, xcSig)) continue
        const diff = Math.abs(price - gw)
        if (diff < bestDiff) { bestDiff = diff; best = info }
      }
      if (best) best.priceAssigned.push(p)
    }
    // ③④ 逐套餐合成候选 + 依次比价命中
    for (const info of pkgInfos) {
      const acai = info.acai
      const baseCands = relatedPrices.filter(p =>
        p && baggageMatchs(info.sig, parseTripBaggage(p[F.baggage]))
      )
      let pkgCands
      if (info.ourBrand === '' || !baseCands.some(q => quoteBrands(q).length > 0)) {
        pkgCands = baseCands // ④ 回退老规则：行李匹配即候选
      } else {
        pkgCands = info.brandCands.concat(info.priceAssigned) // ①② 分配结果
      }
      // ★ 展示用候选：分配进本组的全部携程报价（含比不过的），分块展示的携程行来源
      acai._matchedQuotes = pkgCands
      // ★ 取值时机（2026-09-24）：我方投放标记必须在「比价候选剔除 isOwn」之前取——
      //   口径 = 本套餐匹配到的携程报价里是否存在我方投放（isOwn=true）；
      //   过滤之后取必然恒 false（命中报价永远是他人的），导出列会整列空
      acai['isOwn'] = pkgCands.some(p => p && p[F.isOwn])
      // ★ 我方报价自身的 showState（2026-09-26）：与 isOwn 同源（取 isOwn=true 那条报价），
      //   供底价检查文件「是否显示」列在 isOwn=true 时展示——避免与「命中外部报价 showState」混淆
      acai['ownShowState'] = acai['isOwn']
        ? (pkgCands.find(p => p && p[F.isOwn])?.[F.showState] ?? null)
        : null
      // ★ 展示消耗登记：分配进组的报价都被本单元「消费」，不再落附加行
      if (consumedQuotes) for (const c of pkgCands) consumedQuotes.add(c)
      if (pkgCands.length === 0) {
        acai['套餐数据说明'] = '未匹配到携程报价'
        continue
      }
      // ★ 官网数据不与自己的携程投放报价做比价（2026-09-24，与主行行级比价口径一致）：
      //   ① 剔除 isOwn（我方投放只展示、不参与比价）；
      //   ② 再剔除「未展示（showState≠1）的隐藏价」——只有公开竞对价才参与比价（2026-09-26 用户确认）。
      const compareCands = pkgCands.filter(p => p && !p[TRIP_RESPONSE_FIELDS.isOwn] && Number(p[TRIP_RESPONSE_FIELDS.showState]) === 1)
      acai._compareCands = compareCands
      if (compareCands.length === 0) {
        acai['套餐数据说明'] = '无已展示的外部报价可比价（仅有我方投放或仅未展示报价）'
        continue
      }
      // ★ 多条匹配报价：按价格从低到高，取第一个「我方底价 ≤ 其价」的（能比过的价格里最低的）
      const ourFloor = Number(acai['我方底价'])
      const pkgHit = (Number.isFinite(ourFloor) && ourFloor > 0)
        ? sortedValidPrices(compareCands).find(x => ourFloor <= x.price)
        : null
      if (!pkgHit) {
        acai['套餐数据说明'] = '匹配报价均低于我方底价，无可比过的价格'
        continue
      }
      const pkgPrice = pkgHit.quote
      acai['差值'] = ''
      acai['携程底价'] = pkgHit.price
      // 差值只保留精确价差（不含 cutOffset 让利额），写入文件前由 policyAdjust 统一「向下取整再 − cutOffset」
      acai['差值'] = new Decimal(pkgHit.price).minus(acai['套餐价格_CNY']).toNumber()
      // ★ 展示口径补充（套餐对套餐对比行用；只记录、不参与任何判定）：
      //   命中报价对象引用 / 行李原文 / 外显状态 / OTA 航班卡标记（price 自身优先、父级兜底）
      acai._hitQuote = pkgPrice
      acai['携程行李原文'] = pkgPrice[F.baggage] ?? ''
      acai.showState = pkgPrice[F.showState] ?? null
      acai.flagRemark = pkgPrice[F.quantifyFlagRemark] ?? priceParentRemark.get(pkgPrice) ?? ''
      // ★ 套餐索引（政策导入文件「去程套餐索引v2」列来源，仅套餐政策行填）：
      //   锦绣套餐元素自带的「套餐索引」属性；缺失不报错 → 政策行该列留空 + 套餐补说明
      if (acai['套餐索引'] == null) {
        acai['套餐数据说明'] = (acai['套餐数据说明'] ? acai['套餐数据说明'] + '；' : '') + '套餐索引缺失'
      }
    }

    if (!mainRowEnabled) {
      // ===== 主行不参与（开关关闭）：套餐级产出政策行 =====
      //   命中（有比得过的携程报价）→ 正常政策行（调价金额 = 该套餐差值）；
      //   真未匹配（无任何行李匹配报价，含无行李信息）→ 原价政策行（官网价、调价 0）；
      //   匹配到但全部低于底价（有候选无命中）→ 不产（维持现状）
      for (const acai of taocan) {
        if (!acai || typeof acai !== 'object') continue
        if (acai['携程底价'] == null) {
          const hasCands = (acai._compareCands ?? []).length > 0
          if (hasCands) continue // 低底价：有人投放但比不过 → 不产政策
          // ★ 原价政策：没人在携程投放此套餐 → 按官网价卖、调价固定加减钱=0
          const entry = buildPackagePolicyEntry(acai, item)
          entry['_原价政策'] = true
          resArr.push(entry)
          continue
        }
        const entry = buildPackagePolicyEntry(acai, item)
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
    const rowMatched = relatedPrices.filter(p =>
      p && baggageMatchs(rowSig, parseTripBaggage(p[TRIP_RESPONSE_FIELDS.baggage]))
    )
    // ★ 取值时机（2026-09-24）：我方投放标记在剔除 isOwn 之前取（口径 = 本行行李匹配到的
    //   携程报价里是否存在我方投放），过滤后取必然恒 false（命中报价永远是他人的）
    item[A3_FIELDS.isOwn] = rowMatched.some(p => p && p[TRIP_RESPONSE_FIELDS.isOwn])
    item['ownShowState'] = item[A3_FIELDS.isOwn]
      ? (rowMatched.find(p => p && p[TRIP_RESPONSE_FIELDS.isOwn])?.[TRIP_RESPONSE_FIELDS.showState] ?? null)
      : null
    const rowCands = rowMatched.filter(p => !p[TRIP_RESPONSE_FIELDS.isOwn])
    // ★ 展示消耗登记：主行行李匹配上的报价（含比不过的）都被本单元「消费」，不再落附加行
    if (consumedQuotes) for (const c of rowCands) consumedQuotes.add(c)
    // ★ 展示用候选：分块展示的主行单元携程行来源（全量，含未展示隐藏价）
    item._matchedQuotes = rowCands
    // ★ 比价候选：仅用「已展示（showState=1）」的外部报价；隐藏价(showState≠1)不作竞对（2026-09-26 用户确认）
    const rowCompareCands = rowCands.filter(p => Number(p[TRIP_RESPONSE_FIELDS.showState]) === 1)
    const sortedRow = sortedValidPrices(rowCompareCands)
    const rowHit = dijia > 0 ? sortedRow.find(x => dijia <= x.price) : null
    const rowPrice = rowHit ? rowHit.quote : null
    const refPrice = sortedRow[0]?.quote ?? null
    const sortIndicator = rowHit ? rowHit.price : (sortedRow[0]?.price ?? NaN)
    const hasXcPrice = Number.isFinite(sortIndicator) && sortIndicator > 0
    if (rowPrice) matchedLowPrice++
    if (rowPrice) {
      wonByPrice++
      item[A3_FIELDS.XC_dijia] = sortIndicator
      // 比赢：打「可以胜出」标记
      item[A3_FIELDS._outcome] = 'won'
      item._hitQuote = rowPrice // 展示口径：主行对比单元命中报价
      item[F.showState] = rowPrice?.[F.showState] ?? null // 是否显示列：命中的携程报价 showState
      resArr.push(item)
      // ★ 展示探针：记录业务判定实际命中的报价对象（不参与判定）；item=我方条目引用（基准行用）
      matchSink?.set(rowPrice, { outcome: 'won', cw: itemCangWei, ourPrice: totalCNY, dijia, item })
    } else if (hasXcPrice && dijia > 0) {
      lostByPrice++
      // 比输不再贴底价卖：打「无法胜出」标记并入队（仅作底价检查文件展示），
      //   不设调价金额；政策导入文件导出时排除 lost 行
      item[A3_FIELDS.XC_dijia] = sortIndicator // 全场最低有效报价，仅展示参考
      item[A3_FIELDS._outcome] = 'lost'
      item._hitQuote = refPrice // 展示口径：主行对比单元参考报价（全场最低）
      item[F.showState] = refPrice?.[F.showState] ?? null // 是否显示列：参考报价 showState
      resArr.push(item)
      // ★ 展示探针：记录业务判定实际命中的报价对象（不参与判定）；item=我方条目引用（基准行用）
      matchSink?.set(refPrice, { outcome: 'lost', cw: itemCangWei, ourPrice: totalCNY, dijia, item })
    }
    // ★ 调价固定加减钱（政策导入文件「调价固定加减钱」列 + 底价检查文件「预计减价」列，同源）：
    //   内存里保留精确价差（不含 cutOffset 让利额），写入文件前由 policyAdjust 统一「向下取整再 − cutOffset」：
    //   仅 won（可以胜出）计算：价差 = 携程价(取整) − 官网显示价，写入后生效价 = 携程价(取整) − cutOffset
    //   cutOffset = 平台配置「比携程低多少元」（ctx.cutOffset，默认 1）
    //   lost（无法胜出）不贴底价卖：CUT_VALUE 留空（底价检查文件「预计减价」为空）
    if (item[A3_FIELDS._outcome] === 'won') {
      item[A3_FIELDS.CUT_VALUE] = new Decimal(sortIndicator).minus(totalCNY || 0).toNumber()
    }
    // ★ 主行参与开启同样适用：真未匹配（无任何行李匹配报价）的套餐产「原价政策」行；
    //   命中套餐在开启模式下仍不产政策行（维持现状，仅底价检查展示）
    for (const acai of taocan) {
      if (!acai || typeof acai !== 'object') continue
      if (acai['携程底价'] != null) continue
      if ((acai._compareCands ?? []).length > 0) continue // 低底价不产
      const entry = buildPackagePolicyEntry(acai, item)
      entry['_原价政策'] = true
      resArr.push(entry)
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

/**
 * 组合航班号拆航段：'XQ9291-X0123' / 'XQ947,XQ7293' → ['XQ9291','X0123'] / ['XQ947','XQ7293']
 *   兼容 - – — / 与中英文逗号分隔符（锦绣联程 H航班号 常见 `,` 拼接；
 *   携程侧组合号或含其它连接符，两端都过这里归一，避免连接符差异导致匹配不上）
 */
function splitCombinedFlightNo(v) {
  return String(v ?? '').split(/[-–—/，,]/).map(s => s.trim()).filter(Boolean)
}

/**
 * 中转三字码归一：trim + 大写 + 严格三字码（单中转点口径），否则 null
 */
function normalizeTransitCode(v) {
  const s = String(v ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(s) ? s : null
}

/**
 * 携程中转报价 baggage 前缀提中转码：'AYT-STR-LON:成人:20.0KG' → 'STR'
 *   （到达位容忍 3-4 字母，兼容城市码 LON；取不到返回 null）
 */
function extractTripTransitCode(baggage) {
  const m = String(baggage ?? '').match(/^([A-Z]{3})-([A-Z]{3})-([A-Z]{3,4}):/)
  return m ? m[2].toUpperCase() : null
}

/**
 * 携程侧行程还原：按 flightRefs 顺序（航段顺序）还原一条 lowPrice 对应报价的全部航段
 *   （flights[] 按航段存放：直飞 1 段、联程多段；与诊断/展示共用同一口径）
 * @returns {Array<{no:string, dep:string, arr:string, date:string}>} 按序航段；引用缺失时跳过
 */
function journeySegmentsOf(flightById, refs) {
  const seenFid = new Set()
  const segments = []
  for (const r of Array.isArray(refs) ? refs : []) {
    const fid = r?.[TRIP_RESPONSE_FIELDS.flightId]
    if (fid == null || seenFid.has(fid)) continue
    const sf = flightById.get(fid)
    if (!sf) continue
    seenFid.add(fid)
    segments.push({
      no: String(sf[TRIP_RESPONSE_FIELDS.flightNo] ?? ''),
      dep: String(sf[TRIP_RESPONSE_FIELDS.departAirport] ?? ''),
      arr: String(sf[TRIP_RESPONSE_FIELDS.arriveAirport] ?? ''),
      depCity: String(sf[TRIP_RESPONSE_FIELDS.departCity] ?? ''),
      arrCity: String(sf[TRIP_RESPONSE_FIELDS.arriveCity] ?? ''),
      takeOffDateTime: sf[TRIP_RESPONSE_FIELDS.takeOffDateTime] ? String(sf[TRIP_RESPONSE_FIELDS.takeOffDateTime]) : '',
      arriveDateTime: sf[TRIP_RESPONSE_FIELDS.arriveDateTime] ? String(sf[TRIP_RESPONSE_FIELDS.arriveDateTime]) : '',
      date: sf[TRIP_RESPONSE_FIELDS.takeOffDateTime] ? String(sf[TRIP_RESPONSE_FIELDS.takeOffDateTime]).split(' ')[0] : ''
    })
  }
  return segments
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

/**
 * ★ 构建「套餐对套餐」对比行（只用于 UI，绝不参与比价/导出）
 *
 * 我方驱动：遍历 dateValue 每个锦绣条目 →
 *   · 主行参与开启：主行作为一个对比单元（行级行李/行级底价）；
 *   · 逐套餐对比单元：套餐行李 vs 携程按行李额分的报价（prices[]）。
 * 单元行 = 我方信息（舱位/行李/官网价/底价）+ 命中的携程报价 + 判定：
 *   won=命中且可比过（携程价 ≥ 我方底价）；lost=匹配到但均低于底价；
 *   unmatched=未匹配到携程报价/套餐无行李信息。
 * 收尾：枚举携程全部报价，未被任何对比单元「消费」（consumedQuotes）的 → 附加行
 *   kind='other'（标「无对应」，reason=flight 无此航班 / baggage 无对应套餐）；
 *   我方投放（isOwn）报价仍按外显/未显展示。
 * 主行参与关闭（默认）时主行不参与对比、不产生主行单元行。
 *
 * @param {object} resData       携程响应 JSON
 * @param {Map}    matchSink     主行胜负探针（Map<报价对象,{outcome,...}>，仅主行模式有记录）
 * @param {object} originalData  O 任务数据（含 dateValue 我方条目）
 * @param {boolean} mainRowEnabled 主行参与开关
 * @param {Set}    consumedQuotes  已被对比单元消费的报价对象集合
 * @returns {Array} quoteRows
 */
function buildQuoteRows(resData, _matchSink, originalData, mainRowEnabled = false, consumedQuotes = null) {
  const flights = Array.isArray(resData?.responseBody?.flights) ? resData.responseBody.flights : []
  const lowPrices = Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : []
  const forData = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  const F = TRIP_RESPONSE_FIELDS

  // flightId → 航班信息（一个报价可挂多个 flightRef，OW 单程通常 1 个）
  const flightById = new Map()
  for (const f of flights) {
    if (f?.[F.flightId] != null) flightById.set(f[F.flightId], f)
  }
  // 报价→其父级 lowPrices（isInit 标记的父级兜底 + 携程自身航班信息溯源）
  const priceParentRemark = new Map()
  const priceToLp = new Map()
  for (const lp of lowPrices) {
    for (const pr of (Array.isArray(lp?.[F.prices]) ? lp[F.prices] : [])) {
      if (pr && !priceParentRemark.has(pr)) priceParentRemark.set(pr, lp?.[F.quantifyFlagRemark] ?? '')
      if (pr && !priceToLp.has(pr)) priceToLp.set(pr, lp)
    }
  }

  const rows = []

  // ★ 对比单元分块产出：官方行（role=official，我方数据+总体判定）+ 逐条携程行（role=ctrip，
  //   该单元行李匹配到的全部携程报价：能比过的 won / 比不过的 lost / 我方投放 own 态）
  const emitUnit = (base, unit) => {
    const { kind, seatClass, cabinClass, pkgIndex, ourBaggageShort, ourPrice, ourFloor, status, unmatchedReason, note, matched, hitQuote, ourBrand, official } = unit
    const unitKey = `${base.flightNo}|${base.date}|${base.depAirport}|${base.arrAirport}|${kind}|${seatClass}|${pkgIndex ?? ''}`
    rows.push({
      ...base,
      role: 'official',
      unitKey,
      kind,
      seatClass,
      cabinClass,
      pkgIndex,
      ourBaggageShort,
      // ★ 我方套餐品牌名（2026-09-23 起）：UI/日志在行李信息后展示；主行无品牌 → 空串
      ourBrand: ourBrand ?? '',
      ourPrice,
      ourFloor,
      // ★ 锦绣官网字段（2026-09-26 起）：底价检查文件官网行从这些取值
      depCity: official?.depCity ?? '',
      arrCity: official?.arrCity ?? '',
      airlineName: official?.airlineName ?? '',
      depTime: official?.depTime ?? '',
      arrTime: official?.arrTime ?? '',
      floorMeta: official?.floorMeta ?? null,
      xcPrice: null,
      xcBaggage: '',
      xcBaggageShort: '—',
      isOwn: false,
      shown: false,
      flagRemark: '',
      isInit: false,
      isHit: false,
      status,
      unmatchedReason,
      note
    })
    const floorN = Number(ourFloor)
    for (const q of (Array.isArray(matched) ? matched : [])) {
      if (!q) continue
      const rawPrice = Number(q[F.sortIndicator])
      const qPrice = Number.isFinite(rawPrice) ? Math.floor(rawPrice) : null
      const isOwn = !!q[F.isOwn]
      const shown = Number(q[F.showState]) === 1
      const flagRemark = q[F.quantifyFlagRemark] ?? priceParentRemark.get(q) ?? ''
      // 携程行判定：我方投放按外显/未显；他人报价按能否比过（≥ 我方底价 = 能赢）
      const qStatus = isOwn
        ? (shown ? 'ownShown' : 'ownHidden')
        : (Number.isFinite(floorN) && floorN > 0 && qPrice != null && qPrice >= floorN ? 'won' : 'lost')
      // ★ 携程自身航班信息（2026-09-26 起）：底价检查文件携程行用携程自己的航班/城市/时间/舱位
      const lp = priceToLp.get(q)
      const segs = journeySegmentsOf(flightById, lp?.[F.flightRefs])
      const s0 = segs[0] || {}
      const sN = segs[segs.length - 1] || {}
      rows.push({
        ...base,
        role: 'ctrip',
        unitKey,
        kind,
        seatClass: '—',
        cabinClass: '—',
        pkgIndex: null,
        ourBaggageShort: '—',
        ourPrice: null,
        ourFloor: null,
        xcPrice: qPrice,
        xcBaggage: q[F.baggage] ?? '',
        xcBaggageShort: formatBaggageShort(q[F.baggage]),
        // ★ 携程报价品牌名（2026-09-23 起）：UI/日志在行李信息后展示
        xcBrand: formatQuoteBrandNames(q),
        // 携程自身航班/舱位/城市/时间（底价检查文件携程行数据源）
        xcFlightNo: segs.map(s => s.no).filter(Boolean).join('-'),
        xcSeatClass: q[F.seatClass] != null ? String(q[F.seatClass]) : '',
        xcDepAirport: s0.dep ?? '',
        xcArrAirport: sN.arr ?? '',
        xcDepCity: s0.depCity ?? '',
        xcArrCity: sN.arrCity ?? '',
        xcTakeOffDateTime: s0.takeOffDateTime ?? '',
        xcArriveDateTime: sN.arriveDateTime ?? '',
        isOwn,
        shown,
        showState: q[F.showState] ?? null,
        flagRemark: String(flagRemark ?? ''),
        isInit: /initSelected/i.test(String(flagRemark ?? '')),
        // ★ 实际命中标记（2026-09-23 起）：依次比价中真实比赢的那一条（我方底价≤其价的最低报价），
        //   供 UI 对比块「匹配结果」用醒目实样式展示；其余携程行虚浅
        isHit: !!hitQuote && q === hitQuote,
        status: qStatus,
        unmatchedReason: null,
        note: ''
      })
    }
  }

  // ===== 我方对比单元 =====
  for (const item of forData) {
    if (!item || item[A3_FIELDS.H航班号] == null) continue
    const itemDate = item[JXGJ_RESPONSE_FIELDS.C出发日期]
    const base = {
      kind: null,
      flightNo: String(item[A3_FIELDS.H航班号] ?? ''),
      date: itemDate != null ? String(itemDate) : '—',
      depAirport: String(item[A3_FIELDS.C出发机场] ?? '—'),
      arrAirport: String(item[A3_FIELDS.D到达机场] ?? '—')
    }

    // 主行对比单元（仅开启时）
    if (mainRowEnabled) {
      const outcome = item[A3_FIELDS._outcome] // won/lost/undefined
      emitUnit(base, {
        kind: 'main',
        seatClass: String(item[A3_FIELDS.C舱位] ?? '—'),
        cabinClass: item[A3_FIELDS.仓等] != null ? String(item[A3_FIELDS.仓等]) : '—',
        pkgIndex: null,
        ourBaggageShort: formatOurBaggageShort(parseOurBaggage(item.行李信息)),
        ourPrice: item[A2_FIELDS.C成人总票价_CNY_INT] ?? null,
        ourFloor: item[A2_FIELDS.dijia] ?? null,
        status: outcome || 'unmatched',
        unmatchedReason: outcome
          ? null
          : { reason: 'price', detail: '未进入胜负判定（携程价无效或我方底价为0）' },
        note: '',
        matched: item._matchedQuotes ?? [],
        // 主行命中报价（仅 won 时是真实命中；lost 时 _hitQuote 为全场最低参考价，不点亮）
        hitQuote: outcome === 'won' ? (item._hitQuote || null) : null,
        ourBrand: '', // 主行无品牌（品牌只属于套餐）
        official: {
          depCity: item[A3_FIELDS.C出发城市] ?? '',
          arrCity: item[A3_FIELDS.D到达城市] ?? '',
          airlineName: item[A3_FIELDS.H航司名] ?? '',
          depTime: item[A3_FIELDS.C出发时间_Date] ?? '',
          arrTime: item[A3_FIELDS.D到达时间_Date] ?? '',
          floorMeta: item[A3_FIELDS._floorMeta] ?? null
        }
      })
    }

    // 套餐对比单元
    const taocan = Array.isArray(item.套餐信息) ? item.套餐信息 : []
    for (const acai of taocan) {
      if (!acai || typeof acai !== 'object') continue
      const hit = acai._hitQuote || null
      const note0 = acai['套餐数据说明'] || ''
      const isBelowFloor = /低于我方底价|无可比过的价格/.test(note0)
      // ★ own-only（2026-09-24）：分配组里只有我方投放报价、无外部报价 → 未匹配原因标「仅我方投放」
      const ownOnly = Array.isArray(acai._compareCands) && acai._compareCands.length === 0
        && (acai._matchedQuotes ?? []).length > 0
      let status = 'unmatched'
      if (hit) status = 'won'
      else if (isBelowFloor) status = 'lost'
      let unmatchedReason = null
      let note = note0
      if (!hit && !isBelowFloor) {
        unmatchedReason = ownOnly
          ? { reason: 'own', detail: note0 }
          : (/无行李信息/.test(note0)
            ? { reason: 'baggage', detail: note0 }
            : { reason: 'flight', detail: note0 || '未匹配到携程报价' })
        // ★ 无人投放 → 将产出原价政策
        note = note0 ? `${note0}；将产出原价政策` : '将产出原价政策'
      }
      emitUnit(base, {
        kind: 'package',
        seatClass: (acai.舱位 != null && String(acai.舱位).trim() !== '') ? String(acai.舱位) : String(item[A3_FIELDS.C舱位] ?? '—'),
        cabinClass: acai.舱等 != null ? String(acai.舱等) : (item[A3_FIELDS.仓等] != null ? String(item[A3_FIELDS.仓等]) : '—'),
        pkgIndex: acai['套餐索引'] ?? null,
        ourBaggageShort: formatOurBaggageShort(parseOurBaggage(acai.行李信息)),
        ourPrice: acai['套餐价格_CNY'] ?? null,
        ourFloor: acai['我方底价'] ?? null,
        status,
        unmatchedReason,
        note,
        matched: acai._matchedQuotes ?? [],
        hitQuote: hit, // 仅 won 有值（比赢那一条被点亮）
        ourBrand: acai['品牌名'] ?? '',
        official: {
          depCity: item[A3_FIELDS.C出发城市] ?? '',
          arrCity: item[A3_FIELDS.D到达城市] ?? '',
          airlineName: item[A3_FIELDS.H航司名] ?? '',
          depTime: item[A3_FIELDS.C出发时间_Date] ?? '',
          arrTime: item[A3_FIELDS.D到达时间_Date] ?? '',
          floorMeta: acai['_floorMeta'] ?? null
        }
      })
    }
  }

  // ===== 附加行：未被任何对比单元消费的携程报价 =====
  for (const lp of lowPrices) {
    const refs = Array.isArray(lp?.[F.flightRefs]) ? lp[F.flightRefs] : []
    const segments = journeySegmentsOf(flightById, refs)
    const prices = Array.isArray(lp?.[F.prices]) ? lp[F.prices] : []
    for (const p of prices) {
      if (!p) continue
      if (consumedQuotes?.has(p)) continue
      const isOwn = !!p[F.isOwn]
      const shown = Number(p[F.showState]) === 1
      const flagRemark = p[F.quantifyFlagRemark] ?? lp?.[F.quantifyFlagRemark] ?? ''
      let unmatchedReason = null
      if (!isOwn) {
        if (segments.length === 0) {
          unmatchedReason = { reason: 'flight', detail: '携程报价未关联到航班（flightRefs/flights 数据异常）' }
        } else {
          const itineraryLabel = `${segments.map(s => s.no).join('-')} ${segments[0].dep}-${segments[segments.length - 1].arr} ${segments[0].date || ''}`.trim()
          const sameFlight = findOurFlightRows(segments, forData)
          unmatchedReason = sameFlight.length === 0
            ? { reason: 'flight', detail: `我方数据无此航班：${itineraryLabel}` }
            : { reason: 'baggage', detail: `无对应套餐：携程 ${formatBaggageShort(p[F.baggage]) || '—'}` }
        }
      }
      rows.push({
        role: 'other',
        unitKey: `${segments.length > 0 ? segments.map(s => s.no).join('-') : '—'}|${segments[0]?.date || '—'}|${segments[0]?.dep || '—'}|${segments[segments.length - 1]?.arr || '—'}|other`,
        kind: 'other',
        flightNo: segments.length > 0 ? segments.map(s => s.no).join('-') : '—',
        date: segments[0]?.date || '—',
        depAirport: segments[0]?.dep || '—',
        arrAirport: segments[segments.length - 1]?.arr || '—',
        seatClass: p[F.seatClass] ?? '—',
        cabinClass: '—',
        pkgIndex: null,
        ourBaggageShort: '—',
        ourPrice: null,
        ourFloor: null,
        xcPrice: p[F.sortIndicator] ?? null,
        xcBaggage: p[F.baggage] ?? '',
        xcBaggageShort: formatBaggageShort(p[F.baggage]),
        xcBrand: formatQuoteBrandNames(p),
        // 携程自身航班/舱位/城市/时间（底价检查文件携程行数据源，与匹配行同口径）
        xcFlightNo: segments.length > 0 ? segments.map(s => s.no).filter(Boolean).join('-') : '',
        xcSeatClass: p[F.seatClass] != null ? String(p[F.seatClass]) : '',
        xcDepAirport: segments[0]?.dep ?? '',
        xcArrAirport: segments[segments.length - 1]?.arr ?? '',
        xcDepCity: segments[0]?.depCity ?? '',
        xcArrCity: segments[segments.length - 1]?.arrCity ?? '',
        xcTakeOffDateTime: segments[0]?.takeOffDateTime ?? '',
        xcArriveDateTime: segments[segments.length - 1]?.arriveDateTime ?? '',
        isOwn,
        shown,
        showState: p[F.showState] ?? null,
        flagRemark: String(flagRemark ?? ''),
        isInit: /initSelected/i.test(String(flagRemark ?? '')),
        status: isOwn ? (shown ? 'ownShown' : 'ownHidden') : 'other',
        unmatchedReason,
        note: ''
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

  const requestBody = buildRequestBody(loginName, password, segments, validatingCarrier, cfg.channel)
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
  // ===== 取值时机（2026-09-24）：原始层统计 =====
  //   响应一到手（解压/解析/校验通过）立刻统计，只依赖携程原始响应
  //   （flights / lowPrices / prices 及其 isOwn、showState），与比价、行李匹配、候选过滤全无关系；
  //   放最前面，保证不被后续任何一步流程（剔除 isOwn、命中判定）影响。
  //   口径：含 isOwn 的全部报价平铺（胜利率分母/分子同源）
  const flightCount = resData?.responseBody?.flights?.length || 0
  const lowPriceCount = resData?.responseBody?.lowPrices?.length || 0
  const allPrices = []
  for (const lp of (Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : [])) {
    for (const pr of (Array.isArray(lp?.prices) ? lp.prices : [])) {
      if (pr) allPrices.push(pr)
    }
  }
  const ownPrices = allPrices.filter(p => p.isOwn)
  const quoteTotal = allPrices.length
  const quoteOwn = ownPrices.length
  const quoteOwnShown = ownPrices.filter(p => Number(p.showState) === 1).length
  const quoteOwnHidden = ownPrices.filter(p => Number(p.showState) !== 1).length

  // matchSink：主行参与开启时记录「实际命中的携程报价对象 → 比赢/比输」（展示探针，不参与判定）
  const matchSink = new Map()
  // consumedQuotes：已被对比单元（套餐/主行）行李匹配消费的报价对象（剩余落附加行）
  const consumedQuotes = new Set()
  // 主行参与开关：来自政策字段配置快照（TaskManager.reloadRuntimeConfigs 注入），默认关闭
  const mainRowEnabled = _compiledConfig?.policyFields?.['主行参与'] === true
  const processedDataArr = priceComparisonPolicy(a2Item, resData, matchSink, mainRowEnabled, consumedQuotes)
  // 套餐对套餐对比行（只用于 UI 展示，不参与比价/导出）
  const quoteRows = buildQuoteRows(resData, matchSink, a2Item, mainRowEnabled, consumedQuotes)

  // ===== 取值时机（2026-09-24）：比对后的统计 =====
  //   以下量必须先完成行李匹配/比价并建好对比单元行（quoteRows）才统计得到 → 只在此处统计
  // ★ 我方胜出却未显示（2026-09-24 口径修正，逐条我方报价计）：
  //   我方投放的报价（isOwn=true 且自身未外显 showState!==1）「理应外显却未外显」时计 1，
  //   判定只看该报价所在的对比组（unitKey，main/package 块），满足以下任一即计：
  //     ① 本组内根本没有外部（isOwn=false）报价 → 无人与我竞价，我方不论报价多少都应外显；
  //     ② 本组内存在已外显（showState===1）的外部报价且价格比我方这条高 → 他人更贵都外显了，
  //        我方更便宜反而没外显。
  //   附加行（role='other'/kind='other'）的我方报价无「本组」可比、不计；主行对比组的候选过滤了
  //   isOwn → 主行组内不存在我方报价，自然计不到。
  //   搭档口径「展示的报价数」= summary.quoteOwnShown（我方投放且已外显的平铺计数，无需胜负条件）。
  let quoteWonHidden = 0
  {
    const byUnit = new Map()
    for (const r of quoteRows) {
      if (!r || r.role !== 'ctrip' || r.kind === 'other' || !r.unitKey) continue
      if (!byUnit.has(r.unitKey)) byUnit.set(r.unitKey, [])
      byUnit.get(r.unitKey).push(r)
    }
    for (const rows of byUnit.values()) {
      const ownHiddenRows = rows.filter(r => r.isOwn && Number(r.shown) !== 1)
      if (ownHiddenRows.length === 0) continue
      const rivalRows = rows.filter(r => !r.isOwn)
      const shownRivals = rivalRows.filter(r => r.shown === true)
      for (const o of ownHiddenRows) {
        // ① 本组无任何外部报价 → 无人竞价，理应外显
        if (rivalRows.length === 0) { quoteWonHidden++; continue }
        // ② 本组有已外显且价格更高的外部报价 → 我方更便宜却未外显
        const myPrice = Number(o.xcPrice)
        if (!Number.isFinite(myPrice)) continue
        if (shownRivals.some(r => Number(r.xcPrice) > myPrice)) quoteWonHidden++
      }
    }
  }
  return {
    platform: 'trip', status: 'ok', code: rawResponse.statusCode,
    message: resData?.responseHeader?.message || 'success',
    payload: resData, originalData: a2Item || null,
    processedData: processedDataArr,
    // 套餐对套餐对比：我方对比单元行 + 附加行（对不上任何单元的携程报价）
    quoteRows,
    summary: {
      flightCount,
      lowPriceCount,
      // 携程全部报价平铺口径（胜利率：quoteOwnShown / quoteTotal）——原始层统计，见函数开头
      quoteTotal,
      quoteOwn,
      quoteOwnShown,
      quoteOwnHidden,
      // 对比单元口径（role='official' 官方行：一单元一行，携程子行不计数）
      compareTotal: quoteRows.filter(r => r.role === 'official').length,
      compareMain: quoteRows.filter(r => r.role === 'official' && r.kind === 'main').length,
      comparePackage: quoteRows.filter(r => r.role === 'official' && r.kind === 'package').length,
      quoteWon: quoteRows.filter(r => r.role === 'official' && r.status === 'won').length,
      quoteWonHidden,
      quoteLost: quoteRows.filter(r => r.role === 'official' && r.status === 'lost').length,
      quoteUnmatched: quoteRows.filter(r => r.role === 'official' && r.status === 'unmatched').length,
      // ★ 本次将写入政策导入文件的条数（2026-09-24）：我方比赢（_outcome!=='lost'，含未匹配出政策的
      //   原价政策行）且航程类型=单程、会真正落进政策导入文件的数据条数
      //   口径与 ExcelExporter 导出过滤 / policyWriteback.keepPolicyRow 完全一致
      policyRowCount: processedDataArr.filter(r => keepPolicyRow(r, A3_FIELDS._outcome)).length,
      // 附加行口径
      otherCount: quoteRows.filter(r => r.kind === 'other').length,
      otherOwnShown: quoteRows.filter(r => r.kind === 'other' && r.status === 'ownShown').length,
      otherOwnHidden: quoteRows.filter(r => r.kind === 'other' && r.status === 'ownHidden').length
    },
    processedAt: new Date().toISOString()
  }
}

// 导出模板（阶段4）：每 O 平台一份异构 xlsx 列模板
//   新格式 147 列（对齐 政导文件样例.xlsx 的表头与单元格数据类型）：
//     - 数字列（16 个，t:'n'）：Y优先级/OTAConfigID/数据有效期End/退票增加百分比/退票固定加减钱/
//       改签增加百分比/改签固定加减钱/调价增加百分比/调价固定加减钱/儿童调价增加百分比/
//       儿童调价固定加减钱/上浮百分比/上浮人民币/下浮百分比/下浮人民币/创建人id
//       （样例里 ID 也是数字列，但业务上不需要 → 留空）
//     - 其余全部为字符串；留空列写空字符串（t:'s' v:''，与样例一致，不用 null）
//   列值来源分四类：
//     A. 锦绣政策字段配置传入：from(item, ctx) 经 resolvePolicyField 解析 ${变量} 拼接
//        （10 个文本字段：Name/Remark/Y优先级/OTAConfigID/数据有效期End/航司名/销售天数/座位数/爬虫名/创建人id；
//         其中 Y优先级/OTAConfigID/数据有效期End/创建人id 是数字列，配置字符串转 Number；
//         「航程类型」已取消配置，改为按数据自动判定：中转=多程、直飞=单程）
//     B. 对接旧格式字段：from(item) 取 a3 行字段
//        （机场航线匹配=出发机场-到达机场 / 舱位 / 调价固定加减钱=CUT_VALUE / UpdateTime=导出行生成时刻）
//     C. 固定值：value 写死（必填项按样例取值：是否启用=是 / 退改模式=不退不改 /
//        各标识=未设置 / 各百分比与加减钱=0 / 价格基础类型=总价 / 团体资质=正常票 /
//        是否包机产品=否 / 同程resouceCategory=普通资源 等）
//     D. 留空列：value:''（空字符串单元格；ID/CreateTime 也留空）

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
    // 航程类型：自动判定（priceComparisonPolicy 写入 item['航程类型']），中转=多程、直飞=单程
    { key: '航程类型', from: (item) => item['航程类型'] ?? '单程' },
    // 9-21：留空
    e('最长停留时间'), e('最短停留时间'),
    e('儿童人数最小'), e('儿童人数最大'),
    e('成人人数最小'), e('成人人数最大'),
    e('乘客人数最小'), e('乘客人数最大'),
    e('去程日期'), e('去程日期排除'), e('返程日期'), e('返程日期排除'),
    e('数据有效期Start'),
    // 22：锦绣配置（数字列）；23：锦绣配置
    { key: '数据有效期End', ...numPf('数据有效期End') },
    { key: '航司名', from: (item) => item[A3_FIELDS.H航司名] ?? '' },
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
    { key: '爬虫名', from: (item) => item[A3_FIELDS.H航司名] ?? '' },
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
    // ★ 写入前统一「向下取整再 − cutOffset」（计算阶段保留精确价差，见 policyAdjust.js）
    //   cutOffset = 平台配置「比携程低多少元」（ctx.cutOffset，默认 1）
    // 原价政策（无人在携程投放此套餐）→ 不调价，直接写 0；正常行按差值的 floor−cutOffset 口径
    { key: '调价固定加减钱', from: (item, ctx) => item['_原价政策'] === true ? 0 : formatPolicyAdjust(item[A3_FIELDS.CUT_VALUE], ctx?.cutOffset) },
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
    // 136,137：锦绣政策字段配置（2026-09-24 起配置化）：不填=空、默认空（原固定值 '2'/'TR' 已废弃）
    { key: '去哪飞猪携程nationalityType', ...pf('去哪飞猪携程nationalityType') },
    { key: '去哪飞猪携程nationality', ...pf('去哪飞猪携程nationality') },
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
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate, verifyCredential, buildRequestBody,
  getRateLimitState, onRateLimitChange
}

// ★ 供回归测试锁定 channel 组装行为（2026-09-24）
export { buildRequestBody }
