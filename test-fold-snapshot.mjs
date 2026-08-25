// ============================================================
// test-fold-snapshot.mjs - 用真实 adapter 跑 testfold 测试文件，抓接口返回数据存盘
//
// 目的：建立 diagnosing-bugs 的"紧密反馈回路"
//   · 不 mock，调真实 jxgj/trip adapter，发真实 HTTP 请求
//   · 抓 jxgj / trip 各一个任务的接口原始响应，存到 testfold/snapshots/*.json
//   · 输出字段名采样 + 比价计数 summary.json，方便离线分析"为什么 processedData=0"
//
// 用法：node test-fold-snapshot.mjs
// 输入：testfold/FA-前20条 - 副本.xlsx
// 输出：testfold/snapshots/jxgj-raw.json    （jxgj 接口第一个任务的完整响应）
//       testfold/snapshots/jxgj-a2-item.json （mergeResult 后的 a2[0] 完整对象）
//       testfold/snapshots/trip-raw.json    （trip 接口第一个任务的完整响应）
//       testfold/snapshots/trip-processed.json （mergeResult 后的 processedData + 比价计数）
//       testfold/snapshots/summary.json    （全链路计数 + 字段名采样 + 0 条根因假设）
// ============================================================
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = __dirname

// ---------- 真实 AppData 路径（dev 模式 Electron 用 package.json name="work-tools"） ----------
const REAL_USERDATA = path.join(process.env.APPDATA || '', 'work-tools')
const REAL_CFG_DIR = path.join(REAL_USERDATA, 'config')
const SNAP_DIR = path.join(ROOT, 'testfold', 'snapshots')
fs.mkdirSync(SNAP_DIR, { recursive: true })

// ---------- 临时 userData（不污染真实数据，只复用凭证 + 配置） ----------
const TMP_USERDATA = path.join(ROOT, 'testfold', '.tmp-userdata')
const TMP_CFG = path.join(TMP_USERDATA, 'config')
fs.rmSync(TMP_USERDATA, { recursive: true, force: true })
fs.mkdirSync(TMP_CFG, { recursive: true })
// 复制真实凭证 + 配置 + 选中关系到临时目录
for (const f of ['credentials.json', 'platformConfig.json', 'selectedCredential.json']) {
  const src = path.join(REAL_CFG_DIR, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP_CFG, f))
}

// ---------- import 真实 manager + adapter ----------
import { FileManager } from './electron/features/pcp/fileManager.js'
import { CredentialManager } from './electron/features/pcp/credentialManager.js'
import { ConfigManager } from './electron/features/pcp/configManager.js'
import * as jxgjAdapter from './electron/features/pcp/platforms/jxgj/adapter.js'
import * as tripAdapter from './electron/features/pcp/platforms/trip/adapter.js'

// ==========================================================================
// Step 1: parseXlsx testfold 测试文件 → a1
// ==========================================================================
const xlsxPath = path.join(ROOT, 'testfold', 'FA-前20条 - 副本.xlsx')
if (!fs.existsSync(xlsxPath)) fail(`❌ 测试文件不存在: ${xlsxPath}`, 1)

const fm = new FileManager(TMP_USERDATA, path.join(ROOT, 'testfold', '.tmp-out'))
const pr = fm.parseXlsx(xlsxPath)
if (!pr.success) fail(`❌ parseXlsx 失败: ${pr.error}`, 2)
const a1 = fm.getA1()
console.log(`[1] parseXlsx OK: a1.count=${a1.count}, hangsi=${a1.data[0]?.hangsi}, cangwei_str 长度=${(a1.data[0]?.cangwei_str || '').length}`)
if (a1.count === 0) fail('❌ a1 为空，无法继续', 3)

// ==========================================================================
// Step 2: 初始化 manager（用真实凭证 + 配置）
// ==========================================================================
const credentialManager = new CredentialManager(TMP_USERDATA)
const configManager = new ConfigManager(TMP_USERDATA)
const jxgjCred = credentialManager.getSelected('jxgj')
const tripCred = credentialManager.getSelected('trip')
console.log(`[2] 凭证: jxgj=${jxgjCred ? jxgjCred.username : '(无)'} | trip=${tripCred ? tripCred.username : '(无)'}`)
if (!jxgjCred) fail('❌ jxgj 未选中凭证', 4)
if (!tripCred) fail('❌ trip 未选中凭证', 5)

