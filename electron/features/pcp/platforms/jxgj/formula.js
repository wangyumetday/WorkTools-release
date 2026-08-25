// ============================================================
// JXGJ 公式编译（mathjs BigNumber 求值 + decimal.js 收 2 位）
// 从老 g1.js 抽出，JXGJ 平台专用
//
// 编译时机：由 jxgj/adapter.js 的 compileConfig 调用（Pipeline 启动时一次）
// 公式约束（编译期强制）：
//   - 仅允许 + - * / 和 ( ) 的组合，变量名固定 cost（代表总价）
//   - 拒绝 Math.* 函数、** 幂、% 取模、函数调用等一切非四则运算语法
// 兜底：任一失败降级为原价，不让请求中断
// ============================================================

import Decimal from 'decimal.js'
import { create, all } from 'mathjs'

// 金额精度：货币标准 2 位小数，由 decimal.js 统一管理，不再开放配置
const MONEY_DP = 2

// 独立 mathjs 实例：默认 BigNumber 类型，保证公式中间运算全程精确
const math = create(all, { number: 'BigNumber', precision: 64 })

// 运算符白名单（mathjs OperatorNode.fn 名称）：仅加减乘除及一元正负号
const ALLOWED_OPS = new Set(['add', 'subtract', 'multiply', 'divide', 'unaryPlus', 'unaryMinus'])

/**
 * 递归校验 AST 节点：只允许 数字字面量 / cost 变量 / 括号 / 白名单运算符
 */
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

/**
 * 把 mathjs 求值结果统一收尾为"货币 2 位"的 JS number
 */
function toMoneyNumber(result) {
  const str = typeof result === 'number' ? String(result) : result.toString()
  return new Decimal(str).toDecimalPlaces(MONEY_DP).toNumber()
}

/**
 * 把字符串公式编译成可调用函数 (totalPrice) => number
 * @param {string} formulaStr - 公式字符串，如 "cost * 1.1 + 50"
 * @returns {(totalPrice: number) => number}
 */
export function makeFloorPriceFn(formulaStr) {
  if (!formulaStr || typeof formulaStr !== 'string' || !formulaStr.trim()) {
    return (totalPrice) => Number(totalPrice) || 0
  }

  let compiled
  try {
    const node = math.parse(formulaStr)
    validateNode(node)
    compiled = node.compile()
    const probe = compiled.evaluate({ cost: math.bignumber(100) })
    const probeNum = toMoneyNumber(probe)
    if (!Number.isFinite(probeNum)) {
      throw new Error(`公式返回值不是有效数字: ${probe}`)
    }
  } catch (err) {
    console.warn(`[jxgj] 底价公式编译失败，降级为原价。公式: "${formulaStr}"，原因: ${err.message}`)
    return (totalPrice) => Number(totalPrice) || 0
  }

  return (totalPrice) => {
    const v = Number(totalPrice)
    if (!Number.isFinite(v)) return 0
    let r
    try {
      r = compiled.evaluate({ cost: math.bignumber(v) })
    } catch (err) {
      console.warn(`[jxgj] 底价公式运行异常，降级为原价: "${formulaStr}"，${err.message}`)
      return v
    }
    const num = toMoneyNumber(r)
    if (!Number.isFinite(num)) {
      console.warn(`[jxgj] 底价公式返回非数字，降级为原价: "${formulaStr}"，返回值=${r}`)
      return v
    }
    return num
  }
}

export { MONEY_DP }
export default { makeFloorPriceFn, MONEY_DP }
