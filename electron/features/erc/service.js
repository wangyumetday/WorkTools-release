// ERC Service - 汇率与国家列表数据获取
// 职责：从外部 API 拉取汇率和国家信息，供 controller 调用
//
// 数据源：
//   - xxklf        : 锦绣国际汇率接口（默认源，CNY 基准，无需 Key）
//   - exchangerate : exchangerate-api.com（USD 锚定，需 Key）
//   - restcountries : 币种富信息源（中文名、国旗图标、币种代码/符号）
//
// 统一输出结构（与 exchangerate-api 原生结构对齐）：
//   { result: 'success', provider, conversion_rates: { CODE: rate }, time_last_update_unix }
//   - conversion_rates 语义恒为「1 USD 兑 X 个该币种」，USD 自身恒为 1
//   - xxklf 源返回「1 单位外币 = X CNY」的 CNY 基准表，由适配者换算成统一语义
//
// 国家列表本地缓存：
//   - 文件路径：userData/cache/countries.json
//   - 结构：{ schemaVersion: 1, updatedAt: ISO, data: [...] }
//   - 由 fetchCountriesWithCache(maxAgeMs) 透明管理：未过期读本地，过期调 API + 写文件
//   - API 失败时抛错（不返回旧数据兜底），由渲染层显示醒目错误提示
//
// 说明：地址与 key 在 ERC 设置页配置，持久化于 userData/config/ercConfig.json，
//       缺省时使用 configManager 内置默认值

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { app } from 'electron'
import { getErcConfig } from './configManager.js'

// 汇率源标识（渲染层 rateProvider / IPC 参数共用）
//   xxklf：锦绣国际汇率接口（默认源，CNY 基准，无需 Key）
export const RATE_PROVIDERS = ['xxklf', 'exchangerate']
export const DEFAULT_RATE_PROVIDER = 'xxklf'

// 国家列表本地缓存的 schema 版本：字段结构升级时递增，旧版缓存自动失效重拉
const COUNTRIES_CACHE_SCHEMA = 1

// 自定义 Agent：启用 keep-alive 但把空闲超时设得比 Cloudflare 短（30s），
//   避免 keep-alive race condition（服务器关空闲连接时客户端正好发请求 → RST）
//   Cloudflare 默认空闲连接 60 秒关闭，我们 30 秒主动断，永远在服务器之前
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 4,           // 串行 + 少量并发足够，避免触发 Cloudflare 边缘限流
  maxFreeSockets: 2,
  timeout: 30000           // 空闲 socket 30 秒后主动关
})

/**
 * 用 Node.js https 模块的 GET JSON 请求（带 retry）
 *
 * 为什么不用全局 fetch（undici）：
 *   undici fetch 跟 Cloudflare（api.restcountries.com 的 CDN）不兼容，TCP 连接
 *   阶段超时（UND_ERR_CONNECT_TIMEOUT），实测 10 秒后失败；而 https 模块 1-3 秒
 *   返回 200。原因是 undici 的 TLS 指纹/HTTP/2 ALPN 协商被部分 Cloudflare 节点
 *   reject（Node.js issue #41680 / undici #2611）。
 *
 * ECONNRESET retry：
 *   ECONNRESET 是 HTTP keep-alive 的固有 race condition——服务器关闭空闲连接时
 *   客户端正好发请求，服务器回 RST。标准修复是 retry（见 Node.js 官方推荐）。
 *   重试 3 次，每次间隔 1 秒（线性 backoff，不指数，避免用户等太久）。
 *
 * @param {string} url
 * @param {object} opts { timeoutMs, headers, retries }
 */
function getJson(url, { timeoutMs = 15000, headers = {}, retries = 3 } = {}) {
  let attempt = 0
  const tryOnce = () => new Promise((resolve, reject) => {
    const lib = url.startsWith('https://') ? https : http
    const req = lib.get(url, { headers, agent: keepAliveAgent }, res => {
      // 3xx 重定向：跟随一次（restcountries 有时会 302）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        getJson(res.headers.location, { timeoutMs, headers, retries }).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP error! status: ${res.statusCode}`))
        return
      }
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`))
        }
      })
    })
    req.on('error', err => {
      // ECONNRESET / ECONNREFUSED / ETIMEDOUT 重试，其他直接 reject
      const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']
      if (retryable.includes(err.code) && attempt < retries) {
        attempt++
        console.log(`[ERC service] ${err.code} on ${url.slice(0, 80)}..., retry ${attempt}/${retries}`)
        setTimeout(() => tryOnce().then(resolve, reject), 1000)
        return
      }
      reject(err)
    })
    // 连接/响应超时：超时后销毁请求，触发 'error' 事件
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`))
    })
  })
  return tryOnce()
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
 * 适配者：锦绣国际汇率接口（默认源，CNY 基准，无需 Key）
 * 原生结构 { Content: { 币种码: 1单位外币=X CNY }, Status: 1, Msg: 'OK' }，CNY 恒为 1
 * 换算成统一语义（1 USD = X 该币种）：
 *   1 USD = Content[USD] CNY → 1 USD = Content[USD] / Content[code] 个 code
 * 只保留标准三字币种码（Content 混有 CNY_LJ / USD_NS 等分渠道变体码，剔除）；
 * 接口不带更新时间，time_last_update_unix 用本次拉取时间近似
 */