// 预编译平台配置（对齐 taskManager.precompilePlatformConfigs）
const jxgjCompiled = jxgjAdapter.compileConfig(configManager.getPlatformConfig('jxgj'))
const tripCompiled = tripAdapter.compileConfig(configManager.getPlatformConfig('trip'))
console.log(`    jxgjCompiled keys: ${Object.keys(jxgjCompiled).join(',')} (floorPriceFormula is fn: ${typeof jxgjCompiled.floorPriceFormula === 'function'})`)
console.log(`    tripCompiled keys: ${Object.keys(tripCompiled).join(',')}`)

// ==========================================================================
// Step 3: 跑 1 个 jxgj 任务（真实 HTTP GET），抓 rawResponse + mergeResult
// ==========================================================================
console.log(`\n[3] 跑 1 个 jxgj 任务（真实 HTTP GET）...`)
const a1Row = a1.data[0]
console.log(`    a1[0]: CF=${a1Row.CF_jichang} DD=${a1Row.DD_jichang} hangsi=${a1Row.hangsi} cangwei_str="${a1Row.cangwei_str}"`)

const jxgjPrepared = jxgjAdapter.prepareRequest(a1Row)
console.log(`    prepared.url = ${jxgjPrepared.url}`)

const jxgjLoginResult = await jxgjAdapter.login(jxgjCred)
const jxgjCtx = { credential: jxgjCred, loginResult: jxgjLoginResult, platformConfig: jxgjCompiled }

let jxgjRaw
try {
  jxgjRaw = await jxgjAdapter.request(jxgjPrepared, jxgjCtx)
} catch (err) {
  console.error(`❌ jxgj 请求抛错: ${err.message}`)
  fail('jxgj 请求失败', 6)
}
console.log(`    jxgj rawResponse: ${typeof jxgjRaw}, keys=${Object.keys(jxgjRaw || {}).join(',')}`)
console.log(`    jxgj Ack=${jxgjRaw?.Ack}, Content.List 长度=${jxgjRaw?.Content?.List?.length || 0}`)

// 抓 jxgj 原始响应存盘
writeJson('jxgj-raw.json', jxgjRaw)

// 跑 mergeResult 拿 a2 项
const a2ItemRaw = { ...a1Row }  // mergeResult 会原地增强 a1Item，先 clone 避免污染
const jxgjResult = jxgjAdapter.mergeResult(jxgjRaw, a2ItemRaw, jxgjCompiled)
console.log(`    mergeResult: status=${jxgjResult.status}, data.inputData.cangwei_arr.length=${jxgjResult.data?.inputData?.cangwei_arr?.length || 0}, date_obj 日期数=${jxgjResult.data?.inputData?.date_obj ? Object.keys(jxgjResult.data.inputData.date_obj).length : 0}`)

// 抓 a2 项存盘
const a2Item = jxgjResult.data?.inputData
if (!a2Item) fail('❌ jxgj mergeResult 没返回 data.inputData', 7)
writeJson('jxgj-a2-item.json', a2Item)

// 打印 a2[0].cangwei_arr[0] 字段名（核心：jxgj 给的字段）
const cangweiArrSample = a2Item.cangwei_arr?.[0] || {}
console.log(`\n    ★ jxgj cangwei_arr[0] 字段: ${Object.keys(cangweiArrSample).join(' | ')}`)
console.log(`      H航班号=${cangweiArrSample.H航班号} C出发机场=${cangweiArrSample.C出发机场} D到达机场=${cangweiArrSample.D到达机场}`)
console.log(`      C出发城市=${cangweiArrSample.C出发城市} D到达城市=${cangweiArrSample.D到达城市} H航司名=${cangweiArrSample.H航司名}`)
console.log(`      C出发日期=${cangweiArrSample.C出发日期} dijia=${cangweiArrSample.dijia} C成人总票价_CNY_INT=${cangweiArrSample.C成人总票价_CNY_INT}`)

// ==========================================================================
// Step 4: 从 a2 取第一个 dateKey/dateValue，跑 1 个 trip 任务（真实 HTTP POST gzip）
// ==========================================================================
console.log(`\n[4] 跑 1 个 trip 任务（真实 HTTP POST gzip）...`)
const dateObj = a2Item.date_obj || {}
const dateKeys = Object.keys(dateObj)
if (dateKeys.length === 0) fail('❌ a2 项 date_obj 为空，无法生成 trip 任务', 8)
const firstDateKey = dateKeys[0]
const firstDateValue = dateObj[firstDateKey]
console.log(`    取 a2[0].date_obj 第一项: dateKey=${firstDateKey}, dateValue.length=${firstDateValue.length}`)

const tripTaskData = {
  id: 'snapshot_trip_0',
  source: a2Item,
  dateKey: firstDateKey,
  dateValue: firstDateValue
}

