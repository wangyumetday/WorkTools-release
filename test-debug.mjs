// ============================================================
// PCP 完整链路 debug 脚本（脱离 Electron 窗口，Node 直接跑）
// 用法：node test-debug.mjs
// 作用：用 testFiles/FA-3.xlsx 跑完整流程（parseXlsx → JXGJ任务→a2 → O任务→a3 → exportResult）
//       在每个关键节点打印数量，一眼看出哪一步数据掉了（哪一步=0 就是断点）
//
// 关键说明：
//   真实的 g1Request/o1Request 需要联网调接口，因此在 debug 时我们直接在
//   TaskManager 原型上用 mock 覆盖真实函数（直接替换 executeJxgjTask/executeTripTask/
//   executeOComboTask），这样完全不走网络、不需要账号、不会被 compileFormula
//   里任何真实字段卡住，纯粹测"链路数据流转"。
//   如果连 mock 都出不来 a3，那一定是代码逻辑 bug（和网络/账号无关）。
// ============================================================
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------- 根目录 + 临时 data 目录（脚本独立，不会污染真实 AppData） ----------
const ROOT = __dirname
const TMP_DIR = path.join(ROOT, 'testFiles', '.tmp-run')
const TMP_DATA = path.join(TMP_DIR, 'userData')
const TMP_DOWNLOAD_DIR = path.join(TMP_DIR, 'out')
for (const p of [TMP_DATA, TMP_DOWNLOAD_DIR]) fs.mkdirSync(p, { recursive: true })
cleanDir(TMP_DATA); cleanDir(TMP_DOWNLOAD_DIR)
function cleanDir(p) {
  if (!fs.existsSync(p)) return
  for (const f of fs.readdirSync(p)) {
    const fp = path.join(p, f)
    try { fs.rmSync(fp, { recursive: true, force: true }) } catch {}
  }
}

// ---------- 手动 import ESM ----------
import { FileManager } from './electron/features/pcp/fileManager.js'
import { TaskManager } from './electron/features/pcp/taskManager.js'
import { CredentialManager } from './electron/features/pcp/credentialManager.js'
import { ConfigManager } from './electron/features/pcp/configManager.js'

// ==========================================================================
//  Step 1. 解析 Excel，看列名读出来是不是 a1 需要的 CF_jichang / DD_jichang / hangsi
// ==========================================================================
const xlsxPath = path.join(ROOT, 'testFiles', 'FA-3.xlsx')
if (!fs.existsSync(xlsxPath)) { fail('❌ FA-3.xlsx 不存在', 1) }

const DESKTOP_FAKE = TMP_DOWNLOAD_DIR
const fm = new FileManager(TMP_DATA, DESKTOP_FAKE)
const pr = fm.parseXlsx(xlsxPath)
if (!pr.success) fail('❌ parseXlsx 失败: ' + pr.error, 2)
const a1 = fm.getA1()
console.log(`[1] parseXlsx OK. a1.count=${a1.count}`)
console.log(`    a1[0] 列: ${Object.keys(a1.data[0] || {}).join(' | ')}`)
const s0 = a1.data[0] || {}
console.log(`    CF=${s0.CF_jichang}  DD=${s0.DD_jichang}  hangsi=${s0.hangsi}  cw=${s0.cangwei_str}`)
if (!s0.hangsi || !s0.cangwei_str) {
  console.log(`    ⚠️  a1 缺少 hangsi 或 cangwei_str，parseXlsx 读 cabin/airline_code 错了 — 我们兜底用固定值`)
}

// ==========================================================================
//  Step 2. 初始化 manager + 塞入 2 个假账号（jxgj + trip 各一个，且都选中）
// ==========================================================================
const credentialManager = new CredentialManager(TMP_DATA)
const configManager = new ConfigManager(TMP_DATA)
credentialManager.add({ platform: 'jxgj', name: '测试-锦绣', username: 'u1', password: 'p1', remark: '', status: true })
credentialManager.add({ platform: 'trip', name: '测试-携程', username: 'u2', password: 'p2', remark: '', status: true })
const jxCred = credentialManager.list().credentials.find(c => c.platform === 'jxgj')
const triCred = credentialManager.list().credentials.find(c => c.platform === 'trip')
credentialManager.select(jxCred.id)
credentialManager.select(triCred.id)
console.log(`[2] 注入账号 OK: jxgj=${!!credentialManager.getSelected('jxgj')}, trip=${!!credentialManager.getSelected('trip')}`)

