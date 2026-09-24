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