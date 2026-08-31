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
 * 解析成统一结构 { free, pieces, weight }；解析不出来返回 null（匹配不到就留空，不兜底）。
 */
function parseTripBaggage(str) {
  if (typeof str !== 'string' || !str.trim()) return null
  const s = str.trim()
  if (/无免费托运/.test(s)) return { free: true, pieces: 0, weight: null }
  const m1 = s.match(/(\d+)\s*件[，,]\s*每件\s*([\d.]+)\s*KG/i)
  if (m1) return { free: false, pieces: Number(m1[1]), weight: Number(m1[2]) }
  const m2 = s.match(/成人[:：]\s*([\d.]+)\s*KG/i)
  if (m2) return { free: false, pieces: 1, weight: Number(m2[1]) }
  return null
}

/**
 * 我方（jxgj 数据体/套餐项）行李签名：数 行李信息 里「托运」条目 → { free, pieces, weight }
 *   pieces = 托运条目数；weight = 单件重量（沿用老逻辑取最后一个托运条目的重量）
 */
function parseOurBaggage(list) {
  if (!Array.isArray(list)) return null
  let pieces = 0, weight = null
  for (const x of list) {
    if (x && x.类型 == '2') {//1手提、2托运
      pieces++
      if (x.重量 != null) weight = Number(x.重量)
    }
  }
  return { free: pieces === 0, pieces, weight }
}

/** 数字相等（20 与 20.0 视为相等），null/NaN 一律不匹配 */
function numEq(a, b) {
  if (a == null || b == null) return false
  const na = Number(a), nb = Number(b)
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb
}

/** 行李匹配：都无托运 → 匹配；否则件数相等且单件重量相等 */
function baggageMatchs(our, xc) {
  if (!our || !xc) return false
  if (our.free || xc.free) return our.free && xc.free
  return our.pieces === xc.pieces && numEq(our.weight, xc.weight)
}

