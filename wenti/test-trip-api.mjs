// 携程低价接口参数实验：找出官网自测页多出来的 V 舱来自哪个参数/接口
// 用法：node wenti/test-trip-api.mjs
import fs from 'node:fs'
import https from 'node:https'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const CRED_FILE = 'c:/Users/wang/AppData/Roaming/work-tools/config/credentials.json'
const OUT_DIR = 'd:/WorkTools-release/wenti/api-experiments'
fs.mkdirSync(OUT_DIR, { recursive: true })

const creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'))
const trip = creds.find(c => c.platform === 'trip')
if (!trip) { console.error('未找到 trip 账号'); process.exit(1) }

const BASE = 'https://intlresource-exchdata.ctrip.com/api/lowPriceSearch'

function baseBody() {
  return {
    requestHeader: { requestID: randomUUID(), loginName: trip.username, password: trip.password, language: 'zh_CN' },
    queryCondition: {
      tripType: 'OW', validatingCarrier: 'FA',
      segments: [{ segmentNo: 1, departCity: 'BFN', arriveCity: 'JNB', departDate: '2026-08-30' }],
      travelerCount: 1, childTravelerCount: 0,
      seatGrade: 'Y', channel: 'EnglishSite', subChannel: 0,
      specialParam: null
    }
  }
}

function post(url, body) {
  const u = new URL(url)
  const payload = gzipSync(Buffer.from(JSON.stringify(body), 'utf-8'))
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Encoding': 'gzip',
        'Content-Length': payload.length,
        'Accept-Encoding': 'gzip'
      }
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        if (enc.includes('gzip') && buf.length) { try { buf = gunzipSync(buf) } catch {} }
        resolve({ status: res.statusCode, text: buf.toString('utf-8') })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('timeout')))
    req.write(payload)
    req.end()
  })
}

function summarize(text) {
  let j
  try { j = JSON.parse(text) } catch { return { parseError: text.slice(0, 300) } }
  const out = {
    replyStatus: j?.responseHeader?.replyStatus,
    message: j?.responseHeader?.message,
    ack: j?.ResponseStatus?.Ack,
    topKeys: Object.keys(j || {})
  }
  const flights = j?.responseBody?.flights || []
  const lps = j?.responseBody?.lowPrices || []
  out.flights = flights.map(f => ({ flightId: f.flightId, flightNo: f.flightNo, takeOff: f.takeOffDateTime }))
  out.anyLowPricesChildren = lps.some(lp => Array.isArray(lp?.children) && lp.children.length > 0)
  out.rows = lps.map(lp => ({
    refs: (lp.flightRefs || []).map(r => r.seatClass),
    childCount: (lp.children || []).length,
    prices: (lp.prices || []).map(p => ({
      seat: p.seatClass, pub: p.adtPublishPrice, tax: p.adtTax,
      sort: p.sortIndicator, qflag: p.quantifyFlagRemark, bag: p.baggage, isOwn: p.isOwn
    }))
  }))
  out.hasV = text.includes('"V"')
  return out
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const variants = []
variants.push(['V0_baseline与程序一致', baseBody()])
{
  const b = baseBody(); b.queryCondition.useNewPriceCompare = true
  variants.push(['V1_useNewPriceCompare', b])
}
{
  const b = baseBody(); b.queryCondition.pageNo = 1; b.queryCondition.sizePerPage = 40
  variants.push(['V2_pageNo_sizePerPage', b])
}
{
  const b = baseBody()
  Object.assign(b.queryCondition, { useNewPriceCompare: true, specialSupply: false, pageNo: 1, sizePerPage: 40 })
  variants.push(['V3_全参数组合', b])
}
{
  const b = baseBody(); b.queryCondition.specialParam = 'SpecialSupply-特价产品'
  variants.push(['V4_specialParam老值', b])
}
{
  const b = baseBody()
  Object.assign(b.queryCondition, { useNewPriceCompare: true, specialSupply: false, pageNo: 1, sizePerPage: 40 })
  b.sessionId = randomUUID()
  variants.push(['V5_V3加sessionId', b])
}

for (const [name, body] of variants) {
  try {
    const r = await post(BASE, JSON.parse(JSON.stringify(body)))
    const s = summarize(r.text)
    console.log('=== ' + name + ' → HTTP ' + r.status + ' ===')
    console.log(JSON.stringify(s, null, 1))
    fs.writeFileSync(`${OUT_DIR}/${name}.json`, JSON.stringify({ name, status: r.status, summary: s, raw: r.text }, null, 2))
  } catch (e) {
    console.log('=== ' + name + ' 失败: ' + e.message + ' ===')
  }
  await sleep(800)
}
console.log('ALL DONE → ' + OUT_DIR)