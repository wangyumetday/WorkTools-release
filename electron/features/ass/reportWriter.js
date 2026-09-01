// ============================================================
// ASS 任务统计报告写入器（Markdown）
// 职责：每轮任务结束后，把"最终 tjarr"（会话累计统计）输出为 .md 文件
//
// 文件内容顺序（需求约定）：
//   1. 查询范围：航线文件路径 + 航线 + 航司 + 日期区间
//   2. 占比总览：逐行 "agentCode"/"sourceName"/投放航班数/占比（按数量降序）
//   3. tjarr 全部数据：完整原始数据（每组的完整航班原始对象）JSON 块
//
// 文件命名与 P1/P2 对齐：<outputDir>/tjarr_<任务时间戳>.md
// ============================================================

import { writeFileSync } from 'node:fs'
import path from 'node:path'

/** 占比（一位小数） */
function pctOf(count, total) {
  if (!total) return '0.0%'
  return `${((count / total) * 100).toFixed(1)}%`
}

/** groups → 键控 JSON（agentCode → { agentCode, sourceName, count, flights }） */
function groupsToDict(groups) {
  const dict = {}
  for (const g of groups) {
    dict[g.code] = {
      agentCode: g.code,
      sourceName: g.name,
      count: g.count,
      flights: g.flights,
    }
  }
  return dict
}

/**
 * 生成并写入统计报告
 * @param {object} opts
 * @param {string} opts.outputDir  输出目录（与 P1/P2 相同）
 * @param {string} opts.ts         任务时间戳（与 P1/P2 文件名一致，如 20260831_183000）
 * @param {string} opts.filePath   用户选择的航线文件
 * @param {string} opts.airline    航司（空 = 未指定）
 * @param {string} opts.startDate  开始日期 YYYY-MM-DD
 * @param {string} opts.endDate    结束日期 YYYY-MM-DD
 * @param {Array<{dep:string, arr:string}>} opts.pairs  航线对
 * @param {Array<{code:string, name:string, count:number, flights:Array}>} opts.groups  tjarr 全量分组（降序）
 * @returns {string|null} 报告文件路径；写失败返回 null
 */
export function writeTjarrReport({ outputDir, ts, filePath, airline, startDate, endDate, pairs, groups }) {
  const lines = []
  const total = groups.reduce((sum, g) => sum + (g.count || 0), 0)

  // ---- 查询范围 ----
  lines.push('# 携程低价政策查询统计报告')
  lines.push('')
  lines.push(`> 生成时间：${new Date().toLocaleString()} · 任务时间戳：${ts}`)
  lines.push('')
  lines.push('## 查询范围')
  lines.push('')
  lines.push(`- 航线文件：${filePath}`)
  lines.push(`- 航线数：${pairs.length} 条`)
  lines.push(`- 航司：${airline || '（未指定）'}`)
  lines.push(`- 日期区间：${startDate} ~ ${endDate}`)
  lines.push('- 航线：')
  pairs.forEach((p, i) => lines.push(`  ${i + 1}. ${p.dep} → ${p.arr}`))
  lines.push('')

  // ---- 占比总览 ----
  lines.push('## 占比总览')
  lines.push('')
  if (groups.length === 0) {
    lines.push('（暂无统计数据）')
  } else {
    for (const g of groups) {
      lines.push(
        `"agentCode": "${g.code}", "sourceName": "${g.name}", 投放航班数：${g.count}，占比：${pctOf(g.count, total)}`
      )
    }
  }
  lines.push('')

  // ---- tjarr 全部数据（完整原始数据）----
  lines.push('## tjarr 全部数据')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(groupsToDict(groups), null, 2))
  lines.push('```')
  lines.push('')

  const file = path.join(outputDir, `tjarr_${ts}.md`)
  try {
    writeFileSync(file, lines.join('\n'), 'utf-8')
    return file
  } catch (err) {
    console.warn('[ass] 统计报告写入失败：', err?.message)
    return null
  }
}

export default { writeTjarrReport }