// 价格比较策略 price——Comparison——Policy
function priceComparisonPolicy(originalData, resData) {
  const resArr = []
  const forData = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  // flights用于查询检验，看是否查询错航数据，lowPrices是比价数据
  const flights = Array.isArray(resData?.responseBody?.flights) ? resData.responseBody.flights : []
  const lowPrices = Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : []
  const dateKey = originalData?.dateKey || 'unknown-date'

  // [debug] 一次性字段名采样：第一次进 priceComparisonPolicy 时输出 jxgj item / trip flights / lowPrices 的字段名
  //   目的：定位"processedData=0"是字段名不匹配还是业务比价输
  //   定位后可整段删除
  if (!priceComparisonPolicy._sampled) {
    priceComparisonPolicy._sampled = true
    const sampleItem = forData[0] || {}//元数据
    const sampleFlight = flights[0] || {}//trip flights航班
    const sampleLp = lowPrices[0] || {}//trip lowPrices套餐
    const samplePrice = (sampleLp[TRIP_RESPONSE_FIELDS.prices] && sampleLp[TRIP_RESPONSE_FIELDS.prices][0]) || {}
    //
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

    // ===== 行级比价：舱位级主数据体本身也是一种"套餐" =====
    //   用主数据体的 (C舱位, 行级行李) 在携程 prices 里找对应套餐报价 → 胜败判定
    const rowSig = parseOurBaggage(item.行李信息)
    const rowPrice = relatedPrices.find(p =>
      p && p[TRIP_RESPONSE_FIELDS.seatClass] == itemCangWei
      && !p[TRIP_RESPONSE_FIELDS.isOwn]
      && baggageMatchs(rowSig, parseTripBaggage(p[TRIP_RESPONSE_FIELDS.baggage]))
    )
    if (rowPrice) matchedLowPrice++

    // ===== 套餐富化：给舱位级数据携带的每个套餐挂「携程底价 / 差值」 =====
    //   seatClass 规则：套餐自带 舱位 属性 → 用它比；没有 → 用携程套餐 seatClass 去比主数据体的 C舱位
    //   差值 = 携程底价 - 我方底价 - 1（我方底价 = 该套餐价格按底价公式算出的底价，jxgj 阶段已挂上）
    const taocan = Array.isArray(item.套餐信息) ? item.套餐信息 : []
    for (const acai of taocan) {
      if (!acai) continue
      const acaiSig = parseOurBaggage(acai.行李信息)
      if (!acaiSig) continue // 套餐没有行李信息 → 无法匹配（不兜底）
      const seat = (acai.舱位 != null && String(acai.舱位).trim() !== '')
        ? acai.舱位
        : itemCangWei
      const pkgPrice = relatedPrices.find(p =>
        p && p[TRIP_RESPONSE_FIELDS.seatClass] == seat
        && baggageMatchs(acaiSig, parseTripBaggage(p[TRIP_RESPONSE_FIELDS.baggage]))
      )//&& !p[TRIP_RESPONSE_FIELDS.isOwn]
      if (pkgPrice) {
        acai['差值'] = ''
        acai['isOwn'] = pkgPrice[TRIP_RESPONSE_FIELDS.isOwn]
        acai['携程底价'] = Number(pkgPrice[TRIP_RESPONSE_FIELDS.sortIndicator])
        const ourFloor = Number(acai['我方底价'])
        if (!Number.isNaN(ourFloor)) {
          acai['差值'] = new Decimal(acai['携程底价']).minus(acai['套餐价格_CNY']).minus(1).toNumber()
        }
      }
    }

    const sortIndicator = Number(rowPrice?.[TRIP_RESPONSE_FIELDS.sortIndicator])
    const hasXcPrice = !isNaN(sortIndicator) && sortIndicator > 0
    const dijia = Number(item[A2_FIELDS.dijia]) || 0
    const totalCNY = Number(item[A2_FIELDS.C成人总票价_CNY_INT]) || 0
    item[A3_FIELDS.isOwn] = rowPrice?.[TRIP_RESPONSE_FIELDS.isOwn]
    if (hasXcPrice && dijia > 0 && dijia <= sortIndicator) {
      wonByPrice++
      item[A3_FIELDS.XC_dijia] = sortIndicator
      // 比赢：打「可以胜出」标记
      item[A3_FIELDS._outcome] = 'won'
      resArr.push(item)
    } else if (hasXcPrice && dijia > sortIndicator) {
      lostByPrice++
      // 比输不再丢弃：打「无法胜出」标记并入队，供底价检查文件全量展示
      item[A3_FIELDS.XC_dijia] = sortIndicator
      item[A3_FIELDS._outcome] = 'lost'
      resArr.push(item)
    }
    // ★ 底价检查文件「预计减价」列：won/lost 都算（携程底价 - 官网价取整 - 1）
    //   导入政策文件「调价固定加减钱」列也引用它（保持原公式不变，只从仅 won 扩展到 won+lost）
    if (hasXcPrice) {
      item[A3_FIELDS.CUT_VALUE] = new Decimal(sortIndicator).minus(totalCNY || 0).minus(1).toNumber()
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
//   columns 定义 xlsx 的列顺序 + 每列值如何从比价结果 item 算出
//   - value: 静态字面量（优先级/是否启用/OTAType 等）
//   - from(item): 动态从比价结果 item 取值
// ============================================================
export const exportTemplate = {
  platform: 'trip',
  columns: [
    { key: 'Name', from: (item) => `王宇_${item[A3_FIELDS.H航司名]}_携程/${item[A3_FIELDS.C出发机场]}-${item[A3_FIELDS.D到达机场]}` },
    { key: 'Remark', value: '王宇_出官网' },
    { key: '优先级', value: '90' },
    { key: '是否启用', value: 'TRUE' },
    { key: '航程类型', value: null },
    { key: '航司匹配', from: (item) => item[A3_FIELDS.H航司名] },
    { key: '出发机场', from: (item) => item[A3_FIELDS.C出发机场] },
    { key: '到达机场', from: (item) => item[A3_FIELDS.D到达机场] },
    { key: '航班号', value: null },
    { key: '舱位', from: (item) => item[A3_FIELDS.C舱位] },
    { key: '起飞时间Start', value: null },
    { key: '起飞时间End', value: null },
    { key: '去程时间匹配排除', value: null },
    { key: '返程时间匹配排除', value: null },
    { key: '班期', value: null },
    { key: '销售时间Start', value: null },
    { key: '销售时间End', value: null },
    { key: '时间段匹配', value: null },
    { key: '提前销售天数', value: null },
    { key: '出票时长匹配', value: null },
    { key: '儿童人数最小', value: 0 },
    { key: '儿童人数最大', value: 0 },
    { key: '成人人数最小', value: 0 },
    { key: '成人人数最大', value: 0 },
    { key: '乘客人数最小', value: null },
    { key: '乘客人数最大', value: null },
    { key: '数据有效期Start', value: null },
    { key: '数据有效期End', value: null },
    { key: '出发城市', value: null },
    { key: '到达城市', value: null },
    { key: '出发国家', value: null },
    { key: '到达国家', value: null },
    { key: '最低票面价', value: null },
    { key: '最高票面价', value: null },
    { key: '销售天数', value: null },
    { key: '套餐索引v2', value: null },
    { key: '座位数', value: null },
    { key: '是否中转', value: null },
    { key: '是否国内', value: null },
    { key: 'OTAType', value: '携程' },
    { key: 'OTAConfigID', value: '11' },
    { key: '行程索引', value: null },
    { key: '数据来源', value: '爬虫' },
    { key: '政策代码', value: null },
    { key: '爬虫名', value: null },
    { key: '去程时间匹配', value: null },
    { key: '返程时间匹配', value: null },
    { key: '搜索出发城市', value: null },
    { key: '搜索到达城市', value: null },
    { key: '最长停留时间', value: null },
    { key: '最短停留时间', value: null },
    { key: '去程班期', value: null },
    { key: '返程班期', value: null },
    { key: '调价阶段', value: '搜索' },
    { key: '调价增加百分比', value: 0 },
    { key: '调价固定加减钱', from: (item) => item[A3_FIELDS.CUT_VALUE] },
    { key: '儿童调价增加百分比', value: 0 },
    { key: '儿童调价固定加减钱', value: 0 },
    { key: '价格基础类型', value: '总价' },
    { key: '市场', value: null },
    { key: 'ID', value: 0 }
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
