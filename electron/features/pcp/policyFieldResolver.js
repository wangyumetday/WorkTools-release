// 政策字段变量解析器
// 职责：把「锦绣政策字段配置」里用户填写的字符串中的 ${变量名}
//       替换成 a3 比价结果行（item）对应字段的实际值。
//
// 背景：新格式政策导入文件的 11 个文本字段（Name/Remark/Y优先级 等）
//       由用户在「锦绣政策字段配置」板块填写，支持用 ${出发机场}-${到达机场}
//       这样的占位符拼接运行时变量，导出时逐行替换。
//       （「主行参与」开关不属于文本字段，不经过本解析器）
//
// 设计要点（对齐项目约束）：
//   1. 纯函数：输入 (字符串, item) → 输出替换后的字符串，无副作用
//   2. 未匹配的变量替换为空字符串（不残留 ${...} 污染输出），并打 warn 便于排查拼写错误
//   3. 非字符串输入（数字/空）原样返回，调用方无需特判
//   4. 变量映射表只读，集中维护：新增变量只改这里

import { A3_FIELDS } from './fieldNames.js'

/**
 * 变量名 → a3 行字段 key 的映射表
 *   用户在配置里写 ${出发机场}，导出时替换成 item[A3_FIELDS.C出发机场]
 *   新增可用变量：在此表追加一项即可，前端「可用变量」列表也以此为单一事实来源
 */
export const POLICY_FIELD_VARS = [
  { name: '出发机场', key: A3_FIELDS.C出发机场, desc: '出发机场三字码（如 JNB）' },
  { name: '到达机场', key: A3_FIELDS.D到达机场, desc: '到达机场三字码（如 DUR）' },
  { name: '出发城市', key: A3_FIELDS.C出发城市, desc: '出发城市三字码' },
  { name: '到达城市', key: A3_FIELDS.D到达城市, desc: '到达城市三字码' },
  { name: '航班号', key: A3_FIELDS.H航班号, desc: '航班号（如 FA210）' },
  { name: '航司名', key: A3_FIELDS.H航司名, desc: '航司二字码（如 FA）' },
  { name: '舱位', key: A3_FIELDS.C舱位, desc: '舱位（如 B）' },
  { name: '仓等', key: A3_FIELDS.仓等, desc: '仓等（如 经济舱）' },
  { name: '出发时间', key: A3_FIELDS.C出发时间_Date, desc: '出发时间完整字符串' },
  { name: '到达时间', key: A3_FIELDS.D到达时间_Date, desc: '到达时间完整字符串' },
  { name: '成人总票价CNY', key: A3_FIELDS.C成人总票价_CNY, desc: '成人总票价（人民币）' },
  { name: '携程底价', key: A3_FIELDS.XC_dijia, desc: '携程底价（won: 命中报价；lost: 全场最低有效报价，仅在底价检查文件展示）' },
  { name: '预计减价', key: A3_FIELDS.CUT_VALUE, desc: 'won: 携程底价 - 官网价 - 1；lost 不参与调价（留空）' },
  { name: '套餐索引', key: A3_FIELDS.套餐索引, desc: '套餐索引（仅套餐政策行有值；主行政策行留空）' },
  { name: '品牌名', key: A3_FIELDS.品牌名, desc: '套餐品牌名（锦绣 ExtValues.brandName_N；仅套餐政策行有值，缺失为 null）' }
]

// 变量名 → field key 的查找表（O(1)）
const _varKeyMap = new Map(POLICY_FIELD_VARS.map(v => [v.name, v.key]))

// 匹配 ${...} 占位符：非贪婪，支持中文变量名
const _VAR_RE = /\$\{([^}]+)\}/g

/**
 * 解析字符串中的 ${变量名} 占位符 → item 对应字段值
 *   - 非字符串输入原样返回（数字/null/undefined 不需解析）
 *   - 变量命中：替换为 item 对应字段值（缺失视为空字符串）
 *   - 变量未命中（拼错或未定义）：替换为空字符串 + console.warn
 *   - 无占位符的纯文本原样返回
 * @param {*} raw 用户配置的原始值（字符串/数字/null）
 * @param {object} item a3 比价结果行（含 C出发机场/H航司名 等）
 * @returns {*} 替换后的值（字符串原样返回纯数字会保持？不：含占位符返回字符串；纯数字原样返回数字）
 */
export function resolvePolicyField(raw, item) {
  if (typeof raw !== 'string') return raw
  // ★ 品牌名变量特殊约定（2026-09-23 起）：整个值就是 ${品牌名} 时，取不到 → 返回 null
  //   （导出层 null 落空单元格，避免出现 'null' 字符串）；拼接在文本中间时仍按空串合并
  if (raw === '${品牌名}') {
    const v = item ? item[A3_FIELDS.品牌名] : undefined
    return (v == null || v === '') ? null : String(v)
  }
  if (!raw.includes('${')) return raw
  return raw.replace(_VAR_RE, (_, varName) => {
    const fieldKey = _varKeyMap.get(varName)
    if (!fieldKey) {
      console.warn(`[policyFieldResolver] 未知变量 \${${varName}}，已替换为空`)
      return ''
    }
    const v = item ? item[fieldKey] : undefined
    return (v == null || v === '') ? '' : String(v)
  })
}

export default { resolvePolicyField, POLICY_FIELD_VARS }
