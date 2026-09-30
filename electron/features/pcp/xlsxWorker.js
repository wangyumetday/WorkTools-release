// xlsx 重活 worker（2026-09-30）
//
// 为什么需要它：SheetJS 的 readFile / writeFile 是**纯同步**调用，无法分片、也无法被定时器打断
//   （定时器回调只是排队在同一条事件循环上，而 Windows 消息泵就挂在主进程这条线程上）。
//   真实数据实测：政策文件（4935 行 × 147 列 / 23.68MB）readFile 2.6s、
//   系统导入文件 writeFile 1.4s + aoa_to_sheet 0.5s —— 这些都会让窗口"未响应"。
//   放进 worker 线程后，堵的是那根线程，主线程事件循环与消息泵全程照常运行。
//
// 设计要点（保证"不改变任何业务结果"）：
//   - 只搬执行线程，不搬逻辑：读盘解析调用与主进程同一份纯函数 parsePolicyAoa；
//     写盘调用与主进程同一套 XLSX.utils.* + centerSheetCells + writeFile 序列
//   - 单次任务一个 worker（workerData 传参、postMessage 回结果、用完即退），不做常驻池
//   - 任何失败都由主进程侧 xlsxWorkerClient 捕获并**回退到进程内原实现**
import { parentPort, workerData } from 'node:worker_threads'
import path from 'node:path'
import XLSX from 'xlsx'
import { parsePolicyAoa } from './policyWriteback.js'
import { centerSheetCells } from './xlsxSheet.js'

function reply(msg) {
  try { parentPort.postMessage(msg) } catch (e) {
    // 结果无法序列化（理论上不会发生）→ 退化为错误上报
    try { parentPort.postMessage({ ok: false, error: `结果回传失败: ${e?.message}` }) } catch { /* ignore */ }
  }
}

function handle(job) {
  const type = job?.type
  if (type === 'readPolicy') {
    // 与 FileManager.readPolicyFile 完全同源的调用序列
    const workbook = XLSX.readFile(job.filePath)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const aoa = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null })
    return parsePolicyAoa(aoa, path.basename(job.filePath))
  }

  if (type === 'writeSheet') {
    // 与 ExcelExporter 完全同源的调用序列：
    //   aoa 存在 → 现场建表；否则用主进程已建好的 worksheet（json_to_sheet 那条路）
    const ws = job.aoa ? XLSX.utils.aoa_to_sheet(job.aoa) : job.worksheet
    centerSheetCells(ws, job.rowBgColors || [])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, ws, job.sheetName)
    XLSX.writeFile(workbook, job.filePath)
    return { written: true, path: job.filePath }
  }

  throw new Error(`未知的 worker 任务类型: ${type}`)
}

try {
  const result = handle(workerData)
  reply({ ok: true, result })
} catch (e) {
  reply({ ok: false, error: e?.message || String(e) })
}
