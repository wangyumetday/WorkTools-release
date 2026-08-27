// ============================================================
// JXGJ（锦绣国际）底价公式：独立模块，单独维护
//
// 设计原则（参考经验 1163791）：
//   1. 纯函数：compileFloorPrice(config) → { compute, debugInfo }
//      不访问 store、不写全局状态，便于单测与并发。
//   2. 单一解析器：验证 / 计算 共用 mathjs AST，不用 new Function/eval。
//   3. 每次计算产出 ComputeResult：含入参、命中公式、命中区间、原始值、最终底价、日志行。
//      方便 Electron console.log 和前端详情调试。
//
// 配置二选一（区间优先，与 config.js 注释一致）：
//   - rangePriceList 有任意行 → 区间优先查找，未命中区间回落到底价公式
//   - rangePriceList 空 → 直接用底价公式
// ============================================================

import Decimal from 'decimal.js'
import { create, all } from 'mathjs'

// 货币精度 2 位小数（行业标准，不开放配置）
const MONEY_DP = 2

// 独立 mathjs 实例：BigNumber 全程精确
const math = create(all, { number: 'BigNumber', precision: 64 })

// 运算符白名单：仅 + - * /（含一元 +/-）
const ALLOWED_OPS = new Set(['add', 'subtract', 'multiply', 'divide', 'unaryPlus', 'unaryMinus'])

// 模块版本号，便于前端展示"当前实现版本"
export const FLOOR_PRICE_VERSION = '1.0.0'

/** AST 递归校验：只允许数字、cost 变量、括号、白名单运算符 */
function validateNode(node) {
  if (node.type === 'ConstantNode') return
  if (node.type === 'SymbolNode') {
    if (node.name !== 'cost') throw new Error(`不允许的变量: ${node.name}（仅可用 cost）`)
    return
  }
  if (node.type === 'ParenthesisNode') {
    validateNode(node.content)
    return
  }
  if (node.type === 'OperatorNode') {
    if (!ALLOWED_OPS.has(node.fn)) {
      throw new Error(`不允许的运算符: ${node.op || node.fn}（仅可用 + - * / 和括号）`)
    }
    node.args.forEach(validateNode)
    return
  }
  throw new Error(`不允许的语法: ${node.type}（仅可用加减乘除与括号）`)
}

/** mathjs 结果 → 货币 2 位小数 number */
function toMoneyNumber(result) {
  const str = typeof result === 'number' ? String(result) : result.toString()
  return new Decimal(str).toDecimalPlaces(MONEY_DP).toNumber()
}

/**
 * 把单个字符串公式编译成函数（cost）→ { num, formulaStr }
 * 失败降级为 f(cost) => cost，同时记录降级原因（不抛错，不中断请求）
 */
function compileSingleFormula(formulaStr) {
  const safeStr = typeof formulaStr === 'string' ? formulaStr.trim() : ''
  if (!safeStr) {
    return {
      type: 'fallback-empty',
      fn: (cost) => Number(cost) || 0,
      formulaStr: 'cost（默认）',
      compileWarn: '公式为空，降级为原价'
    }
  }
  try {
    const node = math.parse(safeStr)
    validateNode(node)
    const compiled = node.compile()
    // 探针：cost=100 确保公式可执行
    const probe = compiled.evaluate({ cost: math.bignumber(100) })
    const probeNum = toMoneyNumber(probe)
    if (!Number.isFinite(probeNum)) {
      return {
        type: 'fallback-invalid',
        fn: (cost) => Number(cost) || 0,
        formulaStr: 'cost（默认）',
        compileWarn: `公式探针返回非数字: ${probe}`
      }
    }
    return {
      type: 'ok',
      formulaStr: safeStr,
      compileWarn: null,
      fn: (cost) => {
        const v = Number(cost)
        if (!Number.isFinite(v)) return 0
        try {
          const r = compiled.evaluate({ cost: math.bignumber(v) })
          const num = toMoneyNumber(r)
          return Number.isFinite(num) ? num : v
        } catch (err) {
          console.warn(`[floorPrice] 公式执行异常降级为原价: "${safeStr}", ${err.message}`)
          return v
        }
      }
    }
  } catch (err) {
    console.warn(`[floorPrice] 公式编译失败降级为原价: "${safeStr}", ${err.message}`)
    return {
      type: 'fallback-compile-err',
      fn: (cost) => Number(cost) || 0,
      formulaStr: 'cost（默认）',
      compileWarn: err.message || '编译异常'
    }
  }
}

