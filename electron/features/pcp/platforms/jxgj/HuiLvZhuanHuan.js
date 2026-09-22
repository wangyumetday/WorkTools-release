// ============================================================
// 汇率转换模块（JXGJ 平台专用）
//
// 功能：
//   1. AnyToCny(BIZHONG, JINE) —— 任意币种金额 → 人民币金额（同步调用）
//   2. 汇率数据从锦绣国际汇率接口拉取（ticket-int.xxklf.com/api/ExchangeRate/all）
//      返回结构 { Content: { 币种码: 汇率 }, Status: 1, Msg: 'OK' }，
//      语义为「1 单位外币 = X CNY」，CNY 恒为 1（CNY 基准汇率表）
//   3. 汇率缓存到本地 JSON 文件，有效期 1 小时（3600s）
//   4. 过期时不阻塞同步调用：先用旧值算，后台异步刷新下次生效
//   5. 首次运行无缓存：内置常见币种默认汇率做底线兜底（与接口同语义）
//   6. 金额精确计算使用 decimal.js（杜绝浮点误差，钱不能算错）
//
// 注：本模块在主进程被 import，不能在模块顶层调 electron.app.getPath()
//     （app 那时候可能还没 ready），所以缓存路径用 os.homedir() 拼。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Decimal from 'decimal.js'

// ---------- 配置：汇率接口 URL、缓存有效期 ----------
const ExchangeRate_URL = 'https://ticket-int.xxklf.com/api/ExchangeRate/all'

// 缓存有效期（毫秒）= 1 小时
const CACHE_TTL_MS = 60 * 60 * 1000

// 缓存格式标记：接入锦绣国际汇率接口后与旧缓存（1 CNY = x 外币 语义）不兼容，
// 旧文件无本标记 → 视为无缓存（回兜底表 + 后台重拉）
const CACHE_SCHEMA = 'xxklf'

// ---------- 配置：本地缓存路径 ----------
// Windows 下：C:\Users\<用户名>\.worktools\exchange_rate_cache.json
// macOS/Linux：~/.worktools/exchange_rate_cache.json
const CACHE_DIR = path.join(os.homedir(), '.worktools')
const CACHE_FILE = path.join(CACHE_DIR, 'exchange_rate_cache.json')

// ---------- 常见币种兜底汇率（首次无缓存时使用）----------
// 语义：1 单位外币 = X CNY（与锦绣国际汇率接口 Content 语义一致），CNY 恒为 1
// 取值与接口近期返回值一致，仅作底线，真实运行 1-2 秒后就会被 API 拉取的真值覆盖
const FALLBACK_RATES = {
  CNY: 1,
  USD: 6.6979,
  EUR: 7.684,
  JPY: 0.0425,
  HKD: 0.8538,
  GBP: 8.9638,
  KRW: 0.0049,
  AUD: 4.7733,
  CAD: 4.7755,
  SGD: 5.2493,
  CHF: 8.1639,
  THB: 0.2015,
  MYR: 1.6442,
  IDR: 0.000375,
  VND: 0.000257,
  PHP: 0.1069,
  INR: 0.0699,
  MXN: 0.3891,
  BRL: 1.3101,
  RUB: 0.0799,
  ZAR: 0.4123,
  SEK: 0.6816,
  NOK: 0.7102,
  DKK: 1.028,
  PLN: 1.768,
  TRY: 0.1372,
  AED: 1.8235,
  SAR: 1.7828,
  NZD: 3.8442,
  TWD: 0.2115,
  MOP: 0.8291
}

// ---------- 内存状态 ----------
/** @type {Record<string, number> | null} 内存中的汇率表（1 单位外币 = ? CNY） */
let _rates = null
/** @type {number} 上次拉取时间戳（ms，Date.now()） */
let _fetchedAt = 0
/** @type {Promise<void> | null} 正在刷新中的 Promise，防止并发重复请求 */
let _refreshPromise = null

// ============================================================
// 工具：确保缓存目录存在（同步，供 ensureRatesSync 调用）
// ============================================================
function _ensureCacheDirSync() {
  if (!fs.existsSync(CACHE_DIR)) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
    } catch (e) {
      // 目录创建失败（权限问题等），打个 warn，不阻塞业务（内存+兜底表还能跑）
      console.warn('[HuiLvZhuanHuan] 缓存目录创建失败，将仅使用内存缓存:', e?.message || e)
    }
  }
}

// ============================================================
// 工具：从磁盘同步读取缓存文件
// ============================================================
function _loadCacheSync() {
  _ensureCacheDirSync()
  if (!fs.existsSync(CACHE_FILE)) return null
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8')
    const obj = JSON.parse(raw)
    // 结构校验：必须有格式标记（src）、rates（object）和 fetchedAt（number）
    if (obj && obj.src === CACHE_SCHEMA && typeof obj.rates === 'object' && obj.rates && typeof obj.fetchedAt === 'number') {
      return obj
    }
    return null
  } catch (e) {
    console.warn('[HuiLvZhuanHuan] 缓存文件损坏，已忽略:', e?.message || e)
    return null
  }
}

