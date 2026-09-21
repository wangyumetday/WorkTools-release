// ============================================================
// JXGJ（锦绣国际）平台 adapter
// 数据源接口：spider.xxklf.com/TaskResult/api/TaskResult/GetList（POST JSON）
// 语义：JXGJ 是源数据平台，a1 → a2（含航班 + date_obj），不产出政策 xlsx
// 调用链（PlatformAdapter 接口，按执行顺序排列）：
//   compileConfig → login → prepareRequest → request → mergeResult
// ============================================================

import { compileFloorPrice } from './floorPrice.js'
import { configSchema, defaults } from './config.js'
import { A1_FIELDS, A2_FIELDS, A3_FIELDS, JXGJ_RESPONSE_FIELDS } from '../../fieldNames.js'
import { AnyToCny } from './HuiLvZhuanHuan.js'
import * as taskResultApi from './taskResultApi.js'
import { airportToCity } from '../../airportToCity.js'

// ===== PlatformAdapter 接口 =====

export const key = 'jxgj'
export { configSchema, defaults }

/**
 * 预编译配置（Pipeline 启动时一次，整批共用）
 * 底价计算：抽离到独立模块 floorPrice.js
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
    // 兼容下游：floorPriceFormula(cost) → ComputeResult.floorPrice
    floorPriceFormula: (cost) => compute(cost)
  }
}

/** 前置：构建 TaskResult GetList 查询参数 */
export function prepareRequest(a1Item) {
  return {
    depAirPort: a1Item[A1_FIELDS.CF_jichang],
    arrAirPort: a1Item[A1_FIELDS.DD_jichang],
    carrier: a1Item[A1_FIELDS.hangsi],
  }
}

/**
 * 请求：调用 spider.TaskResult.GetList（带 429/5xx 重试 + 15s 超时）
 * @returns {Promise<object>} 原始响应，补齐 Msg='OK' 兼容 mergeResult 校验
 */
export async function request(query) {
  const res = await taskResultApi.fetchList(query)
  if (res.Msg === undefined) res.Msg = 'OK'
  return res
}

/**
 * 交叉：校验 + 按舱位过滤 + 计算底价 + 按日期分组 → a2 项
 * @param {object} rawResponse  request 返回的原始响应
 * @param {object} a1Item       原 a1 任务项（将被增强：cangwei_arr / date_obj）
 * @param {object} compiledConfig  预编译配置（floorPriceFormula 是函数）
 */
