// ============================================================
// JXGJ（锦绣国际）平台 adapter
// 移植自老 g1.js，拆为 prepareRequest / request / mergeResult 三步
// 语义：JXGJ 是源数据平台（步骤3），a1 → a2（含航班 + date_obj），不产出政策 xlsx
// ============================================================

import { compileFloorPrice } from './floorPrice.js'
import { configSchema, defaults } from './config.js'
import { A1_FIELDS, A2_FIELDS, A3_FIELDS, JXGJ_RESPONSE_FIELDS } from '../../fieldNames.js'

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
  if (item[A3_FIELDS.C舱位] !== cw_item) return false
  // let ZWS = item.套餐信息[0].座位数
  // console.log('item.套餐信息', item)
  let ZWS = item.S剩余座位数
  if (item.套餐信息.length > 0) {
    ZWS = item.套餐信息[0].座位数
  }
  if (ZWS < 3) return false
  const riqiStr = item[JXGJ_RESPONSE_FIELDS.C出发时间_Date]
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
 * 底价计算：抽离到独立模块 floorPrice.js（单独维护，含命中区间/公式的日志与调试信息）
 * 返回：
 *   - floorPrice.compute(cost)     → ComputeResult（cost→底价，含命中来源/公式/区间/日志）
 *   - floorPrice.debugInfo()       → 当前配置快照（供前端详情调试标签）
 * 区间优先：rangePriceList 有任意行 → 区间优先查找，未命中回落到底价公式
 *          rangePriceList 空 → 直接用底价公式
 */
export function compileConfig(rawConfig = {}) {
  const { floorPriceFormula, rangePriceList, ...rest } = rawConfig
  const { compute, debugInfo } = compileFloorPrice({ floorPriceFormula, rangePriceList })
  return {
    ...rest,
    floorPrice: { compute, debugInfo },
    // 兼容老接口（平台 runner 读 platformConfig.floorPriceFormula 名称不变）：
    // floorPriceFormula = cost → ComputeResult.floorPrice；mergeResult 里拿到 ComputeResult 后取 .floorPrice
    floorPriceFormula: (cost) => compute(cost)
  }
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
    arrAirPort: a1Item[A1_FIELDS.DD_jichang],
    depAirPort: a1Item[A1_FIELDS.CF_jichang],
    carrier: a1Item[A1_FIELDS.hangsi],
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
  // floorPriceFormula 是 compileConfig 返回的兼容入口：(cost) => ComputeResult
  const { floorPriceFormula } = compiledConfig
  if (rawResponse.Msg != 'OK') {
    throw new Error(`G1 平台返回业务异常：${rawResponse.Msg || '未知错误'}`)
  }
  // ARCH-2：无副作用——创建 a1Item 副本，不修改入参
  //   下游 fileManager.saveA2FromJxgjTasks 用返回的 inputData 作为 a2 项，副本即 a2
  const a2Item = { ...a1Item }
  // cangwei_str 仅按英文逗号分隔拆舱位（拆不出就 0 个）
  const cwstr = a2Item[A1_FIELDS.cangwei_str].split(',').map(s => s.trim()).filter(Boolean)
  const GW_data = rawResponse.Content.List
  a2Item[A2_FIELDS.cangwei_arr] = []
  for (const cw_item of cwstr) {
    const findItem = GW_data.find(item => findItemByCwItem(item, cw_item))
    if (findItem) {
      // C成人总票价_CNY_INT：显示用整数（ceil 到元）
      findItem[A2_FIELDS.C成人总票价_CNY_INT] = Math.ceil(findItem[JXGJ_RESPONSE_FIELDS.C成人总票价_CNY])
      // ★ 底价 dijia：走独立模块 floorPrice.js（区间优先→全局→降级原价）
      //   ComputeResult.floorPrice = 公式原值(2 位小数)，不再外层 Math.ceil
      //   同时把命中来源/公式/区间写到舱位项 _floorMeta，供前端详情调试标签展示
      const fp = floorPriceFormula(findItem[JXGJ_RESPONSE_FIELDS.C成人总票价_CNY])
      findItem[A2_FIELDS.dijia] = fp.floorPrice
      findItem._floorMeta = {
        version: fp.version,
        formulaType: fp.formulaType,
        formulaStr: fp.formulaStr,
        rangeHit: fp.rangeHit,
        cost: fp.cost,
        rawResult: fp.rawResult
      }
      findItem[JXGJ_RESPONSE_FIELDS.C出发日期] = findItem[JXGJ_RESPONSE_FIELDS.C出发时间_Date].split(' ')[0]
      a2Item[A2_FIELDS.cangwei_arr].push(findItem)
    }
  }
  a2Item[A2_FIELDS.date_obj] = {}
  a2Item[A2_FIELDS.cangwei_arr].forEach(item => {
    if (!a2Item[A2_FIELDS.date_obj][item[JXGJ_RESPONSE_FIELDS.C出发日期]]) a2Item[A2_FIELDS.date_obj][item[JXGJ_RESPONSE_FIELDS.C出发日期]] = []
    a2Item[A2_FIELDS.date_obj][item[JXGJ_RESPONSE_FIELDS.C出发日期]].push(item)
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
      inputData: a2Item,
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
