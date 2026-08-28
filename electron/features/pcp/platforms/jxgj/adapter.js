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
      if (findItem.套餐信息?.length > 0) {
        // 拆套餐
        const TaoCanArr = []
        findItem.套餐信息.forEach(acai => {
          let xingli_num = 0, xingli_kg = 0
          acai.行李信息?.forEach(acai_x => {
            if (acai_x.类型 == "托运") { xingli_kg = acai_x.重量; xingli_num++ }
          })

          let temp = structuredClone(findItem)
          temp.套餐信息 = []
          temp.行李信息 = []
          temp.C成人总票价_CNY = AnyToCny(temp.H货币种类, acai.套餐价格)
          temp.C舱位 = acai.舱位
          temp.舱等 = acai.舱等
          temp.S剩余座位数 = acai.座位数
          if (xingli_num == 0) temp.TuoYunXingLi = '无免费托运行李'
          else if (xingli_num == 1) temp.TuoYunXingLi = `成人:${xingli_kg}`
          else temp.TuoYunXingLi = `${xingli_num}件，每件${xingli_kg}`
          TaoCanArr.push(temp)
        })

        if (TaoCanArr.length > 0) {
          TaoCanArr.forEach(tca => a2Item[A2_FIELDS.cangwei_arr].push(geshihua(tca)))
        } else {
          a2Item[A2_FIELDS.cangwei_arr].push(geshihua(findItem))
        }
      } else {
        // 无套餐
        let xingli_num = 0, xingli_kg = 0
        findItem.行李信息?.forEach(acai_x => {
          if (acai_x.类型 == "托运") { xingli_kg = acai_x.重量; xingli_num++ }
        })
        if (xingli_num == 0) findItem.TuoYunXingLi = '无免费托运行李'
        else if (xingli_num == 1) findItem.TuoYunXingLi = `成人:${xingli_kg}`
        else findItem.TuoYunXingLi = `${xingli_num}件，每件${xingli_kg}`
        a2Item[A2_FIELDS.cangwei_arr].push(geshihua(findItem))
      }
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