// ============================================================
// 工具：把汇率表写入磁盘（异步，后台刷新成功后调用）
// ============================================================
function _saveCacheAsync(rates, fetchedAt) {
  _ensureCacheDirSync()
  const obj = { src: CACHE_SCHEMA, rates, fetchedAt, savedAt: Date.now() }
  // 异步写，失败不抛（磁盘满/权限等不影响主流程）
  fs.promises.writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8').catch(e => {
    console.warn('[HuiLvZhuanHuan] 缓存文件写入失败:', e?.message || e)
  })
}

// ============================================================
// 工具：异步拉取最新汇率（锦绣国际汇率接口 /api/ExchangeRate/all）
//   返回 { Content: { 币种码: 1单位外币=X CNY }, Status, Msg }；
//   只保留标准三字币种码（Content 混有 CNY_LJ / USD_NS 等分渠道变体码，剔除）
// ============================================================
async function _fetchRatesFromApi() {
  const res = await fetch(ExchangeRate_URL, { method: 'GET' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const data = await res.json()
  if (data.Status !== 1 || !data.Content || typeof data.Content !== 'object') {
    throw new Error(`返回格式异常: ${data.Msg || data.Status || 'unknown'}`)
  }
  const rates = {}
  for (const [code, v] of Object.entries(data.Content)) {
    if (!/^[A-Z]{3}$/.test(code)) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) rates[code] = n
  }
  return rates
}

// ============================================================
// 工具：异步刷新汇率（拉取 → 更新内存 → 持久化到磁盘）
// 重复调用并发安全（复用同一个 _refreshPromise）
// ============================================================
async function _refreshRatesAsync() {
  if (_refreshPromise) return _refreshPromise
  _refreshPromise = (async () => {
    try {
      const rates = await _fetchRatesFromApi()
      const now = Date.now()
      _rates = rates
      _fetchedAt = now
      _saveCacheAsync(rates, now)
    } catch (e) {
      console.warn('[HuiLvZhuanHuan] 汇率刷新失败，继续使用旧缓存:', e?.message || e)
    } finally {
      _refreshPromise = null
    }
  })()
  return _refreshPromise
}

// ============================================================
// 工具：同步保证 _rates 至少有值（内存 → 磁盘文件 → 兜底表）
//   并在过期时触发后台异步刷新（不阻塞当前调用）
// ============================================================
function _ensureRatesSync() {
  const now = Date.now()

  // 1) 内存已有值：只检查是否过期触发后台刷新，直接 return
  if (_rates) {
    if (now - _fetchedAt >= CACHE_TTL_MS && !_refreshPromise) {
      _refreshRatesAsync()
    }
    return
  }

  // 2) 内存空：尝试从磁盘同步加载
  const cached = _loadCacheSync()
  if (cached) {
    _rates = cached.rates
    _fetchedAt = cached.fetchedAt
    // 磁盘缓存也过期了 → 后台刷新，本次调用先用磁盘旧值
    if (now - _fetchedAt >= CACHE_TTL_MS && !_refreshPromise) {
      _refreshRatesAsync()
    }
    return
  }

  // 3) 磁盘也空（第一次运行）：用兜底表填内存，立刻后台刷新拉真值
  _rates = { ...FALLBACK_RATES }
  _fetchedAt = now
  if (!_refreshPromise) {
    _refreshRatesAsync()
  }
}

// ============================================================
// 对外 API：任意币种 → CNY
//
// 入参：
//   BIZHONG : string  —— 币种代码（如 'JPY'、'USD'、'CNY'），大小写不敏感
//   JINE    : number | string  —— 原币种金额（支持数字或数字字符串）
//
// 返回：number —— 折算后的人民币金额，四舍五入保留 2 位小数
//
// 换算逻辑：
//   汇率表 rates[BIZHONG] = R 表示 "1 单位外币 = R CNY"（CNY 恒为 1）
//   因此：外币金额 JINE → CNY = JINE × R
// ============================================================
export function AnyToCny(BIZHONG, JINE) {
  // 先保证内存里至少有一份汇率表（兜底/缓存/新拉 都可）
  _ensureRatesSync()

  // 参数归一化
  const code = String(BIZHONG || '').toUpperCase().trim()
  const amount = new Decimal(String(JINE ?? 0))

  // CNY 直接返回（四舍五入 2 位）
  if (code === 'CNY' || code === '') {
    return Number(amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
  }

  // 查汇率
  const rate = _rates[code]
  if (rate === undefined || rate === null || Number(rate) === 0) {
    // 未收录币种：打 warn，原样返回（至少不崩，用户从日志能发现）
    console.warn(`[HuiLvZhuanHuan] 未知币种代码: ${BIZHONG}，金额未折算`)
    return Number(amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
  }

  // 精确乘法：CNY = JINE × rate，四舍五入 2 位
  const cny = amount.times(new Decimal(String(rate))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  return Number(cny)
}
