// ============================================================
// ASS 查询流程编排器（核心）
//
// 主流程：
//   1) 解析 Excel → 航线对 pairs
//   2) 展开日期区间 → 按天分组的 QueryParam 二维数组（按天串行，日内按航线顺序）
//   3) Phase 1：逐天 / 逐航线 请求锦绣 → 判定 hasFlight → 调 processP1 → appendP1
//              并把 hasFlight 存到内存 Map（KEY = dep|arr|airline|date）
//   4) Phase 2：逐天 / 逐航线 看 hasFlight：
//                true/null → 调 tripQuery (seam) → status=OK|ERROR；false → status=SKIP
//              调 processP2 → appendP2
//   5) 关闭文件句柄 → 返回汇总
//
// 错误策略：单条 QueryParam 错误不中断整体流程；每个阶段出错时在对应文件写 error 行
// UNKNOWN 放行规则（§8.3）：Phase 1 hasFlight===null 时 Phase 2 当作"有航班"去请求携程
// ============================================================

import path from 'node:path'
import { parseAirportPairsFromXlsx } from './excelParser.js'
import { fetchList as fetchJinXiu } from './jxgjClient.js'
import { createPairedJsonlWriters } from './outputWriter.js'
import { processP1 } from './userHooks/processP1.js'
import { processP2 } from './userHooks/processP2.js'
import { tripQuery } from './tripClient.js'
import { addFlights, snapshot as tjSnapshot, dumpGroups } from './tjStats.js'
import { writeTjarrReport } from './reportWriter.js'

// ---------- 工具 ----------

/** YYYY-MM-DD 字符串 → Date 对象（本地时区 0 点，避免 UTC 偏移） */
function parseDateYYYYMMDD(s) {
  if (s instanceof Date) return s
  // 兜底：数字 timestamp（毫秒）—— 某些 UI（naive-ui daterange）在 value-format 失效时会直接传 number
  if (typeof s === 'number') {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate())
    }
  }
  const str = String(s)
  // YYYY-MM-DD 串：按本地时区解析
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str)
  if (m) {
    const [, y, mo, d] = m
    return new Date(Number(y), Number(mo) - 1, Number(d))
  }
  // 再兜底：new Date 通用解析（兼容 ISO / 其他字符串格式）
  const d = new Date(str)
  if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), d.getDate())
  throw new Error(`日期格式错误（需要 YYYY-MM-DD）：${s}`)
}