async function fetchExchangeRateXXKLF() {
  const { baseUrl } = getErcConfig().providers.xxklf
  const url = baseUrl.replace(/\/+$/, '')
  const res = await getJson(url)
  if (!res || res.Status !== 1 || !res.Content || typeof res.Content !== 'object') {
    throw new Error('锦绣国际汇率接口返回异常')
  }
  const usdToCny = Number(res.Content['USD'])
  if (!Number.isFinite(usdToCny) || usdToCny <= 0) {
    throw new Error('锦绣国际汇率接口缺少 USD 基准汇率')
  }
  const conversion_rates = {}
  for (const [code, v] of Object.entries(res.Content)) {
    if (!/^[A-Z]{3}$/.test(code)) continue
    const toCny = Number(v)
    if (!Number.isFinite(toCny) || toCny <= 0) continue
    conversion_rates[code] = usdToCny / toCny
  }
  return {
    result: 'success',
    provider: 'xxklf',
    conversion_rates,
    time_last_update_unix: Math.floor(Date.now() / 1000)
  }
}

/**
 * 拉取最新汇率（以 USD 为锚定）
 * @param {string} provider  数据源标识（xxklf | exchangerate），缺省用默认源 xxklf
 * 返回 { result, provider, conversion_rates, time_last_update_unix }
 */
export async function fetchExchangeRate(provider = DEFAULT_RATE_PROVIDER) {
  if (provider === 'exchangerate') return fetchExchangeRateIO()
  return fetchExchangeRateXXKLF()
}

// 三页查询：每页 100 条，offset 0/100/200，共约 300 个国家
// response_fields 只取前端需要的字段，减少传输体积
const RESTCOUNTRIES_FIELDS = 'names.common,names.official,names.translations,codes.alpha_2,codes.alpha_3,flag.url_png,timezones,currencies,links.official,links.wikipedia'

/**
 * 拉取全部国家信息（3 页串行 + retry + 结构化映射）
 *
 * 为什么串行不用并发：
 *   restcountries.com 在 Cloudflare 后面，3 页并发会触发 Cloudflare 边缘限流
 *   （>20 req/10s）和 keep-alive race condition（多请求复用 socket 时 RST）。
 *   串行虽然慢（每页 1-14 秒，共 3-42 秒），但成功率高，且 fetchCountriesWithCache
 *   会把结果缓存到本地文件（userData/cache/countries.json），之后启动从本地读，
 *   不会每次都拉 API。
 *
 * 地址与 key 从配置读取（币种富信息源），每页 15 秒超时 + 3 次 retry
 * 返回 [{ name, officialName, alpha2Code, alpha3Code, flagUrlPng, timezones, currencies, translations, wikiLink, officialLink }]
 */
