// ============================================================
// O1 平台请求适配器
// 职责：
//   - compilePlatformConfig: 透传字符串配置（O1 无独立公式编译）
//   - o1Login: 平台登录（低价看板无需独立登录，请求头带账密即可，此处仅透传）
//   - o1Request: 低价看板查询（Json+Gzip 协议）
//
// 协议要点：
//   - Content-Type: application/json;charset=UTF-8
//   - Content-Encoding: gzip（请求体压缩，与 Java 示例 GzipCompressingEntity 行为一致）
//   - Accept-Encoding: gzip（响应解压）
//   - 限制：每分钟 210 条（TaskManager 已节流）
//
// 返回结构：payload（接口完整响应）+ originalData（原始入参）+ processedData（比价后的数据）
// ============================================================

import https from 'node:https'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'

// 业务参数默认值，platformConfig 可覆盖
const O1_DEFAULTS = {
  // 服务 URL：生产 / 测试二选一
  baseURL: 'https://intlresource-exchdata.ctrip.com/api/lowPriceSearch',   // 生产
  // baseURL: 'https://intlresource-exchdata.fat.ctripqa.com/api/lowPriceSearch',  // 测试
  language: 'zh_CN',
  tripType: 'OW',           // 行程类型 OW/RT/MT
  travelerCount: 1,         // 成人人数 1-9
  seatGrade: 'Y',           // 舱等 Y/C/F
  channel: 'EnglishSite',  // 主渠道 FlightIntlOnline/EnglishSite/Mobile
  subChannel: 0,            // 子渠道，主站传 0
  specialParam: 'SpecialSupply-特价产品',  // 特殊参数，逗号分隔
  validatingCarrier: '',    // 开票航司二字码
  childTravelerCount: 0,    // 儿童人数
  // agencyID: 3399,
  // babyTravelerCount: 0,
  // scMarket: null,
  timeout: 10000            // 请求超时 ms
}

// identity fallback：O1 暂未实现公式编译，预编译时透传字符串配置
export const compilePlatformConfig = (raw = {}) => ({ ...raw })

// 低价看板无需独立登录，每次请求在 requestHeader 带账密即可；此处仅透传
export async function o1Login(credential) {
  return {
    loginName: credential?.username || '',
    password: credential?.password || ''
  }
}

/**
 * 发送 gzip 压缩的 HTTPS POST 请求，返回原始响应（statusCode/headers/body）
 * 用原生 https 手动控制 gzip 压缩/解压和 socket 超时
 * 注意：请求体压缩使用标准 HTTP Content-Encoding: gzip 头（与 Java 示例 GzipCompressingEntity 行为一致）
 *       文档写的 Content-Transfer-Encoding 是 MIME 头，非 HTTP 标准，服务端无法识别
 */
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
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({ statusCode: res.statusCode, headers: res.headers, body })
      })
      res.on('error', reject)
    })

    req.on('error', (err) => {
      reject(err)
    })
    // 超时控制：用 req.setTimeout 而非 socket.on('timeout')
    // 原因：Node 会复用 keep-alive socket，手动 socket.on 不会随请求结束清理，
    //       监听器堆积会触发 MaxListenersExceededWarning；req.setTimeout 自动清理
    req.setTimeout(timeout, () => req.destroy(new Error(`O1平台请求超时（${timeout}ms）`)))
    req.write(gzippedBody)
    req.end()
  })
}

/**
 * 构造行程段（segments）：优先用 data.segments，否则用扁平字段拼成单段
 * 必填字段：C出发城市 / D到达城市 / dateKey（日期）
 */
function buildSegments(data) {
  const CF_CITY = data.dateValue[0].C出发城市
  const DD_CITY = data.dateValue[0].D到达城市
  const RIQI = data.dateKey

  if (!CF_CITY || !DD_CITY || !RIQI) {
    throw new Error(`O1平台请求失败：缺少必填字段（C出发城市/D到达城市/日期）实际：${JSON.stringify(data)}`)
  }

  const segments = (Array.isArray(data?.segments) && data.segments.length > 0)
    ? data.segments
    : [{
      segmentNo: 1,
      departCity: CF_CITY,
      arriveCity: DD_CITY,
      departDate: RIQI
    }]

  // 校验第一段必填字段
  const seg0 = segments[0] || {}
  if (!seg0.departCity || !seg0.arriveCity || !seg0.departDate) {
    throw new Error(`O1平台请求失败：segments 缺少必填字段（departCity/arriveCity/departDate），实际：${JSON.stringify(seg0)}`)
  }

  return segments
}

