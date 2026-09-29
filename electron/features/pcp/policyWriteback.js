// 携程政策回写纯逻辑模块（2026-09-24）
//   职责：把本次跑批生成的政策行（147 列扁平行）逐条与「用户上传的外部政策文件」匹配回写，
//   以及政策导入文件「只输出单程」的行过滤。纯函数、无 fs/Electron 依赖，测试可直接 import。
//
// 回写规则（与用户对齐）：
//   - 9 项全等即同一政策：OTAConfigID/航程类型/航司名/机场航线匹配/舱位/
//     去程套餐索引v2/爬虫名/价格基础类型/创建人id（全部为政策文件模板实列名）
//   - 命中 → 取「第一条命中用户行」的 ID、CreateTime 覆盖到我方行，整条替换；
//     多条命中 = 多变一：删除全部命中行、我方更新行追加到文件末尾
//   - 未命中 → 我方行直接追加（ID/CreateTime 留空）

/** 9 个匹配键（顺序固定，签名据此拼接） */
export const POLICY_MATCH_KEYS = [
  'OTAConfigID', '航程类型', '航司名', '机场航线匹配', '舱位',
  '去程套餐索引v2', '爬虫名', '价格基础类型', '创建人id'
]

/** 用户政策文件必须包含的列（9 键 + ID + CreateTime） */
export const POLICY_REQUIRED_HEADERS = [...POLICY_MATCH_KEYS, 'ID', 'CreateTime']

/**
 * 9 键字符串化统一口径（防 11 vs '11'、xq vs XQ 不等）：
 *   - null/undefined/空串/纯空白 → ''（空值统一）
 *   - 数字与纯数字文本 → String(Number(v))：11 == '11' == '11.0' == '011'
 *   - 其余文本 → trim + toUpperCase（航司名/机场码/舱位/中文单程·总价不受影响）
 */
export function normalizePolicyKey(v) {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  const s = String(v).trim()
  if (s === '') return ''
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return String(n)
  }
  return s.toUpperCase()
}

/** 表头名 → 列索引（只收录所需列：9 键 + ID + CreateTime） */
export function buildHeaderKeyMap(headers) {
  const map = {}
  if (Array.isArray(headers)) {
    headers.forEach((h, idx) => {
      if (h == null) return
      const name = String(h).trim()
      if (name && POLICY_REQUIRED_HEADERS.includes(name) && map[name] == null) map[name] = idx
    })
  }
  return map
}

/** 我方 147 列扁平行 {key:value} → 9 键签名 */
export function signatureOfFlatRow(flatRow) {
  return JSON.stringify(POLICY_MATCH_KEYS.map(k => normalizePolicyKey(flatRow?.[k])))
}

/** 用户行（数组值 + 列索引表）→ 9 键签名 */
export function signatureOfUserRow(userRowArr, keyColMap) {
  return JSON.stringify(POLICY_MATCH_KEYS.map(k => {
    const idx = keyColMap?.[k]
    return idx == null ? '' : normalizePolicyKey(userRowArr?.[idx])
  }))
}

/**
 * 政策导入文件行过滤：只保留「非比输（可比赢）」且「航程类型=单程」的行。
 * 与 ExcelExporter 既有 `_outcome !== 'lost'` 过滤并列使用；
 * 老数据无 _outcome（undefined !== 'lost' 为 true）行为与历史一致。
 */
export function keepPolicyRow(row, outcomeField) {
  if (row?.[outcomeField] === 'lost') return false
  return normalizePolicyKey(row?.['航程类型']) === normalizePolicyKey('单程')
}

// ===== 异常航线（无投放）判定（2026-09-29 起，纯函数供 fileManager/ExcelExporter 共用） =====
// 政策文件匹配字段（5 列，2026-09-29 改：从 Name 解析 → 直接按列取值）：
//   航司名 / 机场航线匹配（出发-到达 3 字码） / 舱位 / 去程套餐索引v2（纯数字） / 航程类型（单程/多程）
// 比对口径：
//   套餐级块：航司名 + 机场航线匹配 + 舱位 + 去程套餐索引v2 + 航程类型（五条件）
//   主行级块：航司名 + 机场航线匹配 + 舱位 + 航程类型（四条件，无套餐索引）

/**
 * 从政策文件表头定位五列索引；缺失列名返回 null
 * @returns {{airlineIdx:number, routeIdx:number, cabinIdx:number, pkgIdx:number, journeyIdx:number}|null}
 */
export function findAbnormalPolicyColIndices(headers) {
  if (!Array.isArray(headers)) return null
  const idx = (name) => headers.findIndex(h => String(h ?? '').trim() === name)
  const airlineIdx = idx('航司名')
  const routeIdx = idx('机场航线匹配')
  const cabinIdx = idx('舱位')
  const pkgIdx = idx('去程套餐索引v2')
  const journeyIdx = idx('航程类型')
  if (airlineIdx < 0 || routeIdx < 0 || cabinIdx < 0) return null
  return { airlineIdx, routeIdx, cabinIdx, pkgIdx, journeyIdx }
}

/**
 * 政策文件行 → 归一化的异常航线匹配条目
 * @returns {{airline, route, cabin, pkgIndex, journeyType}|null}  某关键字段缺失 → null（不误判）
 */
export function extractAbnormalPolicyEntry(row, colIdx) {
  if (!row || !colIdx) return null
  const airline = normalizePolicyKey(row[colIdx.airlineIdx])
  const route = normalizePolicyKey(row[colIdx.routeIdx])
  const cabin = normalizePolicyKey(row[colIdx.cabinIdx])
  const pkgIndex = colIdx.pkgIdx >= 0 ? normalizePolicyKey(row[colIdx.pkgIdx]) : ''
  const journeyType = colIdx.journeyIdx >= 0 ? normalizePolicyKey(row[colIdx.journeyIdx]) : ''
  if (!airline || !route || !cabin) return null
  return { airline, route, cabin, pkgIndex, journeyType }
}

