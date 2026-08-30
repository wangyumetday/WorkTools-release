// ============================================================
// JXGJ（锦绣国际）平台 adapter
// 数据源接口：spider.xxklf.com/taskresult/api/TaskResult/GetList
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

  a2Item[A2_FIELDS.cangwei_arr] = []
  for (const cw_item of cwstr) {
    const findItem = GW_data.find(item => findItemByCwItem(item, cw_item))

    if (findItem) {
      // ★ 业务模式重构：舱位级数据不拆套餐。
      //   舱位级主数据体本身也是一种"套餐"（JGJ 返回里 A 舱一行 = A 舱的整舱报价），
      //   它外层携带有 套餐信息[套餐1,套餐2...]（舱位/舱等/座位数/套餐价格/行李信息）。
      //   我们把每个内部套餐的"我方底价"算出来挂回套餐项，整行一起流向下游：
      //   trip 比价时给每个套餐富化「携程底价 / 差值」，导入政策文件只用舱位级主数据（不使用套餐信息）。
      enrichTaocanFloorPrice(findItem, floorPriceFormula)

      // 行级行李拼接（主数据体自己的托运行李汇总）
      setTuoYunXingLi(findItem)
      a2Item[A2_FIELDS.cangwei_arr].push(geshihua(findItem))
    }

    // 按日期分组
    a2Item[A2_FIELDS.date_obj] = {}
    a2Item[A2_FIELDS.cangwei_arr].forEach(item => {
      const date = item[JXGJ_RESPONSE_FIELDS.C出发日期]
      if (!a2Item[A2_FIELDS.date_obj][date]) a2Item[A2_FIELDS.date_obj][date] = []
      a2Item[A2_FIELDS.date_obj][date].push(item)
    })
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
 * 在 List 中按舱位查询项（含座位数≥3、日期≥3天后两道过滤）
 * 注意：此处精确匹配 C舱位，舱位大类 vs 子舱 的匹配策略待统一方案（问题3）
 */
function findItemByCwItem(item, cw_item) {
  if (item[A3_FIELDS.C舱位] !== cw_item) return false
  // 座位数
  let ZWS = item.S剩余座位数
  if (item.套餐信息?.length > 0) ZWS = item.套餐信息[0].座位数
  if (ZWS < 3) return false
  // 日期≥3天后
  const riqiStr = item[JXGJ_RESPONSE_FIELDS.C出发时间_Date]
  if (!riqiStr) return false
  const riqi = new Date(riqiStr)
  if (isNaN(riqi.getTime())) return false
  riqi.setHours(0, 0, 0, 0)
  const threeDaysLater = new Date()
  threeDaysLater.setHours(0, 0, 0, 0)
  threeDaysLater.setDate(threeDaysLater.getDate() + 3)
  return riqi >= threeDaysLater
}

export default {
  key, configSchema, defaults,
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate
}
