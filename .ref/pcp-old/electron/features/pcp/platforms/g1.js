// ============================================================
// G1 平台请求适配器
// 职责：
//   - compilePlatformConfig: 把字符串公式编译成函数（由 TaskManager 预编译缓存）
//   - g1Login: 平台登录（目前为 mock，返回假 token）
//   - g1Request: G1 平台数据请求（实际 HTTP 接口 + 舱位过滤 + 底价/优惠计算）
//
// context 参数（由 TaskManager.runPlatformRequest 注入）：
//   - context.credential       → { username, password, ... }  本次使用的平台账密
//   - context.loginResult      → { token, expiresIn, ... }     g1Login 返回的登录凭据
//   - context.platformConfig   → { floorPriceFormula(函数), markupPercent, enabled }
//
// 金额精度：MONEY_DP = 2（货币标准），用 decimal.js 收尾消除浮点误差
// ============================================================

import Decimal from 'decimal.js'
import { create, all } from 'mathjs'

// 金额精度：货币标准 2 位小数，由 decimal.js 统一管理，不再开放配置
const MONEY_DP = 2

// 独立 mathjs 实例：默认 BigNumber 类型，保证公式中间运算全程精确（mathjs 的 BigNumber 底层即 decimal.js）
// 仅用于公式求值，不污染全局；precision 给高一些，最后再由 decimal.js 收 2 位
const math = create(all, { number: 'BigNumber', precision: 64 })

// 运算符白名单（mathjs OperatorNode.fn 名称）：仅加减乘除及一元正负号
// power(**)/mod(%) 等一律拒绝，精确匹配"只用加减乘除组合"的需求
const ALLOWED_OPS = new Set(['add', 'subtract', 'multiply', 'divide', 'unaryPlus', 'unaryMinus'])

/**
 * 递归校验 AST 节点：只允许 数字字面量 / cost 变量 / 括号 / 白名单运算符。
 * 任一非白名单节点（函数调用 Math.*、**、%、条件表达式、范围、赋值等）→ 抛错。
 * 目的：把"只能加减乘除组合"的约束在编译期强制落地，同时堵住任意代码执行。
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
 * 把 mathjs 求值结果（BigNumber 或 number）统一收尾为"货币 2 位"的 JS number。
 * 通过字符串中转避免 mathjs 与项目 decimal.js 版本/实例差异；非有限数原样抛出由调用方降级。
 */
function toMoneyNumber(result) {
  const str = typeof result === 'number' ? String(result) : result.toString()
  const n = new Decimal(str).toDecimalPlaces(MONEY_DP).toNumber()
  return n
}

/**
 * 把字符串公式编译成可调用函数 (totalPrice) => number。
 * 编译时机：由 TaskManager.start() 调用 compilePlatformConfig 一次性预编译，
 * 之后注入 context.platformConfig.floorPriceFormula 即可直接当函数调用。
 *
 * 公式约束（编译期强制）：
 *   - 仅允许 + - * / 和 ( ) 的组合，变量名固定 cost（代表总价）
 *   - 自动处理空格、运算符优先级、括号，用户输入 cost+5*6-2 或 cost + 5 * 6 - 2 等价
 *   - 拒绝 Math.* 函数、** 幂、% 取模、函数调用等一切非四则运算语法
 *   - 示例："cost * 1.1 + 50"  "cost*(1-0.02)-20"  "-cost/3"
 *
 * 兜底（任一失败都降级为原价，不让请求中断）：
 *   - 公式为空 → 返回原价
 *   - 公式语法错 / 白名单不通过 → 警告 + 原价
 *   - 运行时异常 → 原价
 *   - 返回非有限数（如除以 0 得 Infinity）→ 原价
 *
 * 精度处理：求值全程走 mathjs BigNumber（精确），结果再用 decimal.js 收 2 位，
 *   彻底消除旧方案 new Function 走 JS 原生浮点导致的累积误差（如 1100.1*0.98）。
 */
function makeFloorPriceFn(formulaStr) {
  if (!formulaStr || typeof formulaStr !== 'string' || !formulaStr.trim()) {
    return (totalPrice) => Number(totalPrice) || 0
  }

  let compiled
  try {
    const node = math.parse(formulaStr)   // 字符串 → AST，自动处理空格/优先级/括号
    validateNode(node)                    // 白名单校验：仅四则运算 + cost
    compiled = node.compile()             // AST → 可复用求值对象，整批任务共用
    const probe = compiled.evaluate({ cost: math.bignumber(100) })
    const probeNum = toMoneyNumber(probe)
    if (!Number.isFinite(probeNum)) {
      throw new Error(`公式返回值不是有效数字: ${probe}`)
    }
  } catch (err) {
    console.warn(`[g1] 底价公式编译失败，降级为原价。公式: "${formulaStr}"，原因: ${err.message}`)
    return (totalPrice) => Number(totalPrice) || 0
  }

  return (totalPrice) => {
    const v = Number(totalPrice)
    if (!Number.isFinite(v)) return 0
    let r
    try {
      r = compiled.evaluate({ cost: math.bignumber(v) })
    } catch (err) {
      console.warn(`[g1] 底价公式运行异常，降级为原价: "${formulaStr}"，${err.message}`)
      return v
    }
    const num = toMoneyNumber(r)
    if (!Number.isFinite(num)) {
      console.warn(`[g1] 底价公式返回非数字，降级为原价: "${formulaStr}"，返回值=${r}`)
      return v
    }
    return num
  }
}

