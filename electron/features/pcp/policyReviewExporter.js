// PCP PolicyReviewExporter - 政策复盘文件导出器
// 职责：把本次运行每一条「生成的政策」连同它的完整溯源（锦绣主行/拆出的套餐/携程查询参数/
//       命中报价/逐列取值来源）导出为单文件 HTML。
//
// 纯展示层产物：只读已捕获的源数据（task.result.originalData / payload / processedData /
//   quoteRows 与 task.preRequest），不新增持久化、不改变任何比价/导出逻辑
//   （符合「日志程序只是观察记录者，不应对任务和数据产生影响」的约束）。
//
// 触发时机：与运行日志同点（pipeline._exportRunLog 内，写到同一子目录 policy-review.html）
//
// 与运行日志的分工：
//   - 运行日志 index.html     → 看流程/对比块/请求快照（平铺原始数据）
//   - 政策复盘 policy-review.html → 逐条看「这条政策的值来自哪条锦绣、哪条套餐、哪条携程、哪个公式」

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { A2_FIELDS, A3_FIELDS, TRIP_RESPONSE_FIELDS } from './fieldNames.js'
import { exportTemplate } from './platforms/trip/adapter.js'

const FILE_NAME = 'policy-review.html'
const COLUMNS = Array.isArray(exportTemplate?.columns) ? exportTemplate.columns : []

// ========== 工具 ==========

