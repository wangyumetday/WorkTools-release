// ============================================================
// JXGJ（锦绣国际）平台 adapter
// 移植自老 g1.js，拆为 prepareRequest / request / mergeResult 三步
// 语义：JXGJ 是源数据平台（步骤3），a1 → a2（含航班 + date_obj），不产出政策 xlsx
// ============================================================

import { makeFloorPriceFn } from './formula.js'
import { configSchema, defaults } from './config.js'

// ===== 内部常量 =====
const REQUEST_TIMEOUT_MS = 10000
const MAX_RETRIES = 3
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

// ===== 内部 helper（从 g1.js 移植）=====
function friendlyStatusError(status) {
  if (status === 429) return 'G1 平台限流（429 Too Many Requests），请降低并发数或稍后重试'
  if (status >= 500) return `G1 平台服务异常（HTTP ${status}）`
  return `G1 平台返回 HTTP ${status}`
}

async function fetchG1WithRetry(url, headers) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
      clearTimeout(timeoutId)
      if (res.ok) {
        try {
          return await res.json()
        } catch {
          throw new Error('G1 平台响应非 JSON 数据（平台可能正在维护）')
        }
      }
      if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        lastError = new Error(friendlyStatusError(res.status))
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw new Error(friendlyStatusError(res.status))
    } catch (err) {
      clearTimeout(timeoutId)
      if (err.message && err.message.startsWith('G1 平台')) throw err
      if (attempt < MAX_RETRIES) {
        lastError = new Error(`G1 平台网络请求失败：${err.message}`)
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw new Error(`G1 平台网络请求失败：${err.message}`)
    }
  }
  throw lastError || new Error('G1 平台请求失败：未知原因')
}

function findItemByCwItem(item, cw_item) {
  if (item.C舱位 !== cw_item) return false
  if (!(Number(item.S剩余座位数) >= 3)) return false
  const riqiStr = item.C出发时间_Date
  if (!riqiStr) return false
  const riqi = new Date(riqiStr)
  if (isNaN(riqi.getTime())) return false
  riqi.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const threeDaysLater = new Date(today)
  threeDaysLater.setDate(today.getDate() + 3)
  return riqi >= threeDaysLater
}

// ===== PlatformAdapter 接口 =====
export const key = 'jxgj'
export { configSchema, defaults }

/**
 * 预编译配置（Pipeline 启动时一次，整批共用）
 * 把字符串公式编译成函数
 */
export function compileConfig(rawConfig = {}) {
  const { floorPriceFormula: formulaStr = '', ...rest } = rawConfig
  return { ...rest, floorPriceFormula: makeFloorPriceFn(formulaStr) }
}

/** 平台登录（当前 mock，返回假 token） */
export async function login(credential) {
  const delay = 500 + Math.random() * 1000
  await new Promise(resolve => setTimeout(resolve, delay))
  return { token: `g1_token_${Math.random().toString(36).slice(2)}`, expiresIn: 7200 }
}

/**
 * 前置：拼 URL + 请求头
 * @param {object} a1Item - a1 任务项（CF_jichang/DD_jichang/hangsi/cangwei_str）
 * @returns {{ url: string, headers: object }}
 */
export function prepareRequest(a1Item) {
  const baseURL = 'https://ticket-int.xxklf.com'
  const path = '/api/Ticket/List'
  const params = {
    r: 4.01,
    currentPage: 1,
    pageSize: 200,
    arrAirPort: a1Item.CF_jichang,
    depAirPort: a1Item.DD_jichang,
    carrier: a1Item.hangsi,
  }
  return {
    url: baseURL + path + '?' + new URLSearchParams(params),
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0'
    }
  }
}

/**
 * 请求：发送 GET（带 429/5xx 重试 + 10s 超时）
 * @returns {Promise<object>} 原始响应（含 Msg / Content.List）
 */
export async function request(prepared) {
  return await fetchG1WithRetry(prepared.url, prepared.headers)
}

/**
 * 交叉：校验 + 按舱位过滤 + 计算底价 + 按日期分组 → 增强 a1Item 为 a2 项
 * @param {object} rawResponse - request 返回的原始响应
 * @param {object} a1Item - 原 a1 任务项（将被增强：cangwei_arr / date_obj）
 * @param {object} compiledConfig - 预编译配置（floorPriceFormula 是函数）
 * @returns {object} a2 项（即增强后的 a1Item，含 cangwei_arr + date_obj）
 */
export function mergeResult(rawResponse, a1Item, compiledConfig = {}) {
  const { floorPriceFormula } = compiledConfig
  if (rawResponse.Msg != 'OK') {
    throw new Error(`G1 平台返回业务异常：${rawResponse.Msg || '未知错误'}`)
  }
  // cangwei_str 仅按英文逗号分隔拆舱位（用户语义：文件里给什么用什么，拆不出就是 0 个）
  //   "Y,J,F" → ['Y', 'J', 'F']
  //   "Y, J, F" → ['Y', 'J', 'F']（trim 空格）
  //   "YJF" → ['YJF']（单元素，API 单字符舱位匹配不到 → 0 个，符合"拆不出就 0"）
  //   "" → [] → 跳过整个 for 循环
  const cwstr = a1Item.cangwei_str.split(',').map(s => s.trim()).filter(Boolean)
  const GW_data = rawResponse.Content.List
  a1Item.cangwei_arr = []

  for (const cw_item of cwstr) {
    const findItem = GW_data.find(item => findItemByCwItem(item, cw_item))
    if (findItem) {
      findItem.C成人总票价_CNY_INT = Math.ceil(findItem.C成人总票价_CNY)
      findItem.dijia = Math.ceil(floorPriceFormula(findItem.C成人总票价_CNY))
      findItem.C出发日期 = findItem.C出发时间_Date.split(' ')[0]
      a1Item.cangwei_arr.push(findItem)
    }
  }
  a1Item.date_obj = {}
  a1Item.cangwei_arr.forEach(item => {
    if (!a1Item.date_obj[item.C出发日期]) a1Item.date_obj[item.C出发日期] = []
    a1Item.date_obj[item.C出发日期].push(item)
  })
  // 返回兼容老 g1Request 的包装结构（阶段1过渡：保持下游 fileManager/controller/store 不破）
  // inputData 即增强后的 a2 项（含 cangwei_arr + date_obj）
  return {
    platform: 'jxgj',
    status: 'success',
    resultCode: '0000',
    resultMsg: '处理成功',
    data: {
      queryId: `G1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      inputData: a1Item,
      result: rawResponse,
      processedValue: Math.floor(Math.random() * 10000),
      timestamp: new Date().toISOString()
    }
  }
}

/** JXGJ 是源数据平台，不产出政策 xlsx */
export const exportTemplate = null

export default {
  key, configSchema, defaults,
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate
}
