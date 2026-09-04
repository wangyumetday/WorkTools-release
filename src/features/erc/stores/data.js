// ============================================================
// ERC 渲染层 store - 汇率与币种状态管理
// 职责：
//   - 维护全部国家列表（all_countries_list）与去重后的币种列表（currencies_list）
//   - 维护参与换算的币种（activeCurrency）与锚定货币（AnchorCurrency=USD）
//   - 维护汇率同步日期（syncDate）和加载态（loading）
//   - 派生 getter：initiativeCurrency（主动币种）/ BASE_VALUE（基准货币值）
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
  // 参与换算的币种列表（用户从全部币种里点选加入）
  const activeCurrency = ref([])
  // 全部国家信息（原始数据，含重复币种）
  const all_countries_list = ref([])
  // 去重后的币种列表（按 currencies.code 去重）
  const currencies_list = ref([])
  // 汇率最后同步日期（YYYY-MM-DD），用于判断是否需要刷新
  const syncDate = ref('0000-00-00')
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

  // 基准货币值 = 主动币种的 value / rate
  // 被动币种通过 rate * BASE_VALUE 同步换算
  const BASE_VALUE = computed(() => {
    const ic = initiativeCurrency.value
    if (!ic) return 0
    return ic.currencies.value / ic.currencies.rate
  })

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

  // 更新汇率：用 USD 锚定汇率刷新 currencies_list 各币种 rate
  async function updata_exchangeRates() {
    try {
      const res = await api.erc.getExchangeRate()
      applyRateUpdate(res)
    } catch (error) {
      // 静默失败（原逻辑如此，避免网络抖动打断用户操作）
    }
  }

  // 应用一次汇率更新（主进程定时刷新推送 / 渲染层主动拉取共用同一逻辑）
  // 参数 res 为 fetchExchangeRate 返回的结构：{ result, conversion_rates, time_last_update_unix }
  function applyRateUpdate(res) {
    if (!res || !res.conversion_rates) return
    currencies_list.value.map(item => {
      if (res.conversion_rates[item.currencies.code] != undefined) {
        item.currencies.rate = res.conversion_rates[item.currencies.code]
      }
    })
    if (res.time_last_update_unix) {
      syncDate.value = new Date(res.time_last_update_unix * 1000).toISOString().slice(0, 10)
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
  // 内部存全精度 Number，展示层由组件自行四舍五入到 4 位小数
  function syncPassiveValues() {
    const ic = initiativeCurrency.value
    if (!ic) return
    const rate = ic.currencies.rate
    if (!rate) return
    // base = 主动币种值 / 其 rate = USD 等价额
    const base = ic.currencies.value / rate
    activeCurrency.value.forEach(item => {
      if (item.currencies.initiative) return
      const r = item.currencies.rate
      if (!r) return
      try {
        // 被动币种值 = r × base = 值 × (R被动 / R主)
        item.currencies.value = new Decimal(r).times(base).toNumber()
      } catch (e) {
        // 静默跳过
      }
    })
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
    AnchorCurrency, activeCurrency, all_countries_list, currencies_list,
    syncDate, nationalDetails, loading, duo,
    // getters
    initiativeCurrency, BASE_VALUE,
    // actions
    load_all_countries_list, updata_exchangeRates, applyRateUpdate, updataActiveCurrency, removeCurrency,
    syncPassiveValues, seedDefaultCurrencies
  }
}, {
  // 持久化：汇率和币种列表写入 localStorage，避免每次启动都重新拉接口
  persist: true
})