export function mergeResult(rawResponse, a1Item, compiledConfig = {}) {
  const { floorPriceFormula } = compiledConfig
  // 座位数下限（锦绣配置页可调，默认 3；数据源座位数普遍偏低时可调低避免全部淘汰）
  const minSeats = Number(compiledConfig.minSeats ?? 3)

  function geshihua(findItem) {
    // 显示用整数（ceil 到元）
    findItem[A2_FIELDS.C成人总票价_CNY_INT] = Math.ceil(findItem[JXGJ_RESPONSE_FIELDS.C成人总票价_CNY])
    // 底价：独立模块 floorPrice.js（区间优先→全局→降级原价）
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
    // 机场三字码 → 城市三字码（TaskResult API 不返回城市码，由 airportToCity 转换）
    findItem[A3_FIELDS.C出发城市] = airportToCity(findItem.C出发机场)
    findItem[A3_FIELDS.D到达城市] = airportToCity(findItem.D到达机场)
    return findItem
  }

  if (rawResponse.Msg != 'OK') {
    throw new Error(`JXGJ 平台返回业务异常：${rawResponse.Msg || '未知错误'}`)
  }
  // 无副作用：创建 a1Item 副本作为 a2 项
  const a2Item = { ...a1Item }
  const cwstr = a2Item[A1_FIELDS.cangwei_str].split(',').map(s => s.trim()).filter(Boolean)
  const GW_data = rawResponse.Content.List || []

  // ★ 贪心集合覆盖选航班：在"覆盖全部匹配舱位"前提下最小化日期数
  //   每个日期后续会拆成一个携程请求，日期数 = 携程请求数（越少越省限流额度）
  //   返回结果按用户舱位串顺序排列（每舱位至多一条原始航班项）
  const selectedItems = selectFlightsByGreedyCover(GW_data, cwstr, minSeats)

  a2Item[A2_FIELDS.cangwei_arr] = []
  a2Item[A2_FIELDS.date_obj] = {}
  for (const rawItem of selectedItems) {
    // ★ 业务模式重构：舱位级数据不拆套餐（同原逻辑）。
    enrichTaocanFloorPrice(rawItem, floorPriceFormula)

    // 行级行李拼接（主数据体自己的托运行李汇总）
    setTuoYunXingLi(rawItem)

    const findItem = geshihua(rawItem)
    a2Item[A2_FIELDS.cangwei_arr].push(findItem)

    // 按日期分组（只做一次；键为 C出发日期 "YYYY-MM-DD"）
    const date = findItem[JXGJ_RESPONSE_FIELDS.C出发日期]
    if (!a2Item[A2_FIELDS.date_obj][date]) a2Item[A2_FIELDS.date_obj][date] = []
    a2Item[A2_FIELDS.date_obj][date].push(findItem)
  }

  return {
    platform: 'jxgj',
    status: 'success',
    resultCode: '0000',
    resultMsg: '处理成功',
    data: {
      queryId: `JXGJ_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      inputData: a2Item,
      result: rawResponse,
      processedValue: Math.floor(Math.random() * 10000),
      timestamp: new Date().toISOString()
    }
  }
}

/** 平台登录（当前 mock，返回假 token） */
export async function login(credential) {
  const delay = 500 + Math.random() * 1000
  await new Promise(resolve => setTimeout(resolve, delay))
  return { token: `jxgj_token_${Math.random().toString(36).slice(2)}`, expiresIn: 7200 }
}

/** JXGJ 是源数据平台，不产出政策 xlsx */
export const exportTemplate = null

// ===== 内部 helper =====

/**
 * 给舱位级数据自带的套餐信息富化三样数据（供底价检查文件逐套餐展示用）：
 *   1. 套餐价_CNY：该套餐价格换算成 CNY（底价检查文件「成人总票价_CNY」列）
 *   2. 我方底价：该套餐价按用户配置底价公式算出的底价（trip 比价用它算「差值」）
 *   3. _floorMeta：命中公式元数据（底价检查文件「底价公式命中」列，与行级格式一致）
 * 注意：套餐价格缺失的套餐跳过（不兜底赋值），下游匹配不到自然会留空。
 */
function enrichTaocanFloorPrice(findItem, floorPriceFormula) {
  const taocan = findItem.套餐信息
  if (!Array.isArray(taocan) || !floorPriceFormula) return
  for (const acai of taocan) {
    if (!acai || acai.套餐价格 == null) continue
    const cnyPrice = AnyToCny(findItem.H货币种类, acai.套餐价格)
    acai['套餐价格_CNY'] = cnyPrice
    // acai['差值_CNY'] = ''
    const fp = floorPriceFormula(cnyPrice)
    acai['我方底价'] = fp?.floorPrice
    acai._floorMeta = {
      version: fp?.version,
      formulaType: fp?.formulaType,
      formulaStr: fp?.formulaStr,
      rangeHit: fp?.rangeHit,
      cost: fp?.cost
    }
  }
}

/**
 * 拼接舱位级主数据体的托运行李说明字符串（与老"无套餐行"逻辑一致）：
 *   数 行李信息 里「托运」条目的数量与单件重量：
 *     0 件 → 无免费托运行李
 *     1 件 → 成人:20
 *     N 件 → N件，每件20
 * 该字符串供 trip 比价做行级行李匹配用。
 */
function setTuoYunXingLi(findItem) {
  let xingli_num = 0, xingli_kg = 0
  findItem.行李信息?.forEach(acai_x => {
    if (acai_x.类型 == "托运") { xingli_kg = acai_x.重量; xingli_num++ }
  })
  if (xingli_num == 0) findItem[A2_FIELDS.TuoYunXingLi] = '无免费托运行李'
  else if (xingli_num == 1) findItem[A2_FIELDS.TuoYunXingLi] = `成人:${xingli_kg}`
  else findItem[A2_FIELDS.TuoYunXingLi] = `${xingli_num}件，每件${xingli_kg}`
}

/**
 * 航班项资格过滤（与舱位无关的两道门槛）：
 *   1. 座位数 ≥ minSeats（S剩余座位数；有套餐信息时取套餐信息[0].座位数）
 *   2. 出发日期 ≥ 3 天后（按 C出发时间_Date 解析）
 * @returns {string|null} 合格返回 "YYYY-MM-DD" 日期键，不合格返回 null
 */
function eligibleDate(item, minSeats = 3) {
  // 座位数（阈值由锦绣配置页 minSeats 控制，默认 3）
  let ZWS = item.S剩余座位数
  if (item.套餐信息?.length > 0) ZWS = item.套餐信息[0].座位数
  if (ZWS < minSeats) return null
  // 日期≥3天后
  const riqiStr = item[JXGJ_RESPONSE_FIELDS.C出发时间_Date]
  if (!riqiStr) return null
  const riqi = new Date(riqiStr)
  if (isNaN(riqi.getTime())) return null
  riqi.setHours(0, 0, 0, 0)
  const threeDaysLater = new Date()
  threeDaysLater.setHours(0, 0, 0, 0)
  threeDaysLater.setDate(threeDaysLater.getDate() + 3)
  if (riqi < threeDaysLater) return null
  // 日期键与 geshihua() 中 C出发日期 = C出发时间_Date.split(' ')[0] 保持一致
  return riqiStr.split(' ')[0]
}

/**
 * ★ 贪心集合覆盖选航班
 *
 * 目标：为用户舱位串中的每个舱位选一条锦绣航班，使所用的出发日期数最少
 *   —— 每个日期后续会拆成一个携程请求，日期数 = 携程请求数。
 *
 * 建模（加权集合覆盖的贪心近似，多项式时间内覆盖数最优近似）：
 *   - 每个舱位 c 有一个"候选日期集合"（该舱位在 GW_data 中所有合格航班所在的日期）
 *   - 每个日期 d 能覆盖"候选日期含 d"的全部未覆盖舱位
 *   - 每轮选择覆盖未覆盖舱位数最多的日期；平局取日期最早（YYYY-MM-DD 字典序=时间序）
 *   - 提交该日期覆盖的舱位，直到无舱位可覆盖
 *
 * 同一舱位在同一日期有多条合格航班时，取 GW_data 中最先出现的一条（稳定、与原 find() 首条语义一致）
 * 无任何合格航班的舱位自然缺席结果（与原逻辑 find 返回 undefined 跳过一致）
 *
 * @param {Object[]} GW_data  锦绣返回的 Content.List 原始航班数组
 * @param {string[]} cwstr    用户舱位串（已 trim/去空，顺序即输出顺序）
 * @param {number} minSeats   座位数下限
 * @returns {Object[]} 每舱位至多一条的原始航班项数组，顺序与 cwstr 对齐
 */
function selectFlightsByGreedyCover(GW_data, cwstr, minSeats = 3) {
  // 1. 建立每舱位候选：Map<date, rawItem>（同日期取列表首条）
  //    用 Map 索引舱位，后续贪心轮次 O(1) 取用，避免每轮 find
  const candidatesByCw = new Map()
  for (const cw of cwstr) {
    const byDate = new Map()
    for (const item of GW_data) {
      if (item[A3_FIELDS.C舱位] !== cw) continue
      const date = eligibleDate(item, minSeats)
      if (date === null) continue
      if (!byDate.has(date)) byDate.set(date, item)
    }
    candidatesByCw.set(cw, byDate)
  }

  // 2. 贪心：每轮挑覆盖最多未覆盖舱位的日期（平局日期最早）
  const uncovered = new Set(cwstr)
  const selected = new Map() // cw → rawItem
  while (uncovered.size > 0) {
    // date → 本轮可新覆盖的舱位列表
    const dateCovers = new Map()
    for (const cw of uncovered) {
      const byDate = candidatesByCw.get(cw)
      for (const date of byDate.keys()) {
        let cws = dateCovers.get(date)
        if (!cws) { cws = []; dateCovers.set(date, cws) }
        cws.push(cw)
      }
    }
    if (dateCovers.size === 0) break // 剩余舱位均无候选，缺席输出（同原逻辑）

    let bestDate = null
    let bestCws = null
    for (const [date, cws] of dateCovers) {
      if (bestCws === null
        || cws.length > bestCws.length
        || (cws.length === bestCws.length && date < bestDate)) {
        bestDate = date
        bestCws = cws
      }
    }

    // 提交覆盖：每舱位取该日期下的首条航班
    for (const cw of bestCws) {
      selected.set(cw, candidatesByCw.get(cw).get(bestDate))
      uncovered.delete(cw)
    }
  }

  // 3. 按用户舱位串顺序输出
  return cwstr.filter(cw => selected.has(cw)).map(cw => selected.get(cw))
}

export default {
  key, configSchema, defaults,
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate
}
