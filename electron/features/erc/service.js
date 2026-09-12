// ============================================================
// ERC Service - 汇率与国家列表数据获取
// 职责：从外部 API 拉取汇率和国家信息，供 controller 调用
//
// 汇率数据源（均为 USD 锚定，适配者统一归一化后下游零感知）：
//   - exchangerate  : exchangerate-api.com（默认源）
//   - allratestoday : allratestoday.com
//   - restcountries.com：全部国家信息（含币种代码、国旗、时区）
//
// 统一输出结构（与 exchangerate-api 原生结构对齐）：
//   { result: 'success', provider, conversion_rates: { CODE: rate }, time_last_update_unix }
//   - conversion_rates 语义恒为「1 USD 兑 X 个该币种」，USD 自身恒为 1
//
// 说明：地址与 key 在 ERC 设置页配置，持久化于 userData/config/ercConfig.json，
//       缺省时使用 configManager 内置默认值
// ============================================================

import { getErcConfig } from './configManager.js'

// 支持的汇率源标识（渲染层 rateProvider / IPC 参数共用此枚举）
export const RATE_PROVIDERS = ['exchangerate', 'allratestoday']
export const DEFAULT_RATE_PROVIDER = 'allratestoday'

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
 * 适配者：exchangerate-api
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
 * 适配者：allratestoday
 * 原生结构为数组 [{ rate, source, target, time }]，归一化为统一结构：
 *   - 数组拍平为 conversion_rates 映射表
 *   - feed 不含锚币种自身，显式补 USD: 1
 *   - ISO 时间（如 2026-09-12T02:07:23+0000）转 unix 秒
 * 地址（含 source=USD）与 key（Bearer 请求头）均来自配置
 */
async function fetchAllRatesToday() {
  const { baseUrl, key } = getErcConfig().providers.allratestoday
  const arr = await getJson(baseUrl, {
    timeoutMs: 8000,
    headers: { Authorization: `Bearer ${key}` }
  })
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('allratestoday 返回异常：空数据')
  }
  const conversion_rates = { USD: 1 }
  let timeMs = 0
  for (const item of arr) {
    if (!item || !item.target || typeof item.rate !== 'number') continue
    conversion_rates[item.target] = item.rate
    if (!timeMs && item.time) {
      const ms = Date.parse(item.time)
      if (!Number.isNaN(ms)) timeMs = ms
    }
  }
  return {
    result: 'success',
    provider: 'allratestoday',
    conversion_rates,
    time_last_update_unix: timeMs ? Math.floor(timeMs / 1000) : 0
  }
}

/**
 * 拉取最新汇率（以 USD 为锚定）
 * @param {string} [provider] 数据源标识，非法值回落默认源
 * 返回 { result, provider, conversion_rates, time_last_update_unix }
 */
export async function fetchExchangeRate(provider = DEFAULT_RATE_PROVIDER) {
  if (provider === 'allratestoday') return fetchAllRatesToday()
  return fetchExchangeRateIO()
}

// restcountries 密钥
const RESTCOUNTRIES_KEY = 'rc_live_14364ff234dc406a9d0c338758f5a5cd'
// 三页查询：每页 100 条，offset 0/100/200，共约 300 个国家
// response_fields 只取前端需要的字段，减少传输体积
const RESTCOUNTRIES_URLS = [
  'https://api.restcountries.com/countries/v5?limit=100&requestedFromWeb=1&pretty&response_fields=names.common,names.official,names.translations,codes.alpha_2,codes.alpha_3,flag.url_png,timezones,currencies,links.official,links.wikipedia',
  'https://api.restcountries.com/countries/v5?limit=100&offset=100&requestedFromWeb=1&pretty&response_fields=names.common,names.official,names.translations,codes.alpha_2,codes.alpha_3,flag.url_png,timezones,currencies,links.official,links.wikipedia',
  'https://api.restcountries.com/countries/v5?limit=100&offset=200&requestedFromWeb=1&pretty&response_fields=names.common,names.official,names.translations,codes.alpha_2,codes.alpha_3,flag.url_png,timezones,currencies,links.official,links.wikipedia'
]

/**
 * 拉取全部国家信息（3 页并发合并 + 结构化映射）
 * 15 秒超时，返回 [{ name, officialName, alpha2Code, alpha3Code, flagUrlPng, timezones, currencies, translations, wikiLink, officialLink }]
 */
export async function fetchCountries() {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    // 三页并发请求（共用一个 AbortController，任一超时则全部中止）
    const responses = await Promise.all(
      RESTCOUNTRIES_URLS.map(url =>
        fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${RESTCOUNTRIES_KEY}` }
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
