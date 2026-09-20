// ============================================================
// ERC Service - 汇率与国家列表数据获取
// 职责：从外部 API 拉取汇率和国家信息，供 controller 调用
//
// 数据源：
//   - exchangerate  : exchangerate-api.com（唯一汇率源，USD 锚定）
//   - restcountries : 币种富信息源（中文名、国旗图标、币种代码/符号）
//
// 统一输出结构（与 exchangerate-api 原生结构对齐）：
//   { result: 'success', provider, conversion_rates: { CODE: rate }, time_last_update_unix }
//   - conversion_rates 语义恒为「1 USD 兑 X 个该币种」，USD 自身恒为 1
//
// 说明：地址与 key 在 ERC 设置页配置，持久化于 userData/config/ercConfig.json，
//       缺省时使用 configManager 内置默认值
// ============================================================

import { getErcConfig } from './configManager.js'

// 汇率源标识（渲染层 rateProvider / IPC 参数共用）
export const RATE_PROVIDERS = ['exchangerate']
export const DEFAULT_RATE_PROVIDER = 'exchangerate'

/**
 * 带超时的 GET JSON 请求
 * @param {string} url
 * @param {object} opts { timeoutMs, headers }
 */
async function getJson(url, { timeoutMs = 5000, headers } = {}) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, headers })
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 适配者：exchangerate-api（唯一汇率源）
 * 原生结构即 { result, conversion_rates, time_last_update_unix }，补 provider 字段即可
 * 地址由配置拼装：${baseUrl}/${key}/latest/USD
 */
async function fetchExchangeRateIO() {
  const { baseUrl, key } = getErcConfig().providers.exchangerate
  const url = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(key)}/latest/USD`
  const res = await getJson(url)
  if (!res || res.result !== 'success' || !res.conversion_rates) {
    throw new Error('exchangerate-api 返回异常')
  }
  return { ...res, provider: 'exchangerate' }
}

/**
 * 拉取最新汇率（以 USD 为锚定）
 * provider 参数保留兼容性但唯一源为 exchangerate
 * 返回 { result, provider, conversion_rates, time_last_update_unix }
 */
export async function fetchExchangeRate(provider = DEFAULT_RATE_PROVIDER) {
  return fetchExchangeRateIO()
}

// 三页查询：每页 100 条，offset 0/100/200，共约 300 个国家
// response_fields 只取前端需要的字段，减少传输体积
const RESTCOUNTRIES_FIELDS = 'names.common,names.official,names.translations,codes.alpha_2,codes.alpha_3,flag.url_png,timezones,currencies,links.official,links.wikipedia'

/**
 * 拉取全部国家信息（3 页并发合并 + 结构化映射）
 * 地址与 key 从配置读取（币种富信息源），15 秒超时
 * 返回 [{ name, officialName, alpha2Code, alpha3Code, flagUrlPng, timezones, currencies, translations, wikiLink, officialLink }]
 */
export async function fetchCountries() {
  const { baseUrl, key } = getErcConfig().providers.restcountries
  const base = baseUrl.replace(/\/+$/, '')
  const urls = [0, 100, 200].map(offset =>
    `${base}?limit=100&offset=${offset}&requestedFromWeb=1&pretty&response_fields=${RESTCOUNTRIES_FIELDS}`
  )
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    // 三页并发请求（共用一个 AbortController，任一超时则全部中止）
    const responses = await Promise.all(
      urls.map(url =>
        fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${key}` }
        })
      )
    )
    // 依次读取 JSON 并合并到 data
    const data = []
    for (const res of responses) {
      const json = await res.json()
      data.push(...json.data.objects)
    }
    // 结构化映射：只保留前端需要的字段，currencies 补全 rate/value/initiative 供 store 使用
    return data.map(item => ({
      name: item.names?.common ?? '',
      officialName: item.names?.official ?? '',
      alpha2Code: item.codes?.alpha_2 ?? '',
      alpha3Code: item.codes?.alpha_3 ?? '',
      flagUrlPng: item.flag?.url_png ?? '',
      timezones: item.timezones ?? [],
      currencies: {
        code: item.currencies[0]?.code ?? '',
        name: item.currencies[0]?.name ?? '',
        symbol: item.currencies[0]?.symbol ?? '',
        rate: 0,
        value: 0,
        initiative: false
      },
      translations: item.names?.translations.zho ?? {},
      wikiLink: item.links?.wikipedia ?? '',
      officialLink: item.links?.official ?? ''
    }))
  } finally {
    clearTimeout(timeoutId)
  }
}
