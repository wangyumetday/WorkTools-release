// xlsx worker 客户端（主进程侧，2026-09-30）
//
// 职责：把 SheetJS 的同步读/写（readFile / aoa_to_sheet+writeFile）放到 worker 线程执行，
//   主进程只等结果 —— 这样无论文件多大，主线程事件循环（以及 Windows 消息泵）都不会被堵住。
//
// 安全设计（用户要求"确定不会改出问题"）：
//   - 逻辑零改动：worker 内调用与主进程同一份 parsePolicyAoa / centerSheetCells，写盘调用序列一致
//   - 任何异常（工厂不可用 / 启动失败 / 运行错误 / 超时 / 非零退出）都返回"未处理"，
//     调用方**回退到原有的进程内同步实现** → 最坏情况等于改造前的行为，绝不会更糟
//   - PCP_DISABLE_XLSX_WORKER=1 可一键关掉 worker（排障用）
//   - setXlsxWorkerFactory() 供测试注入（Node 下单测 worker 通路）
// 说明：本模块自身不 import xlsx / 解析逻辑 —— 重活都在 worker 内完成；
//   回退路径由调用方（FileManager / ExcelExporter）用它自己已有的实现执行。

const TIMEOUT_MS = 5 * 60 * 1000   // 5 分钟上限（正常几百毫秒~几秒）

let injectedFactory = null
let factoryPromise = null

/** 注入 worker 工厂（(options) => Worker）；传 null 恢复默认 */
export function setXlsxWorkerFactory(fn) {
  injectedFactory = fn || null
  factoryPromise = null
}

async function getFactory() {
  if (injectedFactory) return injectedFactory
  if (!factoryPromise) {
    // 动态 import：把 `?nodeWorker` 后缀（electron-vite 打包期解析）收在单独入口文件里，
    // 这样本模块在纯 Node 环境下也能被加载（拿不到工厂 → 走回退）
    factoryPromise = import('./xlsxWorkerEntry.js')
      .then(m => (typeof m.default === 'function' ? m.default : null))
      .catch(() => null)
  }
  return factoryPromise
}

/** 跑一次 worker 任务（单次任务一个 worker，用完即退） */
async function runJob(job) {
  if (process.env.PCP_DISABLE_XLSX_WORKER === '1') {
    return { ok: false, error: '已通过 PCP_DISABLE_XLSX_WORKER=1 禁用' }
  }
  const factory = await getFactory()
  if (!factory) return { ok: false, error: 'worker 工厂不可用（打包产物缺失或非 electron 环境）' }

  return await new Promise((resolve) => {
    let worker
    try {
      worker = factory({ workerData: job })
    } catch (e) {
      return resolve({ ok: false, error: `worker 启动失败: ${e?.message || e}` })
    }
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { Promise.resolve(worker.terminate?.()).catch(() => {}) } catch { /* ignore */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `worker 超时（>${TIMEOUT_MS}ms）` }), TIMEOUT_MS)
    worker.once('message', (m) => finish(m && typeof m === 'object' ? m : { ok: false, error: 'worker 返回异常' }))
    worker.once('error', (e) => finish({ ok: false, error: `worker 错误: ${e?.message || e}` }))
    worker.once('exit', (code) => { if (code !== 0) finish({ ok: false, error: `worker 非正常退出（code=${code}）` }) })
  })
}

/**
 * worker 线程读政策文件（读盘 + 解析，与 FileManager.readPolicyFile 同源）
 * @returns {Promise<{success:true,fileName:string,headers:string[],keyColMap:object,rows:any[][]}
 *                   |{success:false,error:string}
 *                   |null>}  null = worker 不可用/失败，调用方应回退进程内读盘
 */
export async function readPolicyFileOffThread(filePath) {
  const r = await runJob({ type: 'readPolicy', filePath })
  if (r?.ok && r.result) return r.result
  console.warn(`[pcp:xlsxWorker] 政策文件转进程内解析：${r?.error || '未知原因'}`)
  return null
}

/**
 * worker 线程写 xlsx（列宽/居中样式与主进程同源）
 * @param {{filePath:string, sheetName:string, aoa?:any[][], worksheet?:object, rowBgColors?:any[]}} job
 *        aoa 存在 → worker 现场建表（省掉主进程的 aoa_to_sheet）；否则用主进程已建好的 worksheet
 * @returns {Promise<boolean>} true = 已由 worker 写好；false = 调用方应回退进程内写盘
 */
export async function writeSheetOffThread(job) {
  const r = await runJob({ type: 'writeSheet', ...job })
  if (r?.ok) return true
  console.warn(`[pcp:xlsxWorker] xlsx 写盘转进程内：${r?.error || '未知原因'}`)
  return false
}
