// 实验4：老域名候选路径 + seatGrade 变化，找 V 舱行来源
import https from 'node:https'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const USER = '锦绣廉航张超帅'
const PASS = 'ZXc12345'
const OLD = 'https://intlresource-exchdata.ctrip.com'

function mkBody(seatGrade = 'Y', extra = {}) {
  return {
    requestHeader: { requestID: randomUUID(), loginName: USER, password: PASS, language: 'zh_CN' },
    queryCondition: {
      tripType: 'OW', validatingCarrier: 'FA',
      segments: [{ segmentNo: 1, departCity: 'BFN', arriveCity: 'JNB', departDate: '2026-08-30' }],
      travelerCount: 1, childTravelerCount: 0,
      seatGrade, channel: 'EnglishSite', subChannel: 0,
      specialParam: null, ...extra
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
    req.setTimeout(15000, () => req.destroy(new Error('timeout')))
    req.write(payload)
    req.end()
  })
}

function rows(text) {
  let j = null; try { j = JSON.parse(text) } catch { return null }
  const lps = j?.responseBody?.lowPrices || []
  return lps.map(lp => ({
    intermediate: j?.responseHeader?.message,
    count: (lp.prices || []).length,
    prices: (lp.prices || []).map(p => `${p.seatClass}:${p.adtPublishPrice}+${p.adtTax}=${p.sortIndicator}(${p.baggage})`)
  }))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const paths = [
  '/api/lowPriceCompare/search',
  '/api/morePrice',
  '/api/retainMorePrice',
  '/api/lowPriceMore',
  '/api/priceCompareSearch',
  '/api/lowpricesearch/v2',
  '/api/lowPriceSearchV2'
]
for (const p of paths) {
  try {
    const r = await post(OLD + p, mkBody())
    console.log('path=' + p + ' → HTTP ' + r.status + ' len=' + r.text.length)
    if (r.status === 200) console.log(JSON.stringify(rows(r.text), null, 1)?.slice(0, 600))
  } catch (e) { console.log('path=' + p + ' 失败: ' + e.message) }
  await sleep(600)
}
for (const sg of ['X', 'V', 'K']) {
  try {
    const r = await post(OLD + '/api/lowPriceSearch', mkBody(sg))
    console.log('seatGrade=' + sg + ' → ' + JSON.stringify(rows(r.text), null, 1)?.slice(0, 800))
  } catch (e) { console.log('seatGrade=' + sg + ' 失败: ' + e.message) }
  await sleep(600)
}
console.log('DONE')