/** 安全 JSON 序列化（循环引用 / function / BigInt） */
function safeStringify(obj, indent = 2) {
  if (obj === null || obj === undefined) return 'null'
  const seen = new WeakSet()
  try {
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'function') return '[Function]'
      if (typeof value === 'bigint') return value.toString() + 'n'
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    }, indent)
  } catch (e) {
    return `[serialize failed: ${e.message}]`
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 数字 → 显示文本（空值转 '—'，数字保留原样，其余字符串） */
function fmt(v) {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

// ========== 逐列取值来源分类 ==========
// 与 exportTemplate.columns 的分类口径一致（见 adapter.js「列值来源分四类」注释）：
//   A policyField：锦绣政策字段配置（pf/numPf → resolvePolicyField）
//   B itemField ：对接锦绣主行/比价结果字段（from(item,...)）
//   C fixed     ：写死常量
//   D empty     ：留空
// 这里按「key 白名单」+「column 结构」推导，避免在 load-bearing 的 exportTemplate 上改结构。
const POLICY_FIELD_KEYS = new Set([
  'Name', 'Remark', 'Y优先级', 'OTAConfigID', '数据有效期End', '销售天数', '座位数', '创建人id',
  '去哪飞猪携程nationalityType', '去哪飞猪携程nationality'
])

function colSource(col) {
  if (typeof col.from === 'function') {
    return POLICY_FIELD_KEYS.has(col.key) ? 'policyField' : 'itemField'
  }
  if (col.value === '') return 'empty'
  if (col.value === undefined) return 'itemField'
  return 'fixed'
}

// itemField 列 → 人类可读的「取值源说明 / 计算所需参数」
const ITEM_FIELD_EXPR = {
  '航程类型': "item['航程类型']（中转=多程、直飞=单程）",
  '航司名': "item['H航司名']（锦绣主行航司）",
  '机场航线匹配': "item['C出发机场'] + '-' + item['D到达机场']",
  '舱位': "item['C舱位']（套餐行=套餐舱位，主行=主行舱位）",
  '去程套餐索引v2': "item['去程套餐索引v2']（值=套餐自带「套餐索引」，主行/返程留空）",
  '爬虫名': "item['H航司名']（与航司同口径）",
  '调价固定加减钱': "原价行=0；CUT_VALUE 无效（官网价/套餐价取不到）=0；否则 floor(CUT_VALUE) − cutOffset（cutOffset=「比携程低多少元」，默认1）",
  'UpdateTime': '行生成时刻 formatNow()'
}

/** 逐列来源说明（人类可读） */
function describeCol(col) {
  const s = colSource(col)
  switch (s) {
    case 'policyField': return `policyFields['${col.key}']（resolvePolicyField 解析 \${变量}）`
    case 'itemField': return ITEM_FIELD_EXPR[col.key] || `item['${col.key}']`
    case 'fixed': return `固定值 ${JSON.stringify(col.value)}`
    case 'empty': return '留空'
    default: return s
  }
}

/** 逐列求值（与 fileManager.saveA3FromOTasks 完全同源：col.from(item, ctx) / col.value） */
function evalColumns(entry, ctx) {
  const out = []
  for (const col of COLUMNS) {
    let value
    if (typeof col.from === 'function') value = col.from(entry, ctx)
    else value = col.value
    if (value === '' || value === null || value === undefined) continue // 空列隐藏
    out.push({ key: col.key, value, source: colSource(col), desc: describeCol(col) })
  }
  return out
}

// ========== 溯源定位 ==========

/** 在锦绣结构化源（originalData.dateValue）里定位本政策对应的主行 */
function findMainRow(originalData, entry) {
  const dv = Array.isArray(originalData?.dateValue) ? originalData.dateValue : []
  const fno = entry[A3_FIELDS.H航班号]
  if (fno == null) return null
  const dep = entry[A3_FIELDS.C出发机场]
  const arr = entry[A3_FIELDS.D到达机场]
  const depTime = entry[A3_FIELDS.C出发时间_Date]
  let hit = dv.find(m => m && m[A3_FIELDS.H航班号] === fno
    && (dep == null || m[A3_FIELDS.C出发机场] === dep)
    && (arr == null || m[A3_FIELDS.D到达机场] === arr)
    && (depTime == null || m[A3_FIELDS.C出发时间_Date] === depTime))
  if (hit) return hit
  return dv.find(m => m && m[A3_FIELDS.H航班号] === fno) || null
}

/** 在主行套餐信息里定位本政策拆出的套餐（按套餐索引优先，回退套餐价） */
function findTaocan(mainRow, entry) {
  const tc = Array.isArray(mainRow?.['套餐信息']) ? mainRow['套餐信息'] : []
  const idx = entry['套餐索引']
  if (idx != null) {
    const hit = tc.find(a => a && a['套餐索引'] === idx)
    if (hit) return hit
  }
  const price = entry['套餐价格_CNY']
  if (price != null) {
    const hit = tc.find(a => a && a['套餐价格_CNY'] === price)
    if (hit) return hit
  }
  return null
}

// ========== HTML 渲染 ==========

/** 任务路由标签 */
function extractRoute(task) {
  const data = task?.data?.source || task?.result?.originalData?.source || {}
  const cf = data.CF_jichang || ''
  const dd = data.DD_jichang || ''
  const date = task?.data?.dateKey || ''
  if (cf || dd) return `${cf}→${dd}${date ? '  ' + date : ''}`
  return '—'
}

/** 展开一个折叠块（<details open>） */
function detailsBlock(summary, inner, extraClass = '') {
  return `<details class="pr-detail ${extraClass}"><summary>${escapeHtml(summary)}</summary>${inner}</details>`
}

function preBlock(json) {
  return `<div class="pr-json"><pre>${escapeHtml(json)}</pre></div>`
}

/** 携程查询参数（preRequest 无账密，账密在 request 阶段注入、此处不落盘） */
function renderPreRequest(task) {
  const preq = safeStringify(task?.preRequest)
  return detailsBlock('携程查询参数 (preRequest)', preBlock(preq))
}

/** 命中/匹配报价的可视化小表（脚标：命中那条标 ★） */
function renderMatchedQuotes(entry, task) {
  const matched = Array.isArray(entry._matchedQuotes) ? entry._matchedQuotes : []
  const hit = entry._hitQuote || null
  if (matched.length === 0) {
    return `<div class="pr-note">无匹配到的携程报价${entry['_原价政策'] === true ? '（原价政策：无人在携程投放此套餐）' : ''}</div>`
  }
  const rows = matched.map(q => {
    if (!q) return ''
    const price = Math.floor(Number(q[TRIP_RESPONSE_FIELDS.sortIndicator]))
    const isOwn = !!q[TRIP_RESPONSE_FIELDS.isOwn]
    const showState = q[TRIP_RESPONSE_FIELDS.showState]
    const baggage = q[TRIP_RESPONSE_FIELDS.baggage]
    const isHit = q === hit
    return `<tr class="${isHit ? 'pr-hit' : ''}">
      <td>${isHit ? '★ ' : ''}${Number.isFinite(price) ? price : '—'}</td>
      <td>${escapeHtml(q[TRIP_RESPONSE_FIELDS.seatClass] ?? '')}</td>
      <td>${escapeHtml(baggage ?? '')}</td>
      <td>${isOwn ? '是' : '否'}</td>
      <td>${showState == null ? '—' : escapeHtml(String(showState))}</td>
    </tr>`
  }).join('')
  return `<table class="pr-table pr-table--small">
    <thead><tr><th>价格</th><th>舱位</th><th>行李</th><th>isOwn</th><th>showState</th></tr></thead>
    <tbody>${rows}</tbody></table>`
}

/** 政策行结果标记：原价 > 主行 won/lost > 套餐 won（套餐行无 _outcome，用携程底价判 won） */
function entryOutcome(entry) {
  if (entry['_原价政策'] === true) return '原价'
  if (entry[A3_FIELDS._outcome]) return entry[A3_FIELDS._outcome]
  if (entry[A3_FIELDS.XC_dijia] != null) return 'won'
  return '—'
}

/** 单条政策的复盘卡片 */
function renderEntryCard(entry, task, ctx, seq) {
  const outcome = entryOutcome(entry)
  const outcomeLabel = { won: '比赢', lost: '比输', '原价': '原价政策' }[outcome] || outcome
  const seatClass = fmt(entry[A3_FIELDS.C舱位])
  const pkgIdx = entry['套餐索引']
  const route = escapeHtml(extractRoute(task))

  // 底层比价参数（计算所需参数的取值源）
  const params = [
    ['官网价(成人总票价_CNY)', fmt(entry[A3_FIELDS.C成人总票价_CNY])],
    ['我方底价', fmt(entry['我方底价'] ?? entry[A2_FIELDS.dijia])],
    ['携程底价(XC_dijia)', fmt(entry[A3_FIELDS.XC_dijia])],
    ['差值(CUT_VALUE)', fmt(entry[A3_FIELDS.CUT_VALUE])],
    ['isOwn', entry[A3_FIELDS.isOwn] ? '是' : '否'],
    ['航程类型', fmt(entry['航程类型'])],
    ['品牌名', fmt(entry['品牌名'])],
    ['cutOffset(比携程低多少元)', fmt(ctx?.cutOffset ?? 1)]
  ].map(([k, v]) => `<div class="pr-param"><span class="pk">${escapeHtml(k)}</span><span class="pv">${escapeHtml(v)}</span></div>`).join('')

  // 逐列取值来源表
  const cols = evalColumns(entry, ctx)
  const colRows = cols.map(c => `<tr class="src-${c.source}">
    <td>${escapeHtml(c.key)}</td>
    <td class="pr-val">${escapeHtml(String(c.value))}</td>
    <td class="pr-src">${escapeHtml(c.desc)}</td>
  </tr>`).join('')

  // 溯源定位
  const mainRow = findMainRow(task?.result?.originalData, entry)
  const taocan = findTaocan(mainRow, entry)

  const srcBlock = `
    ${detailsBlock(`锦绣主行（写出此数据） · ${escapeHtml(fmt(entry[A3_FIELDS.H航班号]))}`, preBlock(safeStringify(mainRow)))}
    ${detailsBlock(`拆出的套餐（写出此套餐数据）${pkgIdx != null ? ` · 套餐索引 ${escapeHtml(String(pkgIdx))}` : ''}`, preBlock(safeStringify(taocan)))}
    ${renderPreRequest(task)}
    ${detailsBlock(`命中/匹配的携程报价（组合好的可视化行数据）`, renderMatchedQuotes(entry, task))}
    ${detailsBlock(`命中报价对象（原始 JSON）`, preBlock(safeStringify(entry._hitQuote)))}
  `

  return `<div class="pr-card">
    <div class="pr-head">
      <span class="pr-seq">#${seq}</span>
      <span class="pr-route">${route}</span>
      <span class="pr-seat">舱位 ${seatClass}${pkgIdx != null ? ` · 套餐${escapeHtml(String(pkgIdx))}` : ''}</span>
      <span class="pr-outcome pr-outcome--${outcome}">${escapeHtml(outcomeLabel)}</span>
    </div>
    <div class="pr-params">${params}</div>
    <div class="pr-sec-title">逐列取值来源（${cols.length} 个非空列）</div>
    <table class="pr-table pr-table--cols">
      <thead><tr><th>表头列名</th><th>本次取值</th><th>取值源</th></tr></thead>
      <tbody>${colRows}</tbody>
    </table>
    <div class="pr-sec-title">源数据溯源链（默认折叠，点击展开）</div>
    ${srcBlock}
  </div>`
}

// ===== 全局样式（终端深色，与运行日志一致）=====
const STYLE_BLOCK = `<style>
  * { box-sizing: border-box; }
  body { background: #1e1e1e; color: #d4d4d4; font-family: 'Consolas','Monaco','Cascadia Mono',monospace; padding: 20px; margin: 0; line-height: 1.5; }
  h1 { color: #4fc3f7; font-size: 18px; font-weight: 600; border-bottom: 1px solid #444; padding-bottom: 8px; margin: 0 0 16px; }
  .meta { background: #2d2d2d; padding: 12px; border-left: 3px solid #4fc3f7; margin-bottom: 16px; font-size: 12px; }
  .meta div { margin: 3px 0; }
  .meta .k { color: #888; display: inline-block; width: 120px; }
  .meta .v { color: #fff; }
  .pr-card { background: #2d2d2d; border: 1px solid #444; margin: 12px 0; border-radius: 2px; }
  .pr-head { padding: 8px 12px; border-bottom: 1px solid #444; display: flex; align-items: center; gap: 10px; font-size: 12px; flex-wrap: wrap; }
  .pr-seq { color: #4fc3f7; font-weight: 600; }
  .pr-route { color: #fff; flex: 1; min-width: 180px; }
  .pr-seat { color: #b0bec5; }
  .pr-outcome { padding: 1px 6px; border-radius: 2px; font-size: 10px; border: 1px solid #555; }
  .pr-outcome--won { color: #4caf50; border-color: #4caf50; }
  .pr-outcome--lost { color: #ef5350; border-color: #ef5350; background: #3a1a1a; }
  .pr-outcome--原价 { color: #9e9e9e; border-color: #555; }
  .pr-params { display: flex; gap: 6px 18px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid #333; font-size: 11px; }
  .pr-param .pk { color: #888; }
  .pr-param .pv { color: #ffb74d; margin-left: 2px; }
  .pr-sec-title { color: #888; font-size: 12px; padding: 8px 12px 4px; }
  .pr-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .pr-table th { background: #2a2a2a; color: #888; text-align: left; padding: 6px 10px; border-bottom: 1px solid #444; font-weight: 600; }
  .pr-table td { padding: 5px 10px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  .pr-table--cols .pr-val { color: #fff; white-space: nowrap; }
  .pr-table--cols .pr-src { color: #888; }
  tr.src-policyField td { border-left: 3px solid #4fc3f7; }
  tr.src-itemField td { border-left: 3px solid #66bb6a; }
  tr.src-fixed td { border-left: 3px solid #555; color: #9e9e9e; }
  .pr-table--small td { color: #d4d4d4; }
  .pr-table--small tr.pr-hit td { background: #1e3a1a; color: #66bb6a; }
  .pr-detail { margin: 0 12px 8px; border: 1px solid #333; border-radius: 2px; }
  .pr-detail > summary { cursor: pointer; user-select: none; list-style: none; padding: 6px 10px; font-size: 11px; color: #b0bec5; background: #252525; }
  .pr-detail > summary::before { content: '▶ '; }
  .pr-detail[open] > summary::before { content: '▼ '; }
  .pr-detail .pr-json pre { background: #1a1a1a; padding: 8px; margin: 0; overflow: auto; color: #b8d8a0; font-size: 11px; max-height: 480px; border-top: 1px solid #333; }
  .pr-note { color: #888; font-style: italic; padding: 8px 10px; font-size: 11px; }
  .foot { color: #555; font-size: 11px; margin-top: 24px; padding-top: 8px; border-top: 1px dashed #333; }
</style>`

/** 展开全部任务分组标题 */
function renderTaskOpen(task) {
  return `<h2>▼ 携程任务 ${escapeHtml(task.id || '')} · ${escapeHtml(extractRoute(task))}</h2>`
}

// ========== 导出主入口 ==========

/**
 * 导出政策复盘文件（单文件 HTML，逐条政策 = 一张溯源卡片）
 * @param {object} opts
 *   - tasks:        Array  任务快照（taskManager.getState().tasks）
 *   - fileManager:  FileManager 实例（取航司配置：policyFields + cutOffset）
 *   - dir:          string 输出目录（与运行日志同子目录）
 * @returns {{ success: boolean, file?: string, count?: number, error?: string }}
 */
export async function exportPolicyReview({ tasks, fileManager, dir }) {
  const tripTasks = (tasks || []).filter(t => t.type === 'trip' && t?.result && Array.isArray(t.result.processedData))
  if (tripTasks.length === 0) {
    return { success: false, error: '没有携程比价结果（无 trip 任务或 processedData 为空）' }
  }

  try {
    // 航司上下文：政策字段配置 + cutOffset（与 fileManager.saveA3FromOTasks 同源）
    const a1Data = fileManager?.getA1?.()?.data || []
    const hangsi = String(a1Data[0]?.hangsi || '').trim().toUpperCase()
    const airline = (hangsi && fileManager?.configManager)
      ? fileManager.configManager.getAirlineConfig(hangsi)
      : null
    const ctx = { ...(airline?.platform?.trip || {}), policyFields: airline?.policyFields || {} }

    const filePath = path.join(dir, FILE_NAME)
    let count = 0
    const errorPath = path.join(dir, 'policy-review-error.txt')

    // 1. 写头
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const datetimeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const head = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>政策复盘 - ${escapeHtml(hangsi || 'XX')}</title>${STYLE_BLOCK}</head>
<body>
<h1>政策复盘</h1>
<div class="meta">
  <div><span class="k">生成时间</span><span class="v">${escapeHtml(datetimeStr)}</span></div>
  <div><span class="k">航司</span><span class="v">${escapeHtml(hangsi || '—')}</span></div>
  <div><span class="k">cutOffset</span><span class="v">${escapeHtml(fmt(ctx?.cutOffset ?? 1))}</span></div>
  <div><span class="k">政策字段配置数</span><span class="v">${Object.keys(ctx.policyFields || {}).length}</span></div>
</div>
`
    await fsp.writeFile(filePath, head, 'utf-8')

    // 2. 逐任务逐政策行 append
    let seq = 0
    for (const task of tripTasks) {
      await fsp.appendFile(filePath, renderTaskOpen(task), 'utf-8')
      for (const entry of task.result.processedData) {
        if (!entry || typeof entry !== 'object') continue
        try {
          await fsp.appendFile(filePath, renderEntryCard(entry, task, ctx, ++seq), 'utf-8')
          count++
        } catch (e) {
          try {
            await fsp.appendFile(errorPath, `[${new Date().toISOString()}] 政策行渲染失败: ${e?.stack || e?.message}\n`, 'utf-8')
          } catch { /* ignore */ }
        }
      }
      // ★ 每个任务让出一拍事件循环，避免大批量任务时长时间占用主线程
      if (seq % 10 === 0) await new Promise(r => setImmediate(r))
    }

    // 3. 写尾
    await fsp.appendFile(filePath, `<div class="foot">由 PCP Pipeline 自动生成 · 共 ${count} 条政策 · 逐条溯源「锦绣主行 / 拆出套餐 / 携程查询参数与匹配报价 / 逐列取值来源」</div>
</body></html>`, 'utf-8')

    return { success: true, file: filePath, count }
  } catch (e) {
    console.error('[policyReviewExporter] 导出失败:', e)
    return { success: false, error: e?.message }
  }
}