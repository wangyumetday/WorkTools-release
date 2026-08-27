// 实验2：确认 V 舱行在哪个接口 + 哪种认证下能拿到
// 1) 官网门户接口 partnerportal/api/lowpricesearch：无会话 / Basic / 账密塞body 三种认证
// 2) 老接口域名上的候选新路径（用老信封）
import https from 'node:https'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const USER = '锦绣廉航张超帅'
const PASS = 'ZXc12345'
const B64 = Buffer.from(`${USER}:${PASS}`).toString('base64')
const TOKEN = '8000000000H3q2eU03JmHX6AE625W03zK8007wez4hmH0000000000G0QjOe820000580005dO000400000000X6004Ty0HZ0qG80000000000|||||||CgozSjJpRE9mVlly|GAIgBCjq2vnVBkgB'

function flatBody() {
  return {
    header: { requestID: String(Date.now()) },
    tripType: 'OW',
    channel: 'EnglishSite',
    subChannel: 0,
    validatingCarrier: 'FA',
    seatGrade: 'Y',
    travelerCount: 1,
    childTravelerCount: 0,
    debug: false,
    agentId: 4984,
    segments: [{ segmentNo: 1, departCity: 'BFN', arriveCity: 'JNB', departDate: '2026-08-30' }],
    specialSupply: false,
    routeSearchToken: TOKEN,
    useNewPriceCompare: true,
    sessionId: randomUUID(),
    pageNo: 1,
    sizePerPage: 40
  }
}

function oldEnvelope() {
  return {
    requestHeader: { requestID: randomUUID(), loginName: USER, password: PASS, language: 'zh_CN' },
    queryCondition: {
      tripType: 'OW', validatingCarrier: 'FA',
      segments: [{ segmentNo: 1, departCity: 'BFN', arriveCity: 'JNB', departDate: '2026-08-30' }],
      travelerCount: 1, childTravelerCount: 0,
      seatGrade: 'Y', channel: 'EnglishSite', subChannel: 0,
      specialParam: null
    }
  }
}

function post(url, obj, { gzip = true, headers = {} } = {}) {
  const u = new URL(url)
  const text = JSON.stringify(obj)
  const payload = gzip ? gzipSync(Buffer.from(text, 'utf-8')) : Buffer.from(text, 'utf-8')
  const h = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept-Encoding': 'gzip',
    ...headers
  }
  if (gzip) { h['Content-Encoding'] = 'gzip' }
  h['Content-Length'] = payload.length
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', headers: h }, (res) => {
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

function brief(r) {
  let j = null
  try { j = JSON.parse(r.text) } catch {}
  const lps = j?.data?.lowPrices || j?.responseBody?.lowPrices || []
  const vInfo = []
  for (const lp of lps) {
    const parentSeat = lp.seatClasses
    const kids = (lp.children || []).map(c => ({
      seat: c.seatClasses, agencyCode: c.agencyCode, pub: c.publishPrices, tax: c.taxes, sort: c.sortIndicator, qflag: c.quantifyFlagRemark
    }))
    vInfo.push({ parentSeat, kids })
  }
  return {
    status: r.status,
    parseOk: !!j,
    topKeys: j ? Object.keys(j) : [],
    msg: j?.msg || j?.responseHeader?.message || null,
    lpCount: lps.length,
    hasV: r.text.includes('"V"'),
    vInfo
  }
}

const sleep = ms => new Promise(res => setTimeout(res, ms))
const cases = []

// ===== A. 门户接口 =====
const PORTAL = 'https://intlflightsupplier.ctrip.com/partnerportal/api/lowpricesearch'
cases.push(['A1_门户无认证_明文JSON', PORTAL, flatBody(), { gzip: false }])
cases.push(['A2_门户无认证_gzip', PORTAL, flatBody(), { gzip: true }])
cases.push(['A3_门户Basic认证,明文', PORTAL, flatBody(), { gzip: false, headers: { 'Authorization': 'Basic ' + B64 } }])
{
  const b = flatBody()
  b.header = { requestID: String(Date.now()), loginName: USER, password: PASS }
  cases.push(['A4_门户body带账密', PORTAL, b, { gzip: false }])
}
{
  const b = flatBody()
  delete b.routeSearchToken
  cases.push(['A5_门户无token无认证', PORTAL, b, { gzip: false }])
}
// ===== B. 老域名候选新路径 =====
const OLD = 'https://intlresource-exchdata.ctrip.com'
cases.push(['B1_老域名/api/lowpricesearch信封', OLD + '/api/lowpricesearch', oldEnvelope(), { gzip: true }])
cases.push(['B2_老域名/api/lowpricesearch扁平', OLD + '/api/lowpricesearch', flatBody(), { gzip: false }])
cases.push(['B3_老域名/api/lowPriceCompare', OLD + '/api/lowPriceCompare', oldEnvelope(), { gzip: true }])

for (const [name, url, body, opt] of cases) {
  try {
    const r = await post(url, JSON.parse(JSON.stringify(body)), opt)
    const b = brief(r)
    console.log('=== ' + name + ' → HTTP ' + r.status + ' ===')
    console.log(JSON.stringify(b, null, 1).slice(0, 1500))
  } catch (e) {
    console.log('=== ' + name + ' 失败: ' + e.message + ' ===')
  }
  await sleep(800)
}
console.log('DONE')