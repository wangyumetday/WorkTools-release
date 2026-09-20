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
// 国家列表本地缓存：
//   - 文件路径：userData/cache/countries.json
//   - 结构：{ schemaVersion: 1, updatedAt: ISO, data: [...] }
//   - 由 fetchCountriesWithCache(maxAgeMs) 透明管理：未过期读本地，过期调 API + 写文件
//   - API 失败时抛错（不返回旧数据兜底），由渲染层显示醒目错误提示
//
// 说明：地址与 key 在 ERC 设置页配置，持久化于 userData/config/ercConfig.json，
//       缺省时使用 configManager 内置默认值
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getErcConfig } from './configManager.js'

// 汇率源标识（渲染层 rateProvider / IPC 参数共用）
export const RATE_PROVIDERS = ['exchangerate']
export const DEFAULT_RATE_PROVIDER = 'exchangerate'

// 国家列表本地缓存的 schema 版本：字段结构升级时递增，旧版缓存自动失效重拉
const COUNTRIES_CACHE_SCHEMA = 1

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
 * 带本地缓存的国家列表获取（推荐入口）
 * 流程：
 *   1. 读本地缓存 → 若 updatedAt + maxAgeMs 仍在未来 → 直接返回缓存数据
 *   2. 缓存过期/不存在/损坏 → 调 fetchCountries() API
 *   3. API 成功 → 写本地缓存 + 返回新数据
 *   4. API 失败 → 抛错（不返回旧数据兜底，由渲染层显示醒目错误提示）
 *
 * @param {number} maxAgeMs - 缓存有效期（毫秒），由 controller 从 ERC 配置注入
 * @returns {Promise<Array>} 国家列表（与 fetchCountries 返回结构一致）
 */
export async function fetchCountriesWithCache(maxAgeMs) {
  const cached = readCountriesCache()
  if (cached) {
    const ageMs = Date.now() - new Date(cached.updatedAt).getTime()
    if (Number.isFinite(ageMs) && ageMs < maxAgeMs) {
      return cached.data
    }
  }
  // 缓存过期或不存在：调 API
  const fresh = await fetchCountries()
  writeCountriesCache(fresh)
  return fresh
}
