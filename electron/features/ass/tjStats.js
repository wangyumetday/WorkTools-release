// ============================================================
// ASS 航班统计（tjarr）—— 主进程单例
//
// 职责：
//   1. 维护 tjarr：键控对象 { [agencyCode]: { code, name, count, flights: [] } }
//      - P2 每次成功响应后，把 data.lowPrices 里的每条航班按 agencyCode 归类累计
//      - 名称（name）用死数据 supplierNames.json 映射（agentCode → 中文名），查不到用代码本身兜底
//   2. 提供 snapshot()：按航班数降序的排行榜数组，供渲染层实时渲染
//   3. clear()：清空统计（UI「清空统计」按钮调用）
//
// 死数据来源：由 src/features/ass/docs/fanhui.json（supplierSimpleInfo 响应样本）
// 提取 supplierList 的 agentCode → sourceName 映射生成，共 622 条。
// ============================================================

import supplierNames from './supplierNames.json'

/** agentCode → 中文名；查不到时用代码本身兜底 */
function resolveName(agencyCode) {
  const code = String(agencyCode || '').trim()
  if (!code) return '（无代理码）'
  return supplierNames[code] || code
}

const tjarr = {} // { [agencyCode]: { code, name, count, flights: [] } }

/**
 * 从一次 P2 响应中累计统计（每出现一条航班计一次；agencyCode 为空的条目忽略）
 * @param {Array} lowPrices data.lowPrices 列表
 */
export function addFlights(lowPrices) {
  if (!Array.isArray(lowPrices)) return
  for (const flight of lowPrices) {
    if (!flight || flight.agencyCode === undefined || flight.agencyCode === null || flight.agencyCode === '') continue
    const code = String(flight.agencyCode).trim()
    if (!code) continue
    if (!tjarr[code]) {
      tjarr[code] = { code, name: resolveName(code), count: 0, flights: [] }
    }
    tjarr[code].flights.push(flight)
    tjarr[code].count++
  }
}

/** 排行榜快照：按 count 降序（同数按 code 升序保证稳定） */
export function snapshot() {
  return Object.values(tjarr)
    .sort((a, b) => (b.count - a.count) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((e) => ({ code: e.code, name: e.name, count: e.count }))
}

/** 全量分组数据（含每条航班的完整原始对象），按 count 降序 */
export function dumpGroups() {
  return Object.values(tjarr)
    .sort((a, b) => (b.count - a.count) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((e) => ({ code: e.code, name: e.name, count: e.count, flights: e.flights.slice() }))
}

/** 清空统计 */
export function clear() {
  for (const k of Object.keys(tjarr)) delete tjarr[k]
}

export default { addFlights, snapshot, dumpGroups, clear, resolveName }