const tripPrepared = tripAdapter.prepareRequest(tripTaskData, firstDateKey, tripCompiled)
console.log(`    prepared: segments.length=${tripPrepared.segments.length}, validatingCarrier=${tripPrepared.validatingCarrier}`)
console.log(`    segments[0]: ${JSON.stringify(tripPrepared.segments[0])}`)

const tripLoginResult = await tripAdapter.login(tripCred)
const tripCtx = { credential: tripCred, loginResult: tripLoginResult, platformConfig: tripCompiled }

let tripRaw
try {
  tripRaw = await tripAdapter.request(tripPrepared, tripCtx)
} catch (err) {
  console.error(`❌ trip 请求抛错: ${err.message}`)
  writeJson('trip-error.json', { error: err.message, stack: err.stack })
  fail('trip 请求失败', 9)
}
console.log(`    trip rawResponse: statusCode=${tripRaw.statusCode}, body.length=${tripRaw.body?.length || 0} bytes`)

// 抓 trip 原始响应（body 是 gzip Buffer，先解压 JSON 化再存）
let tripResData = null
let tripDecodeError = null
try {
  const { gunzipSync } = await import('node:zlib')
  const bodyStr = gunzipSync(tripRaw.body).toString('utf8')
  tripResData = JSON.parse(bodyStr)
} catch (err) {
  tripDecodeError = { message: err.message, bodyHead: tripRaw.body?.slice(0, 200)?.toString('utf8') }
}
writeJson('trip-raw.json', {
  statusCode: tripRaw.statusCode,
  headers: tripRaw.headers,
  resData: tripResData,
  decodeError: tripDecodeError
})

if (!tripResData) fail('❌ trip 响应解压/解析失败', 10)
console.log(`    trip Ack=${tripResData.Ack}, flights.length=${tripResData.responseBody?.flights?.length || 0}, lowPrices.length=${tripResData.responseBody?.lowPrices?.length || 0}`)

// 打印 trip flights[0] / lowPrices[0].prices[0] 字段名（核心：trip 给的字段）
const flightsSample = tripResData.responseBody?.flights?.[0] || {}
const lowPricesSample = tripResData.responseBody?.lowPrices?.[0] || {}
const pricesSample = lowPricesSample.prices?.[0] || {}
console.log(`\n    ★ trip flights[0] 字段: ${Object.keys(flightsSample).join(' | ')}`)
console.log(`      flightNo=${flightsSample.flightNo} departAirport=${flightsSample.departAirport} arriveAirport=${flightsSample.arriveAirport} takeOffDateTime=${flightsSample.takeOffDateTime} flightId=${flightsSample.flightId}`)
console.log(`    ★ trip lowPrices[0] 字段: ${Object.keys(lowPricesSample).join(' | ')}`)
console.log(`      flightRefs=${JSON.stringify(lowPricesSample.flightRefs)}`)
console.log(`    ★ trip lowPrices[0].prices[0] 字段: ${Object.keys(pricesSample).join(' | ')}`)
console.log(`      baggage=${pricesSample.baggage} showState=${pricesSample.showState} isOwn=${pricesSample.isOwn} sortIndicator=${pricesSample.sortIndicator}`)

// ==========================================================================
// Step 5: 跑 mergeResult 拿 processedData + 比价计数
// ==========================================================================
console.log(`\n[5] 跑 trip mergeResult（priceComparisonPolicy）...`)
const tripResult = tripAdapter.mergeResult(tripRaw, tripTaskData, tripCompiled)
console.log(`    status=${tripResult.status}, processedData.length=${tripResult.processedData?.length || 0}`)

writeJson('trip-processed.json', {
  status: tripResult.status,
  processedDataCount: tripResult.processedData?.length || 0,
  processedDataSample: tripResult.processedData?.[0] || null,
  originalDataCount: tripResult.originalDataCount,
  flightCount: tripResult.flightCount,
  lowPriceCount: tripResult.lowPriceCount
})