export async function fetchCountries() {
  const { baseUrl, key } = getErcConfig().providers.restcountries
  const base = baseUrl.replace(/\/+$/, '')
  const headers = { Authorization: `Bearer ${key}` }
  const data = []
  // 3 页串行：offset 0/100/200，每页 100 条
  for (const offset of [0, 100, 200]) {
    const url = `${base}?limit=100&offset=${offset}&requestedFromWeb=1&pretty&response_fields=${RESTCOUNTRIES_FIELDS}`
    const json = await getJson(url, { timeoutMs: 15000, headers, retries: 3 })
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
}

// ==================== 国家列表本地缓存 ====================
// 文件：userData/cache/countries.json
// 结构：{ schemaVersion, updatedAt: ISO, data: fetchCountries() 返回的数组 }
//
// 设计要点：
//   - 原子写：先写 .tmp 再 rename，避免半成品文件被下次启动读到
//   - schemaVersion 校验：旧版结构缓存自动失效，触发重拉
//   - 读取失败/解析失败/schemaVersion 不匹配 → 返回 null（由调用方决定是否拉 API）
//   - 不返回 fallback 数据：API 失败时让渲染层显示错误提示，不用过期/损坏的本地数据
function getCountriesCacheFile() {
  return path.join(app.getPath('userData'), 'cache', 'countries.json')
}

/**
 * 把 fetchCountries 结果原子写入本地缓存文件
 * 写入失败静默：缓存只是优化，写不进去不影响主流程（下次启动会重拉）
 * @param {Array} data - fetchCountries() 返回的国家列表
 */
function writeCountriesCache(data) {
  const file = getCountriesCacheFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = {
      schemaVersion: COUNTRIES_CACHE_SCHEMA,
      updatedAt: new Date().toISOString(),
      data
    }
    // 原子写：先写 .tmp 再 rename，防止中途崩溃留下半成品 JSON
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    // 写缓存失败不影响主流程：缓存只是优化，下次启动时本地无缓存会重拉 API
  }
}

/**
 * 从本地缓存读取国家列表
 * @returns {{ updatedAt: string, data: Array } | null}
 *   文件不存在/解析失败/schemaVersion 不匹配/字段缺失 → 返回 null（视为无缓存）
 */
function readCountriesCache() {
  try {
    const raw = fs.readFileSync(getCountriesCacheFile(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.schemaVersion !== COUNTRIES_CACHE_SCHEMA) return null
    if (!Array.isArray(parsed.data) || !parsed.updatedAt) return null
    return { updatedAt: parsed.updatedAt, data: parsed.data }
  } catch {
    return null
  }
}

/**
 * 读取项目打包的 bundled 国家列表（electron/features/erc/data/countries.json）
 *
 * 用途：软件首次启动时 userData/cache/countries.json 还不存在，此时读 bundled 数据
 *   作为初始数据源，让用户立即看到国家列表（不用等 API 拉取）。
 *   bundled 数据由开发时一次性拉取完整 API 数据生成，随软件发布。
 *
 * @returns {Array} 国家列表（与 fetchCountries 返回结构一致），读失败返回空数组
 */
function readBundledCountries() {
  try {
    // ESM 里读相对路径文件：用 new URL + import.meta.url
    const bundledUrl = new URL('./data/countries.json', import.meta.url)
    const raw = fs.readFileSync(bundledUrl, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.schemaVersion !== COUNTRIES_CACHE_SCHEMA) return []
    if (!Array.isArray(parsed.data)) return []
    return parsed.data
  } catch {
    return []
  }
}

/**
 * 渲染层获取国家列表（推荐入口）—— 立即返回，不调 API
 *
 * 数据源优先级：
 *   1. userData/cache/countries.json（后台任务每天更新一次）
 *   2. 项目 bundled 数据（electron/features/erc/data/countries.json，随软件发布）
 *
 * 设计要点：
 *   - 不调 API：用户进入 ERC 界面立即拿到数据（<10ms），不阻塞 UI
 *   - 不返回 null：bundled 数据随软件发布，总有数据可读
 *   - API 拉取由 refreshCountriesCacheInBackground() 在后台静默完成
 *
 * @returns {Array} 国家列表（与 fetchCountries 返回结构一致）
 */
export function getCountriesForRenderer() {
  // 1. 优先读 userData 缓存（后台任务更新过的最新数据）
  const cached = readCountriesCache()
  if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
    return cached.data
  }
  // 2. 缓存不存在/损坏 → 读 bundled 数据
  return readBundledCountries()
}

/**
 * 后台静默刷新国家列表缓存（不阻塞调用方）
 *
 * 调 fetchCountries() 拉 API → 成功写本地缓存，失败静默丢弃
 *   - 不返回数据：调用方不等待结果
 *   - 不抛错：网络/API 失败不打断用户，下次定时任务再试
 *
 * 由 controller 的 startCountriesBackgroundScheduler 每天 1 次调度
 */
export async function refreshCountriesCacheInBackground() {
  try {
    const fresh = await fetchCountries()
    if (Array.isArray(fresh) && fresh.length > 0) {
      writeCountriesCache(fresh)
      console.log(`[ERC service] 后台刷新国家列表成功：${fresh.length} 个国家`)
    }
  } catch (e) {
    // 静默失败：网络抖动不打断用户，下次定时任务再试
    console.log(`[ERC service] 后台刷新国家列表失败：${e?.message || e}`)
  }
}
