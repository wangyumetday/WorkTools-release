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
      currencies_list.value.map(item => {
        if (res.conversion_rates[item.currencies.code] != undefined) {
          item.currencies.rate = res.conversion_rates[item.currencies.code]
        }
      })
      const resDate = new Date(res.time_last_update_unix * 1000).toISOString().slice(0, 10)
      syncDate.value = resDate
    } catch (error) {
      // 静默失败（原逻辑如此，避免网络抖动打断用户操作）
    }
  }

  // ==================== 币种增删 ====================
  // 切换币种参与换算状态（已存在则移除，不存在则加入）
  function updataActiveCurrency(cur) {
    const index = activeCurrency.value.indexOf(cur)
    if (index === -1) {
      activeCurrency.value.push(cur)
    } else {
      activeCurrency.value.splice(index, 1)
    }
  }

  // 从参与换算中移除币种
  function removeCurrency(currency) {
    const index = activeCurrency.value.indexOf(currency)
    if (index !== -1) {
      activeCurrency.value.splice(index, 1)
    }
  }

  return {
    // state
    AnchorCurrency, activeCurrency, all_countries_list, currencies_list,
    syncDate, nationalDetails, loading, duo,
    // getters
    initiativeCurrency, BASE_VALUE,
    // actions
    load_all_countries_list, updata_exchangeRates, updataActiveCurrency, removeCurrency
  }
}, {
  // 持久化：汇率和币种列表写入 localStorage，避免每次启动都重新拉接口
  persist: true
})