function formatDateYYYYMMDD(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 展开闭区间日期（含首尾） */
function expandDateRange(startStr, endStr) {
  const s = parseDateYYYYMMDD(startStr)
  const e = parseDateYYYYMMDD(endStr)
  if (s.getTime() > e.getTime()) {
    throw new Error(`开始日期 (${startStr}) 不能晚于结束日期 (${endStr})`)
  }
  const dates = []
  const cur = new Date(s)
  while (cur.getTime() <= e.getTime()) {
    dates.push(formatDateYYYYMMDD(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

/** 生成 QueryParam 的内存 key（唯一标识一条查询参数） */
function qpKey(qp) {
  return `${qp.dep}|${qp.arr}|${qp.airline ?? ''}|${qp.date}`
}

/** 安全调用用户 process 函数；抛错时返回带 error 字段的 fallback 行 */
function safeCallProcess(fn, ctx, fallbackMaker) {
  try {
    const r = fn(ctx)
    return r === undefined || r === null ? fallbackMaker(ctx, null) : r
  } catch (processErr) {
    console.warn('[ass] 用户处理函数抛出异常，已改为 fallback 行写入文件：', processErr.message)
    return fallbackMaker(ctx, processErr)
  }
}

// ---------- QueryParam → GetList 映射（§4.2.1.3）----------

/**
 * QueryParam { dep, arr, airline, date } → 锦绣 GetList query
 */
function buildJinXiuQuery(qp) {
  const q = {
    depAirPort: qp.dep,
    arrAirPort: qp.arr,
    PageSize:   200,
  }
  if (qp.airline) q.carrier = qp.airline // 空字符串/null → 不传
  if (qp.date)    q.depDate = `${qp.date}T00:00:00`
  return q
}

/**
 * hasFlight 判定（§4.2.1.4）
 * @returns {{ hasFlight: boolean|null, rawResponse: any, error: Error|null }}
 */
async function judgeHasFlight(qp) {
  let rawResponse = null
  let error = null
  try {
    rawResponse = await fetchJinXiu(buildJinXiuQuery(qp), 1, 200)
  } catch (e) {
    error = e
  }
  if (error) {
    return { hasFlight: null, rawResponse: null, error }
  }
  if (rawResponse.Msg !== 'OK') {
    return {
      hasFlight: null,
      rawResponse,
      error: new Error(`锦绣业务异常：${rawResponse.Msg || '未知错误'}`),
    }
  }
  const total = rawResponse.Content?.Total ?? 0
  const list  = rawResponse.Content?.List  ?? []
  const hasFlight = total > 0 || list.length > 0
  return { hasFlight, rawResponse, error: null }
}

// ---------- 主流程 ----------

/**
 * 运行完整 ASS 流程：解析 → P1 → P2 → 落盘
 *
 * @param {object}   opts
 * @param {string}   opts.filePath           绝对路径 .xlsx
 * @param {string}   [opts.airline]          航司，空字符串视为不指定
 * @param {string}   opts.startDate          开始日期 YYYY-MM-DD（闭区间）
 * @param {string}   opts.endDate            结束日期 YYYY-MM-DD（闭区间）
 * @param {string}   opts.outputDir          输出目录（绝对路径）
 * @param {Function} [opts.onProgress]       进度回调 (payload) => void
 *   payload: { phase: 'P1'|'P2', date: string, index:number, total:number,
 *              qp: QueryParam, result: string, message?: string }
 * @param {Function} [opts.requestLogin]     预留：携程登录回调 () => Promise<boolean>
 * @param {object}   [opts.session]          预留：携程会话 / cookies
 * @returns {Promise<RunResult>}
 *
 * @typedef {object} RunResult
 * @property {string}  ts                     任务时间戳
 * @property {string}  outputDir
 * @property {string}  p1FilePath
 * @property {string}  p2FilePath
 * @property {object}  parseInfo              { pairsCount, hasHeader, skippedRows, duplicateCount }
 * @property {number}  dateCount              展开日期数
 * @property {number}  queryParamTotal        R × D 总数
 * @property {object}  counts
 *   { p1:{true,false,null}, p2:{OK,SKIP,ERROR}, userHookErrors:number }
 */
export async function runAssTask(opts) {
  const {
    filePath,
    airline: airlineRaw = '',
    startDate,
    endDate,
    outputDir,
    onProgress = () => {},
    requestLogin = null,
    session = null,
  } = opts

  if (!filePath)  throw new Error('filePath 必填')
  if (!startDate) throw new Error('startDate 必填')
  if (!endDate)   throw new Error('endDate 必填')
  if (!outputDir) throw new Error('outputDir 必填')

  const airline = typeof airlineRaw === 'string' ? airlineRaw.trim() : ''

  // --- 步骤 1：解析 Excel ---
  const parseResult = await parseAirportPairsFromXlsx(filePath)
  const { pairs, skippedRows, duplicateCount, hasHeader } = parseResult
  if (!pairs || pairs.length === 0) {
    throw new Error('Excel 解析后没有有效航线对，请检查文件内容')
  }

  // --- 步骤 2：展开日期 + 按天分组 ---
  const dates = expandDateRange(startDate, endDate)
  const dateCount = dates.length

  // days: Array<dateStr, qps: QueryParam[]> —— 按顺序保留天内航线顺序
  const days = dates.map((d) => ({
    date: d,
    qps: pairs.map((p) => ({
      dep: p.dep,
      arr: p.arr,
      airline: airline || null,
      date: d,
    })),
  }))

  const R = pairs.length
  const D = dates.length
  const total = R * D

  // --- 步骤 3：创建 P1/P2 输出对 ---
  const writers = await createPairedJsonlWriters({ outputDir })
  const hasFlightMap = new Map() // key=qpKey → boolean|null
  /** tjarr 统计报告（md）路径；任务结束时写入 */
  let tjFilePath = null

  const counts = {
    p1: { true: 0, false: 0, null: 0 },
    p2: { OK: 0, SKIP: 0, ERROR: 0 },
    userHookErrors: 0,
  }

  function fallbackP1(ctx, hookErr) {
    if (hookErr) counts.userHookErrors++
    return {
      queryParam: ctx.queryParam,
      hasFlight:  ctx.hasFlight,
      raw:        ctx.rawResponse,
      error:      ctx.error ? { name: ctx.error.name, message: ctx.error.message } : null,
      _hookError: hookErr ? { name: hookErr.name, message: hookErr.message } : null,
    }
  }
  function fallbackP2(ctx, hookErr) {
    if (hookErr) counts.userHookErrors++
    return {
      queryParam: ctx.queryParam,
      status:     ctx.status,
      raw:        ctx.rawResponse,
      error:      ctx.error ? { name: ctx.error.name, message: ctx.error.message } : null,
      _hookError: hookErr ? { name: hookErr.name, message: hookErr.message } : null,
    }
  }

  try {
    // ========== Phase 1：锦绣预检（按天串行，日内按航线顺序）==========
    let processedP1 = 0
    for (const { date, qps } of days) {
      for (let i = 0; i < qps.length; i++) {
        const qp = qps[i]
        processedP1++
        const { hasFlight, rawResponse, error } = await judgeHasFlight(qp)
        hasFlightMap.set(qpKey(qp), hasFlight)
        counts.p1[hasFlight === null ? 'null' : String(hasFlight)]++

        const p1Ctx = { queryParam: qp, rawResponse, hasFlight, error: error || null }
        const p1Line = safeCallProcess(processP1, p1Ctx, fallbackP1)
        writers.appendP1(p1Line)

        // ---- 计算锦绣返回的数据条数（用于前端日志展示）----
        // 正常成功：Content.Total || Content.List.length；异常：0
        let count = 0
        if (rawResponse && rawResponse.Content) {
          count = Math.max(
            Number(rawResponse.Content.Total) || 0,
            Array.isArray(rawResponse.Content.List) ? rawResponse.Content.List.length : 0
          )
        }

        const resultTag =
          hasFlight === true  ? 'HAS_FLIGHT'
          : hasFlight === false ? 'NO_FLIGHT'
          : 'UNKNOWN'
        onProgress({
          type:  'P1_ITEM',  // 前端据此渲染结构化行 + 颜色
          phase: 'P1',
          date,
          index: processedP1,
          total,
          qp,
          result: resultTag,
          count,
          hasFlight,
          error: error ? { name: error.name, message: error.message } : null,
        })
      }
    }

    // ========== Phase 2：携程正式查询（同顺序，hasFlight=false 直接 SKIP）==========
    let processedP2 = 0
    for (const { date, qps } of days) {
      for (let i = 0; i < qps.length; i++) {
        const qp = qps[i]
        processedP2++
        const flag = hasFlightMap.get(qpKey(qp))
        let status = 'OK'
        let raw = null
        let err = null
        let count = 0

        if (flag === false) {
          // hasFlight=false → 跳过（写占位）
          status = 'SKIP'
          count  = 0
        } else {
          // true / null(UNKNOWN) → 都按"有航班"去请求携程（§8.3 宁查勿漏）
          try {
            raw = await tripQuery(qp, session, requestLogin)
            status = 'OK'
            // ---- 解析携程 mock / 真实返回的数据条数 ----
            // mock: Content.Total || Content.List.length；真实实现也要保持该字段结构
            if (raw && (raw.Content || raw._mock)) {
              count = Math.max(
                Number(raw.Content?.Total) || 0,
                Array.isArray(raw.Content?.List) ? raw.Content.List.length : 0
              )
            }
            // ---- 航班统计（tjarr）：按 agencyCode 累计本单全部航班 ----
            if (raw && Array.isArray(raw.data?.lowPrices)) {
              addFlights(raw.data.lowPrices)
            }
          } catch (e) {
            status = 'ERROR'
            err = e
            count = 0
          }
        }

        counts.p2[status]++

        const p2Ctx = {
          queryParam: qp,
          rawResponse: raw,
          status,
          error: err || null,
        }
        const p2Line = safeCallProcess(processP2, p2Ctx, fallbackP2)
        writers.appendP2(p2Line)

        onProgress({
          type:  'P2_ITEM',  // 前端据此渲染结构化行 + 颜色
          phase: 'P2',
          date,
          index: processedP2,
          total,
          qp,
          result: status,
          count,
          p1Flag: flag,
          error: err ? { name: err.name, message: err.message } : null,
        })
        // 推送最新统计快照（排行榜实时刷新）
        onProgress({ type: 'STATS', entries: tjSnapshot() })
      }
    }
  } finally {
    // 无论成功失败（哪怕中途抛了上层中断类错误导致没跑完）
    // 先把已经写入的数据安全落盘，避免损坏
    await writers.close()

    // ---- 输出最终 tjarr 统计报告（md）----
    try {
      tjFilePath = writeTjarrReport({
        outputDir,
        ts: writers.ts,
        filePath,
        airline,
        startDate,
        endDate,
        pairs,
        groups: dumpGroups(),
      })
    } catch (err) {
      console.warn('[ass] 统计报告输出失败：', err?.message)
    }
  }

  return {
    ts: writers.ts,
    outputDir: writers.outputDir,
    p1FilePath: writers.p1FilePath,
    p2FilePath: writers.p2FilePath,
    /** tjarr 统计报告（md）路径；写失败为 null */
    tjFilePath,
    parseInfo: {
      pairsCount: R,
      hasHeader,
      skippedRows,
      duplicateCount,
    },
    dateCount: D,
    queryParamTotal: total,
    counts,
  }
}

export default { runAssTask }