// ==========================================================================
//  Step 3. 初始化 TaskManager（注册回调，并在 onAllComplete 里调用 fm.saveStageResults）
// ==========================================================================
let lastAllCompleteStage = null
const taskManager = new TaskManager({
  credentialManager,
  configManager,
  onProgress: () => {},
  onAllComplete: (completedTasks, stage) => {
    console.log(`  ▶ onAllComplete 触发：stage=${stage}, completed=${completedTasks.length}`)
    lastAllCompleteStage = stage
    fm.saveStageResults(stage, completedTasks)
  }
})

// ------ 核心！直接在实例上 mock 掉所有平台请求，完全不走网络 ------
// 我们 mock 字段完全对齐真实代码需要的字段：
//   JXGJ inputData: { ...a1row, cangwei_arr, date_obj }
//     cangwei_arr[i]: { C出发城市, D到达城市, C出发机场, D到达机场, H航司名, H航班号,
//                      C出发时间_Date, C舱位, C成人总票价_CNY, dijia, kuishun, C出发日期 }
//     date_obj: { '2026-xx-xx': [...cangwei_arr items], ... }
//
//   O 组合 trip.processedData[i]: { H航司名, C出发机场, D到达机场, C舱位,
//                                    C出发日期, C成人总票价_CNY, dijia,
//                                    CUT_VALUE (加减价), XC_dijia }
taskManager.executeJxgjTask = async function mockExecuteJxgj(a1Row) {
  const cwItems = Array.from(a1Row.cangwei_str || 'Y')
  const today = new Date()
  const cangweiArr = []
  for (let i = 0; i < cwItems.length; i++) {
    const cw = cwItems[i]
    for (let d = 0; d < 3; d++) {   // 每舱位 × 3 天
      const dt = new Date(today.getTime() + (d + 5) * 86400000) // d+5 满足 >3 天过滤
      const dateStr = dt.toISOString().slice(0, 10)
      const price = 1000 + d * 150 + i * 50
      cangweiArr.push({
        C出发城市: a1Row.CH_city || a1Row.CF_jichang || 'SH',
        D到达城市: a1Row.DD_city || a1Row.DD_jichang || 'TYO',
        C出发机场: a1Row.CF_jichang || 'PVG',
        D到达机场: a1Row.DD_jichang || 'NRT',
        H航司名: a1Row.hangsi || 'CA',
        H航班号: `${a1Row.hangsi || 'CA'}${100 + d}`,
        C出发时间_Date: `${dateStr} 08:00:00`,
        C到达时间_Date: `${dateStr} 12:00:00`,
        C舱位: cw,
        C成人总票价_CNY: price,
        S剩余座位数: 9,
        dijia: Math.ceil(price * 0.9),
        kuishun: Math.round((price * 0.1) * 100) / 100,
        C出发日期: dateStr
      })
    }
  }
  const date_obj = {}
  cangweiArr.forEach(it => (date_obj[it.C出发日期] = date_obj[it.C出发日期] || []).push(it))
  return {
    platform: 'jxgj',
    status: 'success',
    data: {
      queryId: 'MOCK-' + Date.now(),
      inputData: { ...a1Row, cangwei_arr: cangweiArr, date_obj },
      result: cangweiArr,
      processedValue: cangweiArr.length
    }
  }
}

taskManager.executeOComboTask = async function mockExecuteOCombo(taskData) {
  // 真实 executeOComboTask 会并行调 trip/o2/o3 三个有账号的平台，结果形如 { trip: {...}, o2: {...} }
  // 我们让 trip 返回 processedData，o2/o3 跳过（因为没账号）
  const dv = Array.isArray(taskData.dateValue) ? taskData.dateValue : []
  const processedData = dv.map(it => ({
    H航司名: it.H航司名 || 'CA',
    C出发机场: it.C出发机场,
    D到达机场: it.D到达机场,
    C舱位: it.C舱位,
    C出发日期: it.C出发日期,
    C成人总票价_CNY: it.C成人总票价_CNY,
    dijia: it.dijia,
    CUT_VALUE: -50,    // 固定加 -50 元（降价 50）
    XC_dijia: (it.dijia || 1000) - 30
  }))
  return {
    trip: {
      platform: 'trip',
      status: 'ok',
      processedData,
      originalDataCount: dv.length,
      _usedCredential: { platform: 'trip', name: '测试-携程' }
    }
  }
}

// ==========================================================================
//  Step 4. 生成锦绣国际阶段 任务，start('jxgj')，等待全部跑完
// ==========================================================================
console.log(`[3] 生成锦绣国际任务 ${a1.data.length} 个 + start`)
taskManager.addBatch(a1.data.map(row => ({ type: 'jxgj', data: row })))
const r1 = taskManager.start('jxgj')
if (!r1.success) fail('❌ JXGJ 阶段启动失败: ' + r1.message, 3)
await waitRunning(taskManager, 60_000, 'JXGJ阶段')

