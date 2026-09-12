// ============================================================
// ERC 渲染层 store - 汇率与币种状态管理
// 职责：
//   - 维护全部国家列表（all_countries_list）与去重后的币种列表（currencies_list）
//   - 维护参与换算的币种（activeCurrency）与锚定货币（AnchorCurrency=USD）
//   - 维护汇率同步日期（syncDate）和加载态（loading）
//   - 提供数据加载与币种增删 action
//
// 与主进程交互：所有 IPC 通过 @/shared/api.js 调用，方法名前缀 erc.
// 持久化：persist:true 把 state 写入 localStorage，避免每次启动重新拉接口
// ============================================================

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import Decimal from 'decimal.js'
import api from '@/shared/api.js'

export const useDataStore = defineStore('erc-data', () => {
  // ==================== 币种与汇率数据 ====================
  // 锚定货币（汇率以 USD 为基准拉取）
  const AnchorCurrency = ref('USD')
  // 汇率数据源标识（exchangerate / allratestoday），持久化，默认 allratestoday
  const rateProvider = ref('allratestoday')
  // 参与换算的币种列表（用户从全部币种里点选加入）
  const activeCurrency = ref([])
  // 全部国家信息（原始数据，含重复币种）
  const all_countries_list = ref([])
  // 去重后的币种列表（按 currencies.code 去重）
  const currencies_list = ref([])
  // 汇率最后同步日期（YYYY-MM-DD），用于判断是否需要刷新
  const syncDate = ref('0000-00-00')
  // 汇率最后同步时间（ISO 字符串，含时分秒），用于界面展示上次更新时间
  const lastUpdateTime = ref('')
  // 国家详情数据（预留）
  const nationalDetails = ref([])
  // 是否正在拉取数据（驱动 loading modal）
  const loading = ref(false)
  // 预留字段
  const duo = ref([])

  // ==================== 派生状态 ====================
  // 主动币种：参与换算中标记为 initiative 的那个（用户点击某币种设为主动）
  const initiativeCurrency = computed(() =>
    activeCurrency.value.filter(item => item.currencies.initiative)[0]
  )

  // ==================== 数据加载 ====================
  // 加载全部国家信息，并按币种 code 去重生成 currencies_list
  async function load_all_countries_list() {
    try {
      all_countries_list.value = await api.erc.getCountriesList()
      const seen = new Set()
      currencies_list.value = all_countries_list.value.filter(item => {
        const code = item.currencies.code
        if (!code || seen.has(code)) return false
        seen.add(code)
        return true
      })
    } catch (error) {
      console.error('加载国家列表失败:', error)
    }
  }

  // 更新汇率：按当前数据源（rateProvider）用 USD 锚定汇率刷新各币种 rate
  async function updata_exchangeRates() {
    try {
      const res = await api.erc.getExchangeRate(rateProvider.value)
      applyRateUpdate(res)
    } catch (error) {
      // 静默失败（原逻辑如此，避免网络抖动打断用户操作）
    }
  }

  // 切换汇率数据源：先拉新源，成功才提交（失败保留旧源，不做兜底）
  // 成功同时把选择同步给主进程调度器（getRate 内部记忆），后续广播用新源
  async function changeRateProvider(provider) {
    if (!provider || provider === rateProvider.value) return
    const res = await api.erc.getExchangeRate(provider)
    if (!res || res.result !== 'success' || !res.conversion_rates) {
      throw new Error('新数据源返回异常')
    }
    rateProvider.value = provider
    applyRateUpdate(res)
  }

  // 主进程定时广播的统一入口（Home / FloatingHome 共用）
  // 广播源与当前选择一致 → 应用；不一致（典型：主进程重启后回落默认源）
  //   → 丢弃该包，改为按本窗口持久化的源主动拉一次，自我纠正
  function handleRateBroadcast(res) {
    if (!res) return
    if (res.provider && res.provider !== rateProvider.value) {
      updata_exchangeRates()
      return
    }
    applyRateUpdate(res)
  }

  // 应用一次汇率更新（主进程定时刷新推送 / 渲染层主动拉取共用同一逻辑）
  // 参数 res 为 fetchExchangeRate 返回的结构：{ result, provider, conversion_rates, time_last_update_unix }
  function applyRateUpdate(res) {
    if (!res || !res.conversion_rates) return
    currencies_list.value.map(item => {
      if (res.conversion_rates[item.currencies.code] != undefined) {
        item.currencies.rate = res.conversion_rates[item.currencies.code]
      }
    })
    if (res.time_last_update_unix) {
      const d = new Date(res.time_last_update_unix * 1000)
      syncDate.value = d.toISOString().slice(0, 10)
      lastUpdateTime.value = d.toISOString()
    }
    // 汇率更新后联动重算被动币种，确保显示同步
    syncPassiveValues()
  }

  // ==================== 币种增删 ====================
  // 切换币种参与换算状态（已存在则移除，不存在则加入）
  function updataActiveCurrency(cur) {
    const index = activeCurrency.value.indexOf(cur)
    if (index === -1) {
      // 加入空列表时，首币种升为主动，保证有锚点
      if (activeCurrency.value.length === 0) {
        cur.currencies.initiative = true
      }
      activeCurrency.value.push(cur)
      syncPassiveValues()
    } else {
      removeCurrency(cur)
    }
  }

  // 从参与换算中移除币种
  function removeCurrency(currency) {
    const index = activeCurrency.value.indexOf(currency)
    if (index === -1) return
    const wasInitiative = currency.currencies.initiative
    activeCurrency.value.splice(index, 1)
    // 移除的若是主动币种，把首个剩余升为主动并重算
    if (wasInitiative && activeCurrency.value.length > 0) {
      activeCurrency.value[0].currencies.initiative = true
      syncPassiveValues()
    }
  }

  // ==================== 同步换算 ====================
  // 以当前主动币种为锚点，重算所有被动币种值（交叉汇率经 USD）
  // 精度：全程 decimal.js（除法也走 Decimal，杜绝 JS 浮点误差），
  //   内部存 toNumber() 全精度 Number，展示层由组件统一四舍五入到 2 位小数
  function syncPassiveValues() {
    const ic = initiativeCurrency.value
    if (!ic) return
    const rate = ic.currencies.rate
    if (!rate) return
    try {
      // base = 主动币种值 / 其 rate = USD 等价额（Decimal 除法，全精度）
      const base = new Decimal(ic.currencies.value).div(rate)
      activeCurrency.value.forEach(item => {
        if (item.currencies.initiative) return
        const r = item.currencies.rate
        if (!r) return
        // 被动币种值 = r × base = 值 × (R被动 / R主)
        item.currencies.value = new Decimal(r).times(base).toNumber()
      })
    } catch (e) {
      // 静默跳过
    }
  }

  // 首次加载种入默认币种：CNY(主动,值=100) + USD，并联动算一次
  // 仅在 activeCurrency 为空时执行；缺数据则不种（无兜底）
  function seedDefaultCurrencies() {
    if (activeCurrency.value.length > 0) return
    const cny = currencies_list.value.find(
      i => i.currencies.code.toUpperCase() === 'CNY'
    )
    const usd = currencies_list.value.find(
      i => i.currencies.code.toUpperCase() === 'USD'
    )
    if (!cny || !usd) return
    cny.currencies.initiative = true
    cny.currencies.value = 100
    usd.currencies.initiative = false
    usd.currencies.value = 0
    activeCurrency.value.push(cny, usd)
    syncPassiveValues()
  }

  return {
    // state
    AnchorCurrency, rateProvider, activeCurrency, all_countries_list, currencies_list,
    syncDate, lastUpdateTime, nationalDetails, loading, duo,
    // getters
    initiativeCurrency,
    // actions
    load_all_countries_list, updata_exchangeRates, changeRateProvider, handleRateBroadcast,
    applyRateUpdate, updataActiveCurrency, removeCurrency,
    syncPassiveValues, seedDefaultCurrencies
  }
}, {
  // 持久化：汇率和币种列表写入 localStorage，避免每次启动都重新拉接口
  // key 带版本号：v2 默认汇率源改为 allratestoday，旧版（v1/erc-data）缓存不再复用，
  // 首次启动按常规流程重新拉国家列表与汇率（无兜底数据）
  persist: {
    key: 'erc-data-v2'
  }
})