// 构造请求体：requestHeader（账密等） + queryCondition（查询条件）
function buildRequestBody(cfg, loginName, password, segments, validatingCarrier) {
  return {
    requestHeader: {
      requestID: randomUUID(),
      loginName,
      password,
      language: cfg.language
    },
    queryCondition: {
      tripType: cfg.tripType,
      validatingCarrier,
      segments,
      travelerCount: cfg.travelerCount,
      childTravelerCount: cfg.childTravelerCount,
      seatGrade: cfg.seatGrade,
      channel: cfg.channel,
      subChannel: cfg.subChannel,
      scMarket: cfg.scMarket,
      specialParam: cfg.specialParam
      // agencyID: data?.agencyID ?? cfg.agencyID,
      // babyTravelerCount: cfg.babyTravelerCount,
    }
  }
}

/**
 * 解压 → 解析 JSON → 状态校验 → 整理成统一结构
 *   - payload: 服务端完整响应（ResponseStatus / responseHeader / responseBody）
 *   - originalData: 调用方传入的原始数据（用于补充请求参数的原始数据）
 *   - requestBody: 实际发送给接口的请求体（便于调试追溯）
 *   - processedData: 比价处理后的数据（priceComparisonPolicy 产出）
 */
function parseResponse(rawRes, originalData) {
  // ① 解压响应（服务端返回 gzip，调用方负责解压）
  let bodyBuf = rawRes.body
  const contentEncoding = String(rawRes.headers['content-encoding'] || '').toLowerCase()
  if (contentEncoding.includes('gzip') && bodyBuf.length > 0) {
    try {
      bodyBuf = gunzipSync(bodyBuf)
    } catch (e) {
      throw new Error(`O1平台响应 gunzip 解压失败：${e.message}`)
    }
  }
  const bodyText = bodyBuf.toString('utf-8')

  // ② 解析 JSON
  let resData
  try {
    resData = JSON.parse(bodyText)
  } catch (e) {
    throw new Error(`O1平台响应 JSON 解析失败：${e.message}（前 200 字符：${bodyText.slice(0, 200)}）`)
  }

  // ③ HTTP 状态码校验（2xx 才算成功）
  if (rawRes.statusCode < 200 || rawRes.statusCode >= 300) {
    throw new Error(`O1平台 HTTP ${rawRes.statusCode}：${resData?.responseHeader?.message || bodyText.slice(0, 200)}`)
  }

  // ④ 业务状态校验（Ack 必须是 Success）
  const ack = resData?.ResponseStatus?.Ack
  if (ack && ack !== 'Success') {
    const errors = resData?.ResponseStatus?.Errors || []
    const errMsg = errors.map(e => e?.Message || e?.message || JSON.stringify(e)).join('; ')
    throw new Error(`O1平台请求业务失败：Ack=${ack} - ${errMsg}`)
  }

  // ⑤ 整理成统一返回结构（payload 里是服务端完整响应）
  // 建议：将所有数据处理,processedData
  const processedDataArr = priceComparisonPolicy(originalData, resData)

  const flightCount = resData?.responseBody?.flights?.length || 0
  const lowPriceCount = resData?.responseBody?.lowPrices?.length || 0
  return {
    platform: 'trip',
    status: 'ok',
    code: rawRes.statusCode,
    message: resData?.responseHeader?.message || 'success',
    payload: resData,          // 服务端完整响应数据
    originalData: originalData || null,  // 调用方传入的原始数据
    // requestBody: requestBody || null,    // 实际发送的请求体（便于调试）
    processedData: processedDataArr,  // 处理后的数据
    summary: {
      flightCount,
      lowPriceCount
    },
    processedAt: new Date().toISOString()
  }
}

/**
 * O1 平台主请求流程：
 *   ① 合并配置（platformConfig 覆盖默认值）
 *   ② 取账密（优先 loginResult，兜底 credential）
 *   ③ 取开票航司（优先入参航司名，其次配置）
 *   ④ 构造行程段
 *   ⑤ 构造请求体
 *   ⑥ gzip 压缩请求体并发送
 *   ⑦ 处理返回数据
 */