// ==========================================================================
// Step 6: 写 summary.json（含字段名对照 + 0 条根因假设）
// ==========================================================================
const summary = {
  generatedAt: new Date().toISOString(),
  inputFile: path.basename(xlsxPath),
  a1Count: a1.count,
  jxgj: {
    cangwei_arr_length: a2Item.cangwei_arr?.length || 0,
    date_obj_keys: dateKeys,
    cangwei_arr_0_fields: Object.keys(cangweiArrSample),
    cangwei_arr_0_values: {
      H航班号: cangweiArrSample.H航班号,
      C出发机场: cangweiArrSample.C出发机场,
      D到达机场: cangweiArrSample.D到达机场,
      C出发城市: cangweiArrSample.C出发城市,
      D到达城市: cangweiArrSample.D到达城市,
      H航司名: cangweiArrSample.H航司名,
      C出发日期: cangweiArrSample.C出发日期,
      dijia: cangweiArrSample.dijia,
      C成人总票价_CNY_INT: cangweiArrSample.C成人总票价_CNY_INT
    }
  },
  trip: {
    statusCode: tripRaw.statusCode,
    Ack: tripResData.Ack,
    flights_count: tripResData.responseBody?.flights?.length || 0,
    lowPrices_count: tripResData.responseBody?.lowPrices?.length || 0,
    flights_0_fields: Object.keys(flightsSample),
    flights_0_values: {
      flightNo: flightsSample.flightNo,
      departAirport: flightsSample.departAirport,
      arriveAirport: flightsSample.arriveAirport,
      takeOffDateTime: flightsSample.takeOffDateTime,
      flightId: flightsSample.flightId
    },
    lowPrices_0_fields: Object.keys(lowPricesSample),
    lowPrices_0_flightRefs: lowPricesSample.flightRefs,
    lowPrices_0_prices_0_fields: Object.keys(pricesSample),
    lowPrices_0_prices_0_values: {
      baggage: pricesSample.baggage,
      showState: pricesSample.showState,
      isOwn: pricesSample.isOwn,
      sortIndicator: pricesSample.sortIndicator
    }
  },
  processedData_count: tripResult.processedData?.length || 0,
  假设: []
}

// 自动根因分析
const jxgjFields = new Set(Object.keys(cangweiArrSample))
const tripFlightFields = new Set(Object.keys(flightsSample))
const jxgjNeedFromFlight = ['H航班号', 'C出发机场', 'D到达机场', 'C出发日期']
const tripFlightHas = ['flightNo', 'departAirport', 'arriveAirport', 'takeOffDateTime']

if (summary.trip.flights_count === 0) {
  summary.假设.push('⚠️ trip API 返回 flights=[] → 可能账密错误返回空数据 / 该航线无航班 / 航班已售罄')
} else {
  // 检查字段名是否对得上
  const missingJxgj = jxgjNeedFromFlight.filter(f => !jxgjFields.has(f))
  if (missingJxgj.length) summary.假设.push(`⚠️ jxgj cangwei_arr 缺字段: ${missingJxgj.join(', ')}`)
  const missingTrip = tripFlightHas.filter(f => !tripFlightFields.has(f))
  if (missingTrip.length) summary.假设.push(`⚠️ trip flights 缺字段: ${missingTrip.join(', ')}`)
}

if (summary.processedData_count === 0 && summary.trip.flights_count > 0 && summary.trip.lowPrices_count > 0) {
  // 字段都对得上但比赢=0 → 业务上 dijia > sortIndicator
  const dijia = Number(cangweiArrSample.dijia) || 0
  const sortIndicator = Number(pricesSample.sortIndicator) || 0
  summary.假设.push(`⚠️ 字段齐全但 processedData=0 → 可能业务比输：cangwei_arr[0].dijia=${dijia} vs prices[0].sortIndicator=${sortIndicator} (dijia > sortIndicator → 不入队)`)
}

if (summary.假设.length === 0) {
  summary.假设.push('✅ 字段名对得上 + 接口返回非空 + processedData 非空 → 当前测试样本无法复现 0 条问题，需要更多任务样本')
}

writeJson('summary.json', summary)

console.log(`\n✅✅✅ 快照抓取完成 ✅✅✅`)
console.log(`  快照目录: ${SNAP_DIR}`)
console.log(`  文件:`)
for (const f of ['jxgj-raw.json', 'jxgj-a2-item.json', 'trip-raw.json', 'trip-processed.json', 'summary.json']) {
  const fp = path.join(SNAP_DIR, f)
  const size = fs.existsSync(fp) ? (fs.statSync(fp).size / 1024).toFixed(2) + ' KB' : '(未生成)'
  console.log(`    - ${f}  ${size}`)
}
console.log(`\n  根因假设:`)
for (const h of summary.假设) console.log(`  ${h}`)

// 清理临时 userData（不删 snapshots，方便后续分析）
fs.rmSync(TMP_USERDATA, { recursive: true, force: true })
process.exit(0)

// ============================================================
function writeJson(name, obj) {
  const fp = path.join(SNAP_DIR, name)
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf-8')
}
function fail(msg, code) {
  console.error(msg)
  process.exit(code)
}
