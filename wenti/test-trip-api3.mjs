// 实验3：老域名 /api/lowpricesearch 到底返回哪些价格行（重点看有没有 V 舱 750 与 children）
import https from 'node:https'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const USER = '锦绣廉航张超帅'
const PASS = 'ZXc12345'

function oldEnvelope(extra = {}) {
  return {
    requestHeader: { requestID: randomUUID(), loginName: USER, password: PASS, language: 'zh_CN' },
    queryCondition: {
      tripType: 'OW', validatingCarrier: 'FA',
      segments: [{ segmentNo: 1, departCity: 'BFN', arriveCity: 'JNB', departDate: '2026-08-30' }],
      travelerCount: 1, childTravelerCount: 0,
      seatGrade: 'Y', channel: 'EnglishSite', subChannel: 0,
      specialParam: null,
      ...extra
    }
  }
}

function post(url, obj) {
  const u = new URL(url)
  const payload = gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'))
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

const API_URL = 'https://intlresource-exchdata.ctrip.com/api/lowpricesearch'
const sleep = ms => new Promise(r => setTimeout(r, ms))

for (const [name, extra] of [
  ['C0_裸请求', {}],
  ['C1_useNewPriceCompare', { useNewPriceCompare: true }],
  ['C2_pageNo_sizePerPage40', { pageNo: 1, sizePerPage: 40 }],
  ['C3_两者都加', { useNewPriceCompare: true, pageNo: 1, sizePerPage: 40 }]
]) {
  try {
    const r = await post(API_URL, oldEnvelope(extra))
    let j = null; try { j = JSON.parse(r.text) } catch {}
    const lps = j?.responseBody?.lowPrices || []
    console.log('=== ' + name + ' → HTTP ' + r.status + ' reply=' + j?.responseHeader?.replyStatus + ' ===')
    for (const lp of lps) {
      console.log('   refs=' + JSON.stringify((lp.flightRefs || []).map(x => x.seatClass)))
      console.log('   children数=' + (lp.children || []).length)
      for (const c of (lp.children || [])) {
        console.log('     child: seat=' + JSON.stringify(c.seatClasses) + ' agcy=' + c.agencyCode + ' pub=' + JSON.stringify(c.publishPrices) + ' tax=' + JSON.stringify(c.taxes) + ' sort=' + c.sortIndicator)
      }
      for (const p of (lp.prices || [])) {
        console.log('     price: seat=' + p.seatClass + ' pub=' + p.adtPublishPrice + ' tax=' + p.adtTax + ' sort=' + p.sortIndicator + ' bag=' + p.baggage + ' qflag=' + p.quantifyFlagRemark)
      }
      console.log('   keys=' + JSON.stringify(Object.keys(lp)))
    }
  } catch (e) { console.log('=== ' + name + ' 失败: ' + e.message) }
  await sleep(800)
}
console.log('DONE')