/**
 * 把 ConfigManager 返回的"字符串版"平台配置预编译成"函数版"。
 * 由 TaskManager.start() 调用，整批任务共用一份编译结果。
 * @param {object} rawConfig  ConfigManager.getPlatformConfig('g1') 的返回值
 * @returns {object} 编译后的配置（floorPriceFormula 已是函数）
 */
export function compilePlatformConfig(rawConfig = {}) {
  const { floorPriceFormula: formulaStr = '', ...rest } = rawConfig
  return {
    ...rest,
    floorPriceFormula: makeFloorPriceFn(formulaStr)
  }
}

// ============================================================
// 带重试的 G1 请求 helper
// 设计目的：解决并发请求触发 G1 平台 429 限流导致任务批量失败的问题
//   - 429/5xx → 指数退避重试 MAX_RETRIES 次（1s → 2s → 4s + 随机抖动）
//   - 网络/超时错误 → 同样重试
//   - 非 JSON 响应 → 抛友好错误（不再让 res.json() 抛 SyntaxError）
//   - 重试用尽 → 抛友好错误，让用户明确知道是被限流了
// ============================================================

// 单次请求超时（ms）：超过则 abort
const REQUEST_TIMEOUT_MS = 10000
// 最大重试次数（首次请求 + 重试 = 总共 MAX_RETRIES + 1 次尝试）
const MAX_RETRIES = 3
// 触发重试的 HTTP 状态码：429 限流、5xx 服务端异常
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * 把 HTTP 状态码翻成中文错误，让用户一眼看懂为什么失败
 */
function friendlyStatusError(status) {
  if (status === 429) return 'G1 平台限流（429 Too Many Requests），请降低并发数或稍后重试'
  if (status >= 500) return `G1 平台服务异常（HTTP ${status}）`
  return `G1 平台返回 HTTP ${status}`
}

/**
 * 带重试的 GET 请求
 * @returns {Promise<object>} 解析后的 JSON 数据
 * @throws {Error} 重试用尽后抛友好错误，错误信息会冒泡到 TaskManager 写入 task.result.error
 */
async function fetchG1WithRetry(url, headers) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
      clearTimeout(timeoutId)

      // 2xx：成功响应，解析 JSON
      if (res.ok) {
        try {
          return await res.json()
        } catch {
          // 200 但 body 不是 JSON：平台维护/异常页面等
          throw new Error('G1 平台响应非 JSON 数据（平台可能正在维护）')
        }
      }

      // 非 2xx：根据状态码决定是否重试
      if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        lastError = new Error(friendlyStatusError(res.status))
        // 指数退避：1s, 2s, 4s（加随机抖动避免多 worker 同步重试再次撞限流）
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      // 不在重试白名单或重试用尽：直接抛友好错误
      throw new Error(friendlyStatusError(res.status))
    } catch (err) {
      clearTimeout(timeoutId)

      // 已是友好错误（friendlyStatusError / 非 JSON 抛的），直接透传不再重试
      if (err.message && err.message.startsWith('G1 平台')) {
        throw err
      }
      // 网络/超时错误（abort、ECONNRESET 等）→ 重试
      if (attempt < MAX_RETRIES) {
        lastError = new Error(`G1 平台网络请求失败：${err.message}`)
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw new Error(`G1 平台网络请求失败：${err.message}`)
    }
  }
  // 所有重试用尽：抛最后一次的错误（让前端 task.result.error 显示明确原因）
  throw lastError || new Error('G1 平台请求失败：未知原因')
}

/**
 * G1 平台数据请求
 * 步骤：
 *   1. 拼 URL + 请求头（含 User-Agent）
 *   2. 调用 fetchG1WithRetry（内部含 10s 超时 + 429/5xx 指数退避重试）
 *   3. 校验 Msg==='OK'
 *   4. 按 cabin 字符串逐字符过滤舱位（findItemByCwItem）
 *   5. 计算底价 / 优惠（用 Decimal 避免浮点误差）
 *   6. 按 C出发日期 分组到 data.date_obj
 */
