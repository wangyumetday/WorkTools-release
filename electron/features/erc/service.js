// ============================================================
// ERC Service - 汇率与国家列表数据获取
// 职责：从外部 API 拉取汇率和国家信息，供 controller 调用
//
// 数据源：
//   - exchangerate-api.com：以 USD 为锚的最新汇率
//   - restcountries.com：全部国家信息（含币种代码、国旗、时区）
//
// 说明：API 密钥硬编码在源码中（本地工具，无后端，密钥随发布包暴露可接受）
// ============================================================

// exchangerate-api 密钥与地址（USD 锚定汇率）
const ExchangeRate_KEY = '966d147f84377b39f732f221'
const ExchangeRate_URL = `https://v6.exchangerate-api.com/v6/${ExchangeRate_KEY}/latest/USD`

/**
 * 拉取最新汇率（以 USD 为锚定）
 * 5 秒超时，返回 { result, conversion_rates, time_last_update_unix, ... }
 */
export async function fetchExchangeRate() {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(ExchangeRate_URL, { method: 'GET', signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`)
    }
    return res.json()
  } finally {
    clearTimeout(timeoutId)
  }
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
