// 政策调价金额写入规则（共享业务规则）
// 用途：写入两个文件前对调价金额做最终加工：
//   - 政策导入文件「调价固定加减钱」列（trip exportTemplate）
//   - 底价检查文件「预计减价」列（ExcelExporter，主行与套餐子行）
// 规则（政策导入平台只接受整数）：
//   1. 计算阶段（CUT_VALUE / 套餐差值）不扣让利额，只保留精确价差（可能带小数），
//      保证数值准确性 —— 携程价本身已按口径向下取整（19.9→19）；
//   2. 写入文件前统一：向下取整（floor）再 − cutOffset，即 floor(v) − cutOffset。
//      cutOffset = 「比携程低多少元」，用户在平台配置的携程 OTA 平台里设置，默认 1。
//      - 整数价差：v − cutOffset → 生效价恰 = 携程价(取整) − cutOffset（低 cutOffset 元）
//      - 小数价差：floor(v) − cutOffset → 生效价比携程价(取整) 低 cutOffset ~ cutOffset+1 元
//        （整数调价下的最贴近值）
//      - 负数价差（官网价高于携程价时）：同样 floor(v) − cutOffset（如 -4.5、cutOffset=1 → -6），略有让利
//      - 0：−cutOffset（价差为0即原价等于携程价，写入 −cutOffset 后生效低 cutOffset 元）
//   3. null/空/非数字原样透传（写入时自然留空）。

/** 「比携程低多少元」默认值（平台配置未设置/非法时回退） */
export const DEFAULT_CUT_OFFSET = 1

/** 解析 cutOffset：非数字（undefined/null/''/NaN 等）回退默认值 1 */
export function resolveCutOffset(raw, fallback = DEFAULT_CUT_OFFSET) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function formatPolicyAdjust(v, offset = DEFAULT_CUT_OFFSET) {
  if (v == null || v === '') return v
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return Math.floor(n) - resolveCutOffset(offset)
}

export default { formatPolicyAdjust, resolveCutOffset, DEFAULT_CUT_OFFSET }