export async function g1Request(data, context = {}) {
  // floorPriceFormula 已经是编译好的函数（由 compilePlatformConfig 预编译）
  const { floorPriceFormula, markupPercent = 0 } =
    context.platformConfig || {}

  const baseURL = 'https://ticket-int.xxklf.com'   // ← 改成实际
  const path = '/api/Ticket/List'                  // ← 改成实际
  const params = {
    r: 4.01,
    currentPage: 1,
    pageSize: 200,
    arrAirPort: data.CF_jichang,
    depAirPort: data.DD_jichang,
    carrier: data.hangsi,
  }
  const url1 = baseURL + path + '?' + new URLSearchParams(params)
  // 浏览器请求头
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
  }

  // ★ 调用带重试的请求 helper：429/5xx 自动退避重试，重试用尽抛友好错误
  //   错误会冒泡到 TaskManager.runNextTask 的 catch，写入 task.result.error 供前端展示
  const res_data = await fetchG1WithRetry(url1, headers)

  // 业务校验：G1 平台返回的 Msg 字段不等于 'OK' 视为业务失败
  if (res_data.Msg != 'OK') {
    throw new Error(`G1 平台返回业务异常：${res_data.Msg || '未知错误'}`)
  }

  const cwstr = data.cangwei_str
  const GW_data = res_data.Content.List
  data.cangwei_arr = []
  for (let cw_item of cwstr) {
    const findItem = GW_data.find(item => findItemByCwItem(item, cw_item))
    if (findItem) {
      // 底价：调用预编译好的 floorPriceFormula（mathjs BigNumber 求值 + decimal.js 收 2 位），再向上取整
      findItem.C成人总票价_CNY_INT = Math.ceil(findItem.C成人总票价_CNY)
      findItem.dijia = Math.ceil(floorPriceFormula(findItem.C成人总票价_CNY))
      // if (findItem.C出发机场 == "ELS" && findItem.D到达机场 == "JNB" && findItem.C舱位 == "P") {
      //   console.log(findItem)
      // }
      // 金额减法用 Decimal 避免 JS 浮点误差（如 1100.1 - 1000 = 100.0999999999999）
      // findItem.kuishun = new Decimal(findItem.C成人总票价_CNY)
      //   .minus(floorPriceFormula(findItem.C成人总票价_CNY))
      //   .toDecimalPlaces(MONEY_DP)
      //   .toNumber()
      findItem.C出发日期 = findItem.C出发时间_Date.split(' ')[0]
      data.cangwei_arr.push(findItem)
    }
    data.date_obj = {}
    // 遍历data.cangwei_arr，将所有日期添加到data.date_obj
    data.cangwei_arr.forEach(item => {
      // 检查date_obj中是否存在item.C出发日期属性
      if (!data.date_obj[item.C出发日期]) {
        data.date_obj[item.C出发日期] = []
      }
      data.date_obj[item.C出发日期].push(item)
    })
  }
  return {
    platform: 'jxgj',
    status: 'success',
    resultCode: '0000',
    resultMsg: '处理成功',
    data: {
      queryId: `G1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      inputData: data,
      result: res_data,
      processedValue: Math.floor(Math.random() * 10000),
      timestamp: new Date().toISOString()
    }
  }
}

// G1 平台登录（当前为 mock，返回假 token；真实接口替换为 axios.post('/login')）
export async function g1Login(credential) {
  const delay = 500 + Math.random() * 1000
  await new Promise(resolve => setTimeout(resolve, delay))
  return {
    token: `g1_token_${Math.random().toString(36).slice(2)}`,
    expiresIn: 7200
  }
}

/**
 * 按舱位过滤 G1 返回数据
 * 规则：
 *   1. 舱位必须匹配当前遍历的舱位字符
 *   2. 剩余座位数 >= 3
 *   3. 出发日期必须在"今天 + 3 天"以后
 */
function findItemByCwItem(item, cw_item) {
  // 1. 舱位必须匹配当前遍历的舱位
  if (item.C舱位 !== cw_item) return false
  // 2. 剩余座位数必须 > 3
  if (!(Number(item.S剩余座位数) >= 3)) return false
  // 3. 出发日期必须在"今天 + 3 天"以后（保留原 isAfterThreeDays 语义）
  const riqiStr = item.C出发时间_Date
  if (!riqiStr) return false
  const riqi = new Date(riqiStr)
  if (isNaN(riqi.getTime())) return false  // 日期无效，跳过
  riqi.setHours(0, 0, 0, 0)  // 出发日零点，去掉时分秒干扰
  const today = new Date()
  today.setHours(0, 0, 0, 0)  // 今天零点
  const threeDaysLater = new Date(today)
  threeDaysLater.setDate(today.getDate() + 3)  // 今天 + 3 天零点

  return riqi >= threeDaysLater
}