const a2 = fm.getA2()
console.log(`[4] JXGJ 阶段完成. a2.count=${a2.count}`)
console.log(`    a2[0] keys: ${Object.keys(a2.data[0] || {}).join(' | ')}`)
const dateObj = a2.data[0]?.date_obj || null
console.log(`    a2[0].date_obj 存在? ${!!dateObj} — keys: ${dateObj ? Object.keys(dateObj).join(',') : '无'}`)
console.log(`    a2[0].cangwei_arr 长度: ${(a2.data[0]?.cangwei_arr || []).length}`)
if (a2.count === 0) fail('❌ a2=0，saveA2FromJxgjTasks 没有写数据', 4)
if (!dateObj) fail('❌ a2 首项没有 date_obj — JXGJ 请求返回结构不对 / saveA2 取错字段', 5)

// ==========================================================================
//  Step 5. 生成 O 组合阶段任务（完全对齐 controller.task:addBatchByStage 的拆分规则）
// ==========================================================================
console.log(`[5] 生成 O 组合任务（按 date_obj 日期拆）`)
const oBatch = []
for (const item of a2.data) {
  const dobj = item?.date_obj
  if (!dobj) {
    console.log(`    兜底：A2 项(${item.id}) 无 date_obj，整项 1 个 O 任务`)
    oBatch.push({ type: 'o_combo', data: { id: item.id, source: item, dateKey: null, dateValue: null } })
    continue
  }
  for (const [dateKey, dateValue] of Object.entries(dobj)) {
    oBatch.push({
      type: 'o_combo',
      data: { id: `${item.id}__${dateKey}`, source: item, dateKey, dateValue }
    })
  }
}
console.log(`    O 任务数 = ${oBatch.length}`)
if (oBatch.length > 0) {
  const first = oBatch[0].data
  console.log(`    首个 O 任务: dateKey=${first.dateKey}, dateValue.length=${(first.dateValue || []).length}`)
  if (first.dateValue?.[0]) {
    const f = first.dateValue[0]
    console.log(`      → C出发城市=${f.C出发城市}  D到达城市=${f.D到达城市}  H航司名=${f.H航司名}  舱位=${f.C舱位}  票价=${f.C成人总票价_CNY}  dijia=${f.dijia}`)
  }
}

taskManager.clearAll()
taskManager.addBatch(oBatch)
const r2 = taskManager.start('o_combo')
if (!r2.success) fail('❌ O 阶段启动失败: ' + r2.message, 6)
await waitRunning(taskManager, 120_000, 'O组合阶段')

const a3 = fm.getA3()
console.log(`[6] O 阶段完成. a3.count=${a3.count}`)
console.log(`    a3[0] 列: ${Object.keys(a3.data[0] || {}).join(' | ')}`)
if (a3.count === 0) fail('❌ a3.count=0 → 这就是"没有数据请先完成O平台阶段"的直接根因！检查 saveA3FromOTasks 取值字段', 7)

// ==========================================================================
//  Step 6. exportResult 导出 Excel
// ==========================================================================
console.log(`[7] 导出 result.xlsx 到 ${TMP_DOWNLOAD_DIR}`)
const er = fm.exportResult(TMP_DOWNLOAD_DIR, 'result.xlsx', p => {
  if (p === 0 || p === 30 || p === 60 || p === 100 || p === -1) console.log(`    → 导出进度: ${p}%`)
})
if (!er.success) fail('❌ 导出失败: ' + er.error, 8)

const size = (fs.statSync(er.path).size / 1024).toFixed(2)
console.log(`
✅✅✅ 全链路跑通！✅✅✅
  A1 (Excel 原始)     : ${a1.count} 行
  A2 (锦绣国际后)     : ${a2.count} 行 × date_obj 日期 = ${oBatch.length} 个 O 任务
  A3 (O 比价后)       : ${a3.count} 行政策
  导出文件            : ${er.path}
  文件大小            : ${size} KB
  数据字段样例（A3[0]）:
${JSON.stringify(a3.data[0], null, 4).split('\n').map(l => '    ' + l).join('\n')}
`)

// 收尾：不删临时目录，方便你打开 result.xlsx 看数据；删掉 userData 下的中间 json
cleanDir(TMP_DATA)
process.exit(0)

// ============================================================
function waitRunning(tm, timeoutMs, label) {
  return new Promise((res, rej) => {
    const end = Date.now() + timeoutMs
    const iv = setInterval(() => {
      if (!tm.getState().isRunning) { clearInterval(iv); res(true) }
      else if (Date.now() > end) { clearInterval(iv); rej(new Error(label + ' 超时')) }
    }, 200)
  })
}
function fail(msg, code) { console.error(msg); process.exit(code) }