export async function o1Request(data, context = {}) {
  const { credential, loginResult = {}, platformConfig = {} } = context

  // ① 合并配置：platformConfig 覆盖默认值
  const cfg = { ...O1_DEFAULTS, ...platformConfig }

  // ② 账号密码：优先 loginResult，兜底 credential
  const loginName = loginResult.loginName || credential?.username || ''
  const password = loginResult.password || credential?.password || ''
  if (!loginName || !password) {
    throw new Error('O1平台请求失败：缺少账密（credential.username/password 或 loginResult 未提供）')
  }

  // ③ 开票航司：优先入参航司名，其次配置
  const validatingCarrier = data.dateValue[0].H航司名 || cfg.validatingCarrier || ''

  // ④ 构造行程段
  const segments = buildSegments(data)

  // ⑤ 构造请求体
  const requestBody = buildRequestBody(cfg, loginName, password, segments, validatingCarrier)
  const requestJson = JSON.stringify(requestBody)

  // ⑥ 压缩请求体并发送
  const gzippedBody = gzipSync(Buffer.from(requestJson, 'utf-8'))
  const rawRes = await postGzip(cfg.baseURL, gzippedBody, cfg.timeout)

  // ⑦ 处理返回数据（传入原始 data 和请求体，便于后续使用）
  return parseResponse(rawRes, data)
}

/**
 * 比价策略：
 *   1. 找到对应航班（按 航班号/出发到达机场/出发日期 匹配）
 *   2. 在 lowPrices 中找到该航班的低价套餐（行李额含"无免费托运行李额" + showState==1 + !isOwn）
 *   3. 若当前展示价 >= 自己的底价 → 比赢了，记录 XC 底价 + CUT_VALUE（差价 -1）
 *
 *   兼容性 / 防御性：
 *     - flights/lowPrices 为 null/非数组 / flights_related 没匹配到 / lowPrices 对应 flightId 不存在
 *       / prices 不存在"无免费托运行李额" / sortIndicator 为空 → 老代码会直接整段 resArr.push 0 条
 *       → 现在在这些"无数据"分支加一行 warn 日志（用户一看知道是匹配失败而非链路断了）
 *     - 极端兼容：sortIndicator 非数字、原 item dijia / 成人总票价 缺字段时，走兜底公式，
 *       至少不要整批 processedData 空数组。
 */
function priceComparisonPolicy(originalData, resData) {
  const resArr = []
  const forData = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  const flights = Array.isArray(resData?.responseBody?.flights) ? resData.responseBody.flights : []
  const lowPrices = Array.isArray(resData?.responseBody?.lowPrices) ? resData.responseBody.lowPrices : []
  const dateKey = originalData?.dateKey || 'unknown-date'

  let matchedFlights = 0
  let matchedLowPrice = 0
  let wonByPrice = 0

  forData.forEach(item => {
    // 1.找到对应航班ID
    const flights_related = flights.find(f =>
      f &&
      String(f.flightNo) === String(item.H航班号) &&
      String(f.departAirport) === String(item.C出发机场) &&
      String(f.arriveAirport) === String(item.D到达机场) &&
      String((f.takeOffDateTime || '').split(' ')[0]) === String(item.C出发日期)
    )
    if (flights_related) matchedFlights++

    // 2.找到对应套餐：行李额:无免费托运行李额
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
          // 再兜底：如果没有"无免费托运行李额"，就用当前 LP 下 showState==1 且 !isOwn 的第一条
          lowPrice_related = prices.find(lpr => Number(lpr?.showState) === 1 && !lpr?.isOwn)
        }
      }
    }
    if (lowPrice_related) matchedLowPrice++


    // if (item.C出发机场 == "ELS" && item.D到达机场 == "JNB" && item.C舱位 == "P") {
    //   console.log(item)
    //   console.log(lowPrice_related)
    // }
    // bijia
    const sortIndicator = Number(lowPrice_related?.sortIndicator)
    const hasXcPrice = !isNaN(sortIndicator) && sortIndicator > 0
    const dijia = Number(item.dijia) || 0
    const totalCNY = Number(item.C成人总票价_CNY_INT) || 0
    const cw = item.C舱位 + "==" + lowPrice_related
    if (hasXcPrice && dijia > 0 && dijia <= sortIndicator) {
      wonByPrice++
      item.XC_dijia = sortIndicator
      item.CUT_VALUE = new Decimal(sortIndicator)
        .minus(totalCNY || 0)
        .minus(1)
        .toNumber()
      resArr.push(item)
    } else if (hasXcPrice) {
      // 接口返回了低价，但我们的底价更高 → 不推
      // 不打日志避免刷屏
    }
  })

  // 调试信息（每次 O 任务汇总一行，方便定位"processedData=0"是接口无数据还是字段不匹配）
  // console.log(`[O1/比价] dateKey=${dateKey} 舱位项=${forData.length} → 航班匹配=${matchedFlights} 低价套餐匹配=${matchedLowPrice} 比赢入队=${wonByPrice}，最终 processedData=${resArr.length}`)

  return resArr
}
