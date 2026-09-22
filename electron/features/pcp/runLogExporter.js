// ============================================================
// PCP RunLogExporter - 运行日志导出器
// 职责：把本次运行的全部任务快照导出为 HTML 文件到桌面
//
// 触发时机（由 pipeline.js 调用）：
//   - auto 模式：handleStageComplete('o_combo') 完成后（无论 a3 是否成功）
//   - dev 模式：handleStageComplete('jxgj') 完成后（jxgj-only 单步运行）
//   - dev 模式：handleStageComplete('o_combo') 完成后（o_combo 单步运行）
//   - abort()：用户硬终止
//   - runStage 早期失败：addBatch / taskManager.start 入口失败
//
// 输出位置：
//   <桌面>/work tools运行日志/<YYYYMMDD_HHMM_<airline>_<routeCount>[/run-log.html
//   目录名重复时追加 _1/_2 后缀
//
// 设计原则：
//   - 终端风格深色界面（与 RequestItem.vue 视觉一致）
//   - 任务卡片可折叠（请求参数 / 返回数据 / 任务数据 三块）
//   - 状态色点：completed=绿 / failed=红 / aborted=橙 / 其它=灰
//   - 任务列表分两组：锦绣请求（jxgj）+ 携程请求（trip/reserved）
//   - 单一文件，零运行时依赖（除 node:fs / node:path / electron.app）
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'

const LOG_ROOT_DIR = 'work tools运行日志'
const LOG_FILENAME = 'run-log.html'

// ========== 工具 ==========

/**
 * 安全 JSON 序列化：处理循环引用 / function / BigInt
 */
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

/**
 * HTML 特殊字符转义
 */
function escapeHtml(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 从 task.data 提取头部路由标签
 *   - jxgj：CF_jichang → DD_jichang  / hangsi
 *   - trip/reserved：source.CF_jichang → source.DD_jichang  / dateKey
 */
function extractRoute(task) {
  const data = task?.data
  if (!data || typeof data !== 'object') return '—'
  if (task.type === 'jxgj') {
    const cf = data.CF_jichang || ''
    const dd = data.DD_jichang || ''
    const hs = data.hangsi || ''
    if (cf || dd) return `${cf}→${dd}${hs ? '  ' + hs : ''}`
    return '—'
  }
  // trip/reserved：data.source 是 a2 item
  const src = data.source || {}
  const cf = src.CF_jichang || ''
  const dd = src.DD_jichang || ''
  const date = data.dateKey || ''
  if (cf || dd) return `${cf}→${dd}${date ? '  ' + date : ''}`
  return '—'
}

/**
 * 任务状态 → 色点 CSS class
 */
function statusToClass(status) {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'aborted') return 'aborted'
  return 'other'
}

/**
 * 触发原因 → 中文描述
 */
function triggerLabel(trigger) {
  const map = {
    'auto-complete': '自动模式-运行完成',
    'dev-jxgj-complete': '开发模式-锦绣阶段完成',
    'dev-o-combo-complete': '开发模式-携程阶段完成',
    'aborted': '用户终止',
    'stage-failed-jxgj': '锦绣阶段入队/启动失败',
    'stage-failed-o-combo': '携程阶段入队/启动失败'
  }
  return map[trigger] || trigger
}

// ========== HTML 渲染 ==========

// quoteRows 五态标签（与 RequestItem.vue QUOTE_STATUS_TEXT 一致）
const QUOTE_STATUS_TEXT = {
  won: '比赢',
  lost: '比输',
  ownShown: '外显',
  ownHidden: '未显',
  unmatched: '未匹配'
}

// 未匹配首因 → 标签短文案（detail 在 title 属性 hover 查看）
const UNMATCH_REASON_TEXT = {
  flight: '无此航班',
  cabin: '舱位不符',
  baggage: '行李不符',
  price: '价格异常'
}