/**
 * 预编译 config：产出 compute(cost) 纯函数 + debugInfo() 快照
 *
 * @param {object} rawConfig
 * @param {string} [rawConfig.floorPriceFormula='cost'] 全局底价公式，变量 cost = 成人总票价 CNY（原值）
 * @param {Array}  [rawConfig.rangePriceList=[]] 区间底价行 [[L, U, formula], ...]，优先于全局公式
 * @returns {{ compute: (cost: number|string) => ComputeResult, debugInfo: () => DebugInfo }}
 *
 * ComputeResult:
 *   { version, cost, formulaType, formulaStr, rangeHit, rawResult, floorPrice, logLine }
 *     formulaType ∈ 'range'    —— 命中区间行
 *                 | 'global'   —— 命中全局公式
 *                 | 'fallback' —— 降级为原价（公式为空/编译失败/运行异常）
 * DebugInfo:
 *   { version, hasRange, rangeCount, ranges: [{L,U,formulaStr,compileType,compileWarn}], globalFormula }
 */
export function compileFloorPrice(rawConfig = {}) {
  const formulaStr = rawConfig.floorPriceFormula ?? ''
  const rangeList = Array.isArray(rawConfig.rangePriceList) ? rawConfig.rangePriceList : []

  // 区间行预编译
  const compiledRanges = []
  for (const triple of rangeList) {
    if (!Array.isArray(triple)) continue
    const L = Number(triple[0])
    const U = Number(triple[1])
    if (!Number.isFinite(L) || !Number.isFinite(U) || L > U) continue
    const compiled = compileSingleFormula(typeof triple[2] === 'string' ? triple[2] : '')
    compiledRanges.push({ L, U, compiled })
  }

  const globalCompiled = compileSingleFormula(formulaStr)
  const hasRange = compiledRanges.length > 0

  /** 计算：对入参总票价执行"区间优先 → 全局公式 → 降级原价" */
  function compute(costInput) {
    const cost = Number(costInput)
    const validCost = Number.isFinite(cost) ? cost : 0

    // 区间优先：按配置顺序找第一个闭区间命中
    if (hasRange) {
      for (const { L, U, compiled } of compiledRanges) {
        if (validCost >= L && validCost <= U) {
          const rawResult = compiled.fn(validCost)
          // 区间行如果是降级原价（compile 失败），formulaType 记 fallback 便于查
          const isFallback = compiled.type.startsWith('fallback')
          const formulaType = isFallback ? 'fallback' : 'range'
          const logLine =
            `[floorPrice v${FLOOR_PRICE_VERSION}] cost=${validCost}` +
            ` → 命中区间 [${L}, ${U}] 公式=${compiled.formulaStr}` +
            ` → raw=${rawResult} → floorPrice=${rawResult}`
          // console.log(logLine)
          return {
            version: FLOOR_PRICE_VERSION,
            cost: validCost,
            formulaType,
            formulaStr: compiled.formulaStr,
            rangeHit: [L, U],
            rawResult,
            // ★ 最终底价 = 公式原值（2 位小数），不再外层 Math.ceil
            floorPrice: rawResult,
            logLine
          }
        }
      }
    }

    // 全局公式 / 降级原价
    const rawResult = globalCompiled.fn(validCost)
    const isFallback = globalCompiled.type.startsWith('fallback')
    const formulaType = isFallback ? 'fallback' : 'global'
    const logLine =
      `[floorPrice v${FLOOR_PRICE_VERSION}] cost=${validCost}` +
      ` → ${hasRange ? '区间未命中，回落' : '直接使用'} ${isFallback ? '降级' : '全局'}公式=${globalCompiled.formulaStr}` +
      ` → raw=${rawResult} → floorPrice=${rawResult}`
    // console.log(logLine)
    return {
      version: FLOOR_PRICE_VERSION,
      cost: validCost,
      formulaType,
      formulaStr: globalCompiled.formulaStr,
      rangeHit: null,
      rawResult,
      floorPrice: rawResult,
      logLine
    }
  }

  /** 返回当前配置快照（供前端详情调试标签显示） */
  function debugInfo() {
    return {
      version: FLOOR_PRICE_VERSION,
      hasRange,
      rangeCount: compiledRanges.length,
      ranges: compiledRanges.map(r => ({
        L: r.L,
        U: r.U,
        formulaStr: r.compiled.formulaStr,
        compileType: r.compiled.type,
        compileWarn: r.compiled.compileWarn
      })),
      globalFormula: {
        formulaStr: globalCompiled.formulaStr,
        compileType: globalCompiled.type,
        compileWarn: globalCompiled.compileWarn
      }
    }
  }

  return { compute, debugInfo }
}

export { MONEY_DP }
export default { compileFloorPrice, MONEY_DP, FLOOR_PRICE_VERSION }