/**
 * 无投放块是否命中政策文件（异常航线，五维度比对）
 *   套餐级块：航司名 + 航线 + 舱位 + 套餐索引 + 航程类型（五条件全等）
 *   主行级块：航司名 + 航线 + 舱位 + 航程类型（四条件，无套餐索引）
 *   缺航司/缺航线/缺舱位 → false（不误判）
 */
export function isAbnormalBlock(block, policyEntries) {
  if (!block) return false
  const airline = normalizePolicyKey(block.airline)
  const route = normalizePolicyKey(`${block.depAirport}-${block.arrAirport}`)
  const cabin = normalizePolicyKey(block.seatClass)
  const journeyType = normalizePolicyKey(block.journeyType)
  if (!airline || !route || !cabin) return false
  const entries = Array.isArray(policyEntries) ? policyEntries : []
  if (block.kind === 'package') {
    if (block.pkgIndex == null) return false
    const pkgIdx = normalizePolicyKey(block.pkgIndex)
    return entries.some(p =>
      p && p.airline === airline && p.route === route && p.cabin === cabin
      && p.pkgIndex === pkgIdx && p.journeyType === journeyType
    )
  }
  return entries.some(p =>
    p && p.airline === airline && p.route === route && p.cabin === cabin
    && p.journeyType === journeyType
  )
}

/**
 * 修正 trip 任务 summary（异常航线，2026-09-29）：
 *   - 无投放对比块（套餐块 + 开启主行参与时的主行块）命中政策文件 → 计「异常航线」abnormalPackageCount
 *   - 此类不计入「独占数量」（quoteUnmatched 按块数扣除；1 块 = 1 单元）
 *   - 不再产原价政策行：仅套餐级异常块扣除政策行数（主行块本就不产政策行）
 * @returns {number} 本次计入的异常块数
 */
export function adjustAbnormalPackageSummary(summary, policyEntries) {
  if (!summary) return 0
  const blocks = Array.isArray(summary.noBidBlocks) ? summary.noBidBlocks : []
  const abnormal = blocks.filter(b => isAbnormalBlock(b, policyEntries))
  const abnormalPkg = abnormal.filter(b => b?.kind === 'package').length
  if (abnormal.length === 0) return 0
  summary.abnormalPackageCount = (Number(summary.abnormalPackageCount) || 0) + abnormal.length
  const prevU = Number(summary.quoteUnmatched) || 0
  summary.quoteUnmatched = Math.max(0, prevU - abnormal.length)
  const prevP = Number(summary.policyRowCount) || 0
  summary.policyRowCount = Math.max(0, prevP - abnormalPkg)
  return abnormal.length
}

/** 我方 147 列扁平行 → 按用户文件表头列序重排为数组（缺失列填 ''；对象值转 JSON 字符串防泄漏结构） */
export function buildRowInUserColumnOrder(flat, headers) {
  const arr = new Array(headers.length).fill('')
  for (let c = 0; c < headers.length; c++) {
    const h = headers[c]
    if (h == null || h === '') continue
    const v = flat?.[String(h).trim()]
    arr[c] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : (v == null ? '' : v)
  }
  return arr
}

/**
 * 执行政策回写（多变一语义）
 * @param {Array<Object>} ourFlatRows   我方政策行（已按 exportTemplate.columns 扁平化、已过滤 won+单程），
 *                                      含 ID/CreateTime 空值列
 * @param {object}         userPolicy   { headers: string[], keyColMap: {列名:colIdx}, rows: Array<Array> }
 * @returns {{ finalRows: Array<Array>, deletedCount: number, hitCount: number, appendCount: number }}
 *          finalRows = 未命中用户行（保序）+ 我方更新/新增行（追加末尾，按用户列序）
 */
export function applyPolicyWriteback(ourFlatRows, userPolicy) {
  const { headers, keyColMap, rows } = userPolicy

  // 我方行按 9 键签名去重（同一 9 键只取第一个，防数据异常重复）
  const ourBySig = new Map()
  for (let i = 0; i < ourFlatRows.length; i++) {
    const sig = signatureOfFlatRow(ourFlatRows[i])
    if (!ourBySig.has(sig)) ourBySig.set(sig, i)
  }

  const matchedUserIdx = new Set() // 被命中的用户行（整条删除）
  const appended = []             // 追加到末尾的我方行（按用户列序）
  let hitCount = 0                // 命中过用户行的我方行数（新增行不计）

  for (const [sig, ourIdx] of ourBySig) {
    const our = ourFlatRows[ourIdx]
    const hitIdxs = []
    for (let j = 0; j < rows.length; j++) {
      if (!matchedUserIdx.has(j) && signatureOfUserRow(rows[j], keyColMap) === sig) hitIdxs.push(j)
    }
    let out = our
    if (hitIdxs.length > 0) {
      // 命中：ID/CreateTime 取「第一条命中用户行」（多变一后只剩我方一条，只能取一个）
      const first = rows[hitIdxs[0]]
      out = { ...our, ID: first[keyColMap.ID] ?? '', CreateTime: first[keyColMap.CreateTime] ?? '' }
      for (const idx of hitIdxs) matchedUserIdx.add(idx)
      hitCount++
    }
    appended.push(buildRowInUserColumnOrder(out, headers))
  }

  const finalRows = []
  for (let j = 0; j < rows.length; j++) {
    if (!matchedUserIdx.has(j)) finalRows.push(rows[j])
  }
  finalRows.push(...appended)

  return {
    finalRows,
    deletedCount: matchedUserIdx.size,
    hitCount,
    appendCount: appended.length
  }
}