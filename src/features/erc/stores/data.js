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
  // 汇率数据源标识（唯一源 exchangerate），持久化
  const rateProvider = ref('exchangerate')
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
  // 国家列表加载失败标记：API 失败时置 true，驱动 Home/FloatingHome 显示醒目错误提示
  //   false 表示成功或尚未尝试；用户重试时由 action 内部置回 false
  const loadError = ref(false)
  // 预留字段
  const duo = ref([])

  // ==================== 派生状态 ====================
  // 主动币种：参与换算中标记为 initiative 的那个（用户点击某币种设为主动）
  const initiativeCurrency = computed(() =>
    activeCurrency.value.filter(item => item.currencies.initiative)[0]
  )

  // ==================== 数据加载 ====================
  // 加载全部国家信息，并按币种 code 去重生成 currencies_list
  // 失败时置 loadError=true（不返回兜底数据），由 UI 显示醒目错误提示
  //
  // activeCurrency 引用重定向：
  //   - localStorage 持久化的 activeCurrency 项是上次会话的旧对象（值快照），
  //     与本次拉取的 fresh currencies_list 中的对象不是同一引用
  //   - 若不重定向，applyRateUpdate 走 currencies_list 更新 rate 时不会触及
  //     activeCurrency 中的旧项 → syncPassiveValues 用旧 rate 算 → 数值过期
  //   - 重定向：按 code 匹配 fresh 项，把用户状态（value、initiative）和已知
  //     rate 搬到 fresh，然后把 activeCurrency 的对应项替换为 fresh 引用
  //   - 找不到匹配（API 已下架该币种）的旧项被剔除
  //   - rate 也搬过去：若今日已同步（today==syncDate）会跳过 updata_exchangeRates，
  //     此时 fresh 项的 rate 是 0，搬旧 rate 进来保证当日重开也能算
  async function load_all_countries_list() {
    loadError.value = false
    try {
      all_countries_list.value = await api.erc.getCountriesList()
      const seen = new Set()
      currencies_list.value = all_countries_list.value.filter(item => {
        const code = item.currencies.code
        if (!code || seen.has(code)) return false
        seen.add(code)
        return true
      })
      rehydrateActiveCurrency()
    } catch (error) {
      console.error('加载国家列表失败:', error)
      loadError.value = true
    }
  }

  // 把持久化的旧 activeCurrency 项替换为 fresh currencies_list 中的同 code 引用
  //   保留：value（用户输入金额）、initiative（主动标记）、rate（已知汇率）
  //   丢弃：旧 name/flag/translations 等结构字段（用 fresh 的）
  function rehydrateActiveCurrency() {
    if (activeCurrency.value.length === 0) return
    const codeMap = new Map()
    for (const item of currencies_list.value) {
      const code = item.currencies?.code
      if (code) codeMap.set(code.toUpperCase(), item)
    }
    const next = []
    for (const stale of activeCurrency.value) {
      const code = stale.currencies?.code
      if (!code) continue
      const fresh = codeMap.get(code.toUpperCase())
      if (!fresh) continue
      fresh.currencies.value = stale.currencies?.value ?? 0
      fresh.currencies.initiative = !!stale.currencies?.initiative
      if (stale.currencies?.rate) fresh.currencies.rate = stale.currencies.rate
      next.push(fresh)
    }
    activeCurrency.value = next
  }

  // 更新汇率：按当前数据源（rateProvider）用 USD 锚定汇率刷新各币种 rate
  // 失败时只打印错误日志，不弹 UI（避免网络抖动打断用户操作）；
  // 用户重试可在 ERC 设置页点「测试连接」看具体错误
  async function updata_exchangeRates() {
    try {
      const res = await api.erc.getExchangeRate(rateProvider.value)
      applyRateUpdate(res)
    } catch (error) {
      console.error('[ERC] 汇率更新失败:', error)
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
    syncDate, lastUpdateTime, nationalDetails, loading, loadError, duo,
    // getters
    initiativeCurrency,
    // actions
    load_all_countries_list, updata_exchangeRates, changeRateProvider, handleRateBroadcast,
    applyRateUpdate, updataActiveCurrency, removeCurrency,
    syncPassiveValues, seedDefaultCurrencies
  }
}, {
  // 持久化：仅持久化用户配置字段，不缓存外部 API 数据（currencies_list/all_countries_list）
  //   - 国家列表由主进程 fetchCountriesWithCache 管理（userData/cache/countries.json），
  //     渲染层每次冷启动从主进程拉，避免 localStorage 旧版本残留数据导致搜索失效
  //   - 汇率（rate/value/initiative）嵌在 currencies_list 里随之上行刷新，不进 localStorage
  //   - activeCurrency 会持久化，但 load_all_countries_list 末尾调 rehydrateActiveCurrency
  //     把旧引用替换为 fresh currencies_list 中的同 code 引用，保证后续 applyRateUpdate
  //     走 currencies_list 时能同步更新 activeCurrency 中的项
  // key 保留 erc-data-v3：pick 限定的字段集与旧版兼容，旧 localStorage 中已废弃字段
  //   会被自动忽略（pinia-persistedstate v4 反序列化时只读 pick 中的项）
  persist: {
    key: 'erc-data-v3',
    pick: ['activeCurrency', 'rateProvider', 'syncDate', 'lastUpdateTime']
  }
})
