// ============================================================
// Excel 机场对解析器
// 职责：读取 .xlsx，提取 (出发机场, 到达机场) 二元组
// 规则：
//   - 前两列依次为 出发机场 / 到达机场
//   - 自动识别首行是否为表头（非 2~4 位字母/数字 = 视为表头，跳过）
//   - 任一机场为空 → 跳过该行
//   - 机场代码 trim 后大写统一
//   - 同 (dep, arr) 去重，保留首次顺序
// ============================================================

import XLSX from 'xlsx'
import { readFileSync } from 'node:fs'

/**
 * 判断字符串是否为"看起来有效的机场代码"
 *   IATA 三字码：纯 3 位字母（允许 3~4 位以防老代码/自编码）
 */
function looksLikeAirportCode(s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  return /^[A-Z0-9]{2,4}$/.test(t)
}

/**
 * 解析 xlsx 文件得到去重后的航线对数组
 *
 * @param {string} filePath  绝对路径 .xlsx
 * @returns {Promise<{ pairs: Array<{dep:string, arr:string}>, skippedRows: number, duplicateCount: number, hasHeader: boolean }>}
 */
export async function parseAirportPairsFromXlsx(filePath) {
  const buf = readFileSync(filePath)
  const wb = XLSX.read(buf, { type: 'buffer' })
  const firstSheetName = wb.SheetNames[0]
  if (!firstSheetName) {
    throw new Error('Excel 文件没有任何工作表')
  }
  const ws = wb.Sheets[firstSheetName]
  // 按行读数组，保留空行空位，避免丢掉行结构
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: '',
    blankrows: false,
  })

  if (!Array.isArray(rows) || rows.length === 0) {
    return { pairs: [], skippedRows: 0, duplicateCount: 0, hasHeader: false }
  }

  // ---------- 识别表头 ----------
  // 首行的前两个单元格若都"不像机场代码" → 视为表头，跳过
  let hasHeader = false
  let startIdx = 0
  const [c0, c1] = [String(rows[0][0] ?? '').trim(), String(rows[0][1] ?? '').trim()]
  if (!(looksLikeAirportCode(c0) && looksLikeAirportCode(c1))) {
    hasHeader = true
    startIdx = 1
  }

  const seen = new Set()
  const pairs = []
  let skippedRows = 0
  let duplicateCount = 0

  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i]
    const dep = String(row[0] ?? '').trim().toUpperCase()
    const arr = String(row[1] ?? '').trim().toUpperCase()

    if (!dep || !arr) {
      skippedRows++
      continue
    }

    const key = `${dep}|${arr}`
    if (seen.has(key)) {
      duplicateCount++
      continue
    }
    seen.add(key)
    pairs.push({ dep, arr })
  }

  return { pairs, skippedRows, duplicateCount, hasHeader }
}

export default { parseAirportPairsFromXlsx }