/**
 * 渲染 trip 任务「对比过程与结果」块
 *   - 仅 trip 任务且 quoteRows 非空时渲染，否则返回空字符串
 *   - 数据源：task.result.quoteRows（trip adapter.js buildQuoteRows 生成）
 *   - 分组与 RequestItem.vue tripGroups 一致：flightNo|date|dep|arr
 *   - 每组：对比基准行（ourBasis 蓝色背景）+ 主行（isInit 或首条）+ 套餐子行
 *   - 五态着色（终端深色版）：
 *       won=透明绿字 / lost=深红 #3a1a1a / ownShown=深绿 #1e3a1a
 *       ownHidden=深黄 #3a3a1a / unmatched=透明灰字
 */
function quoteStatusText(q) {
  if (q.status === 'unmatched') {
    return UNMATCH_REASON_TEXT[q.unmatchedReason?.reason] || '未匹配'
  }
  return QUOTE_STATUS_TEXT[q.status] || q.status
}

function renderQuoteBlock(task) {
  if (task.type !== 'trip') return ''
  const result = task.result
  const rows = result && Array.isArray(result.quoteRows) ? result.quoteRows : []
  if (rows.length === 0) return ''

  // 分组（与 RequestItem.vue tripGroups 完全一致：flightNo|date|dep|arr）
  const map = new Map()
  for (const q of rows) {
    const key = `${q.flightNo ?? '—'}|${q.date ?? '—'}|${q.depAirport ?? '—'}|${q.arrAirport ?? '—'}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        route: (q.depAirport && q.arrAirport) ? `${q.depAirport}→${q.arrAirport}` : '',
        rows: []
      })
    }
    map.get(key).rows.push(q)
  }
  const groups = [...map.values()]
  for (const g of groups) {
    g.head = g.rows.find(r => r.isInit) || g.rows[0]
    g.children = g.rows.filter(r => r !== g.head)
    // 对比基准：优先取比赢/比输行记录的命中条目，其次任一行携带的同航班条目
    g.ourBasis =
      g.rows.find(r => (r.status === 'won' || r.status === 'lost') && r.ourBasis)?.ourBasis ||
      g.rows.find(r => r.ourBasis)?.ourBasis ||
      null
  }

  // 统计（优先 summary，回退本地计数）
  const s = result.summary || {}
  const stats = {
    lowPriceCount: s.lowPriceCount ?? 0,
    total: s.quoteTotal ?? rows.length,
    won: s.quoteWon ?? rows.filter(r => r.status === 'won').length,
    lost: s.quoteLost ?? rows.filter(r => r.status === 'lost').length,
    ownShown: s.quoteOwnShown ?? rows.filter(r => r.status === 'ownShown').length,
    ownHidden: s.quoteOwnHidden ?? rows.filter(r => r.status === 'ownHidden').length,
    unmatched: s.quoteUnmatched ?? rows.filter(r => r.status === 'unmatched').length
  }

  const renderBasis = (b) => {
    if (!b) return ''
    const price = b.price == null ? '—' : `¥${b.price} 官`
    const floor = b.floor == null ? '—' : `¥${b.floor} 底`
    return `<tr class="qrow qrow-basis">
      <td><span class="qb-tag">官网</span></td>
      <td class="qm-route-cell">
        <div class="qm-flight">${escapeHtml(b.flightNo ?? '—')}</div>
        <div class="qm-route">${escapeHtml(b.route ?? '')}</div>
      </td>
      <td>${escapeHtml(b.cabin ?? '—')}</td>
      <td class="rb-price">
        <div>${escapeHtml(price)}</div>
        <div>${escapeHtml(floor)}</div>
      </td>
      <td>${escapeHtml(b.baggageShort ?? '—')}</td>
    </tr>`
  }

  const renderRow = (q, isHead, route) => {
    const titleAttr = q.unmatchedReason?.detail ? ` title="${escapeHtml(q.unmatchedReason.detail)}"` : ''
    const cls = `qrow ${isHead ? 'qrow--main' : 'qrow-child'} qrow--${q.status || 'other'}`
    const routeCell = isHead
      ? `<td class="qm-route-cell">
        <div class="qm-flight">${escapeHtml(q.flightNo ?? '—')}</div>
        <div class="qm-route">${escapeHtml(route)}</div>
      </td>`
      : '<td></td>'
    const priceStr = q.sortIndicator == null ? '—' : `¥${q.sortIndicator}`
    return `<tr class="${cls}">
      <td><span class="rb-outcome rb-outcome--${q.status || 'other'}"${titleAttr}>${escapeHtml(quoteStatusText(q))}</span></td>
      ${routeCell}
      <td>${escapeHtml(q.seatClass ?? '—')}</td>
      <td class="rb-price">${escapeHtml(priceStr)}</td>
      <td>${escapeHtml(q.baggageShort ?? '—')}</td>
    </tr>`
  }

  const groupsHtml = groups.map(g => {
    return renderBasis(g.ourBasis)
      + renderRow(g.head, true, g.route)
      + g.children.map(q => renderRow(q, false, '')).join('')
  }).join('')

  return `
    <div class="block">
      <div class="block-title">▶ 对比过程与结果 (quoteRows)</div>
      <div class="block-body">
        <div class="rb-summary-line">
          低价套餐 ${stats.lowPriceCount} · 报价 ${stats.total}
          · 比赢 ${stats.won} · 比输 ${stats.lost}
          · 外显 ${stats.ownShown} · 未显 ${stats.ownHidden}
          · 未匹配 ${stats.unmatched}
        </div>
        <div class="rb-legend">
          <span class="rbl-item"><i class="rbl-dot rbl-dot--ownShown"></i>我方外显</span>
          <span class="rbl-item"><i class="rbl-dot rbl-dot--ownHidden"></i>我方未显</span>
          <span class="rbl-item"><i class="rbl-dot rbl-dot--lost"></i>比输</span>
          <span class="rbl-item"><i class="rbl-dot rbl-dot--other"></i>他人/未匹配</span>
          <span class="rbl-hint">蓝行为锦绣官网对比基准 · 未匹配标签 hover 看明细</span>
        </div>
        <table class="rb-table rb-table--quotes">
          <thead>
            <tr>
              <th>匹配结果</th>
              <th>航线</th>
              <th>舱位</th>
              <th>携程底价</th>
              <th>行李</th>
            </tr>
          </thead>
          <tbody>${groupsHtml}</tbody>
        </table>
      </div>
    </div>`
}

function renderTaskCard(task) {
  const statusClass = statusToClass(task.status)
  const route = escapeHtml(extractRoute(task))
  const taskId = escapeHtml(task.id || '')
  const progress = Math.round(task.progress || 0)
  const stage = escapeHtml(task.stage || '')
  const type = escapeHtml(task.type || '')

  const errBlock = task.error
    ? `<div class="block err-block"><span class="err-label">错误:</span> <span class="err-msg">${escapeHtml(task.error)}</span></div>`
    : ''

  const preqJson = safeStringify(task.preRequest)
  const resultJson = safeStringify(task.result)
  const dataJson = safeStringify(task.data)

  const created = task.createdAt ? new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'
  const started = task.startedAt ? new Date(task.startedAt).toLocaleString('zh-CN', { hour12: false }) : '—'
  const finished = task.finishedAt ? new Date(task.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '—'

  return `
  <div class="task-card">
    <div class="task-head">
      <span class="dot dot--${statusClass}" title="${escapeHtml(task.status)}"></span>
      <span class="task-id">${taskId}</span>
      <span class="task-type">[${type}]</span>
      <span class="task-route">${route}</span>
      <span class="task-progress">${progress}%</span>
      <span class="task-stage">${stage}</span>
    </div>
    <div class="task-meta">
      <span><span class="mk">创建:</span> ${created}</span>
      <span><span class="mk">开始:</span> ${started}</span>
      <span><span class="mk">结束:</span> ${finished}</span>
    </div>
    ${errBlock}
    <div class="block">
      <div class="block-title">▶ 请求参数 (preRequest)</div>
      <div class="block-body"><pre>${escapeHtml(preqJson)}</pre></div>
    </div>
    ${renderQuoteBlock(task)}
    <div class="block">
      <div class="block-title">▶ 返回数据 (result)</div>
      <div class="block-body"><pre>${escapeHtml(resultJson)}</pre></div>
    </div>
    <div class="block">
      <div class="block-title">▶ 任务数据 (data)</div>
      <div class="block-body"><pre>${escapeHtml(dataJson)}</pre></div>
    </div>
  </div>`
}

function buildHtml({ tasks, meta }) {
  const jxgjTasks = tasks.filter(t => t.type === 'jxgj')
  const tripTasks = tasks.filter(t => t.type === 'trip' || t.type === 'reserved')
  const otherTasks = tasks.filter(t => t.type !== 'jxgj' && t.type !== 'trip' && t.type !== 'reserved')

  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const aborted = tasks.filter(t => t.status === 'aborted').length
  const other = tasks.length - completed - failed - aborted

  const jxgjHtml = jxgjTasks.map(renderTaskCard).join('\n')
  const tripHtml = tripTasks.map(renderTaskCard).join('\n')
  const otherHtml = otherTasks.length ? otherTasks.map(renderTaskCard).join('\n') : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>PCP 运行日志 - ${escapeHtml(meta.airline)} ${meta.routeCount}航线 - ${escapeHtml(meta.datetimeStr)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      background: #1e1e1e; color: #d4d4d4;
      font-family: 'Consolas', 'Monaco', 'Cascadia Mono', monospace;
      padding: 20px; margin: 0; line-height: 1.5;
    }
    h1 {
      color: #4fc3f7; font-size: 18px; font-weight: 600;
      border-bottom: 1px solid #444; padding-bottom: 8px; margin: 0 0 16px 0;
    }
    h2 {
      color: #ffb74d; font-size: 14px; font-weight: 600;
      margin: 24px 0 10px 0; padding-bottom: 4px;
      border-bottom: 1px dashed #555;
    }
    .meta {
      background: #2d2d2d; padding: 12px;
      border-left: 3px solid #4fc3f7; margin-bottom: 16px;
      font-size: 12px;
    }
    .meta div { margin: 3px 0; }
    .meta .k { color: #888; display: inline-block; width: 110px; }
    .meta .v { color: #fff; }
    .stat-row {
      display: flex; gap: 24px; flex-wrap: wrap;
      padding: 10px 12px; background: #252525;
      margin-bottom: 12px; border: 1px solid #333; font-size: 12px;
    }
    .stat { color: #888; }
    .stat .n { color: #fff; font-weight: bold; margin-left: 6px; }
    .stat.ok .n { color: #4caf50; }
    .stat.fail .n { color: #f44336; }
    .stat.aborted .n { color: #ff9800; }
    .stat.other .n { color: #888; }
    .task-card {
      background: #2d2d2d; border: 1px solid #444;
      margin: 8px 0; border-radius: 2px;
    }
    .task-head {
      padding: 8px 12px; border-bottom: 1px solid #444;
      display: flex; align-items: center; gap: 10px; font-size: 12px;
      flex-wrap: wrap;
    }
    .dot {
      width: 10px; height: 10px; border-radius: 50%;
      display: inline-block; flex-shrink: 0;
    }
    .dot--completed { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
    .dot--failed { background: #f44336; box-shadow: 0 0 4px #f44336; }
    .dot--aborted { background: #ff9800; }
    .dot--other { background: #888; }
    .task-id { color: #4fc3f7; font-weight: 600; }
    .task-type { color: #b0bec5; font-size: 11px; }
    .task-route { color: #fff; flex: 1; min-width: 200px; }
    .task-progress { color: #888; }
    .task-stage { color: #ffb74d; }
    .task-meta {
      padding: 6px 12px; border-bottom: 1px solid #333;
      font-size: 11px; color: #888; display: flex; gap: 20px; flex-wrap: wrap;
    }
    .task-meta .mk { color: #666; }
    .block { padding: 6px 12px; border-bottom: 1px solid #333; }
    .block:last-child { border-bottom: none; }
    .block-title {
      color: #888; cursor: pointer; user-select: none;
      font-size: 12px; padding: 2px 0;
    }
    .block-title:hover { color: #fff; }
    .block-body { margin-top: 6px; }
    .block-body pre {
      background: #1a1a1a; padding: 8px; margin: 0;
      overflow: auto; color: #b8d8a0; font-size: 11px;
      max-height: 600px; overflow-y: auto;
      border: 1px solid #333; border-radius: 2px;
      white-space: pre; word-break: normal;
    }
    .err-block {
      background: #3a1a1a; border-left: 3px solid #f44336;
      padding: 8px 12px; font-size: 12px;
    }
    .err-label { color: #f44336; font-weight: bold; }
    .err-msg { color: #ffb4b4; }
    .empty { color: #666; font-style: italic; padding: 12px; font-size: 12px; }
    /* ===== quote 块（对比过程与结果）===== */
    .rb-summary-line { padding: 4px 0 6px; color: #b0bec5; font-size: 11px; }
    .rb-legend {
      display: flex; gap: 16px; flex-wrap: wrap; align-items: center;
      padding-bottom: 8px; font-size: 11px; color: #888;
      border-bottom: 1px solid #333; margin-bottom: 8px;
    }
    .rbl-item { display: inline-flex; align-items: center; gap: 4px; }
    .rbl-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
    .rbl-dot--ownShown { background: #4caf50; }
    .rbl-dot--ownHidden { background: #ffeb3b; }
    .rbl-dot--lost { background: #ef5350; }
    .rbl-dot--other { background: #9e9e9e; }
    .rbl-hint { color: #666; font-style: italic; margin-left: auto; }
    .rb-table {
      width: 100%; border-collapse: collapse;
      font-size: 11px; color: #d4d4d4;
    }
    .rb-table th {
      background: #2a2a2a; color: #888; text-align: left;
      padding: 6px 8px; border-bottom: 1px solid #444;
      font-weight: 600; font-size: 11px;
    }
    .rb-table td {
      padding: 5px 8px; border-bottom: 1px solid #2a2a2a;
      vertical-align: top;
    }
    .qm-route-cell .qm-flight { color: #fff; }
    .qm-route-cell .qm-route { color: #888; font-size: 10px; }
    .rb-price { color: #ffb74d; }
    .qb-tag {
      background: #1a3a5c; color: #4fc3f7;
      padding: 1px 6px; border-radius: 2px;
      font-size: 10px; border: 1px solid #2a5d8c;
    }
    .qrow-basis td { background: #1a3a5c; }
    .qrow-basis .rb-price { color: #4fc3f7; }
    .rb-outcome {
      display: inline-block; padding: 1px 6px;
      border-radius: 2px; font-size: 10px;
      border: 1px solid #444; white-space: nowrap;
    }
    .rb-outcome--won { background: transparent; color: #4caf50; border-color: #4caf50; }
    .rb-outcome--lost { background: #3a1a1a; color: #ef5350; border-color: #ef5350; }
    .rb-outcome--ownShown { background: #1e3a1a; color: #66bb6a; border-color: #66bb6a; }
    .rb-outcome--ownHidden { background: #3a3a1a; color: #ffca28; border-color: #ffca28; }
    .rb-outcome--unmatched { background: transparent; color: #888; border-color: #555; }
    .qrow--lost td { background: #3a1a1a; }
    .qrow--ownShown td { background: #1e3a1a; }
    .qrow--ownHidden td { background: #3a3a1a; }
    .qrow-child td { font-size: 10px; color: #999; }
    .qrow-child td:first-child { padding-left: 20px; }
    .foot { color: #555; font-size: 11px; margin-top: 24px; padding-top: 8px; border-top: 1px dashed #333; }
  </style>
</head>
<body>
  <h1>PCP 运行日志</h1>
  <div class="meta">
    <div><span class="k">运行结束时间</span><span class="v">${escapeHtml(meta.datetimeStr)}</span></div>
    <div><span class="k">航司</span><span class="v">${escapeHtml(meta.airline)}</span></div>
    <div><span class="k">航线数量</span><span class="v">${meta.routeCount}</span></div>
    <div><span class="k">结束原因</span><span class="v">${escapeHtml(triggerLabel(meta.trigger))}</span></div>
    <div><span class="k">运行模式</span><span class="v">${escapeHtml(meta.mode === 'auto' ? '自动 (auto)' : '开发 (dev)')}</span></div>
    <div><span class="k">业务模式</span><span class="v">${escapeHtml(meta.businessMode === 'policy' ? '政策导入' : '底价检查')}</span></div>
  </div>
  <div class="stat-row">
    <span class="stat">总任务<span class="n">${tasks.length}</span></span>
    <span class="stat ok">成功<span class="n">${completed}</span></span>
    <span class="stat fail">失败<span class="n">${failed}</span></span>
    <span class="stat aborted">终止<span class="n">${aborted}</span></span>
    ${other > 0 ? `<span class="stat other">其它<span class="n">${other}</span></span>` : ''}
  </div>

  <h2>锦绣请求 (${jxgjTasks.length})</h2>
  ${jxgjHtml || '<div class="empty">无任务</div>'}

  <h2>携程请求 (${tripTasks.length})</h2>
  ${tripHtml || '<div class="empty">无任务</div>'}

  ${otherTasks.length ? `<h2>其它任务 (${otherTasks.length})</h2>${otherHtml}` : ''}

  <div class="foot">由 PCP Pipeline 自动生成 · 目录名格式: 日期_时间_航司_航线数量</div>

  <script>
    (function () {
      var titles = document.querySelectorAll('.block-title');
      titles.forEach(function (t) {
        t.addEventListener('click', function () {
          var body = t.nextElementSibling;
          if (!body) return;
          var hidden = body.style.display === 'none';
          body.style.display = hidden ? 'block' : 'none';
          t.firstChild.textContent = hidden ? '▼ ' : '▶ ';
        });
      });
    })();
  </script>
</body>
</html>`
}

// ========== 导出主入口 ==========

/**
 * 解析桌面路径：优先 electron.app，回落到 os.homedir()/Desktop
 */
function resolveDesktopPath() {
  try {
    if (app && typeof app.getPath === 'function') {
      return app.getPath('desktop')
    }
  } catch { /* app 未就绪或不可用 */ }
  // 兼容 Windows 中文系统桌面文件夹名
  const home = os.homedir()
  const candidates = ['Desktop', '桌面']
  for (const c of candidates) {
    const p = path.join(home, c)
    if (fs.existsSync(p)) return p
  }
  return home
}

/**
 * 导出运行日志 HTML 文件到桌面
 * @param {object} opts
 *   - tasks:        Array  任务快照（来自 taskManager.getState().tasks）
 *   - fileManager:  FileManager 实例（取航司 + 航线数）
 *   - pipeline:     Pipeline 实例（取 mode/businessMode）
 *   - trigger:      string  结束原因（auto-complete/aborted/stage-failed-* 等）
 * @returns {{ success: boolean, dir?: string, file?: string, error?: string }}
 */
export function exportRunLog({ tasks, fileManager, pipeline, trigger }) {
  try {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const datetimeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}`

    // 航司 + 航线数：从 fileManager.a1 取
    const a1 = fileManager?.getA1?.() || {}
    const a1Data = a1.data || []
    const airlineRaw = String(a1Data[0]?.hangsi || 'XX').trim()
    const airline = airlineRaw.toUpperCase() || 'XX'
    const routeCount = a1.count || a1Data.length || 0

    const mode = pipeline?.mode || 'auto'
    const businessMode = pipeline?.businessMode || 'policy'

    // 创建日志根目录 + 子目录
    const desktopPath = resolveDesktopPath()
    const rootDir = path.join(desktopPath, LOG_ROOT_DIR)
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true })

    // 子目录名：YYYYMMDD_HHMM_<airline>_<routeCount>，重名追加 _1/_2
    let subDirName = `${datePart}_${timePart}_${airline}_${routeCount}`
    let subDir = path.join(rootDir, subDirName)
    let suffix = 1
    while (fs.existsSync(subDir)) {
      subDirName = `${datePart}_${timePart}_${airline}_${routeCount}_${suffix}`
      subDir = path.join(rootDir, subDirName)
      suffix++
      if (suffix > 999) break // 安全上限
    }
    fs.mkdirSync(subDir, { recursive: true })

    // 生成 HTML 并写入
    const html = buildHtml({
      tasks: tasks || [],
      meta: { datetimeStr, airline, routeCount, trigger, mode, businessMode }
    })
    const filePath = path.join(subDir, LOG_FILENAME)
    fs.writeFileSync(filePath, html, 'utf-8')

    return { success: true, dir: subDir, file: filePath }
  } catch (e) {
    console.error('[runLogExporter] 导出失败:', e)
    return { success: false, error: e.message }
  }
}
