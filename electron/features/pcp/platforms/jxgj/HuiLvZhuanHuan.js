// ============================================================
// 汇率转换模块（JXGJ 平台专用）
//
// 功能：
//   1. AnyToCny(BIZHONG, JINE) —— 任意币种金额 → 人民币金额（同步调用）
//   2. 汇率数据从 exchangerate-api 拉取，CNY 为基准币
//   3. 汇率缓存到本地 JSON 文件，有效期 1 小时（3600s）
//   4. 过期时不阻塞同步调用：先用旧值算，后台异步刷新下次生效
//   5. 首次运行无缓存：内置常见币种默认汇率做底线兜底
//   6. 金额精确计算使用 decimal.js（杜绝浮点误差，钱不能算错）
//
// 注：本模块在主进程被 import，不能在模块顶层调 electron.app.getPath()
//     （app 那时候可能还没 ready），所以缓存路径用 os.homedir() 拼。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Decimal from 'decimal.js'

// ---------- 配置：API key、URL、缓存有效期 ----------
const ExchangeRate_KEY = '966d147f84377b39f732f221'
const ExchangeRate_URL = `https://v6.exchangerate-api.com/v6/${ExchangeRate_KEY}/latest/CNY`

// 缓存有效期（毫秒）= 1 小时
const CACHE_TTL_MS = 60 * 60 * 1000

// ---------- 配置：本地缓存路径 ----------
// Windows 下：C:\Users\<用户名>\.worktools\exchange_rate_cache.json
// macOS/Linux：~/.worktools/exchange_rate_cache.json
const CACHE_DIR = path.join(os.homedir(), '.worktools')
const CACHE_FILE = path.join(CACHE_DIR, 'exchange_rate_cache.json')

// ---------- 常见币种兜底汇率（首次无缓存时使用）----------
// 含义：1 CNY = x 外币（与 exchangerate-api /latest/CNY 返回语义一致）
// 定期人工更新，仅作底线，真实运行 1-2 秒后就会被 API 拉取的真值覆盖
const FALLBACK_RATES = {
  CNY: 1,
  USD: 0.138,
  EUR: 0.126,
  JPY: 23.82,
  HKD: 1.078,
  GBP: 0.107,
  KRW: 190.5,
  AUD: 0.215,
  CAD: 0.191,
  SGD: 0.185,
  CHF: 0.122,
  THB: 4.73,
  MYR: 0.65,
  IDR: 2165,
  VND: 3520,
  PHP: 7.92,
  INR: 11.6,
  MXN: 2.38,
  BRL: 0.69,
  RUB: 13.1,
  ZAR: 2.55,
  SEK: 1.51,
  NOK: 1.47,
  DKK: 0.94,
  PLN: 0.55,
  TRY: 4.75,
  AED: 0.507,
  SAR: 0.518,
  NZD: 0.233,
  TWD: 4.55,
  MOP: 1.11
}

// ---------- 内存状态 ----------
/** @type {Record<string, number> | null} 内存中的汇率表（1 CNY = ? 外币） */
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
    // 简单结构校验：必须有 rates（object）和 fetchedAt（number）
    if (obj && typeof obj.rates === 'object' && obj.rates && typeof obj.fetchedAt === 'number') {
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
  const obj = { rates, fetchedAt, savedAt: Date.now() }
  // 异步写，失败不抛（磁盘满/权限等不影响主流程）
  fs.promises.writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8').catch(e => {
    console.warn('[HuiLvZhuanHuan] 缓存文件写入失败:', e?.message || e)
  })
}

// ============================================================
// 工具：异步拉取最新汇率（exchangerate-api /latest/CNY）
// ============================================================
async function _fetchRatesFromApi() {
  const res = await fetch(ExchangeRate_URL, { method: 'GET' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const data = await res.json()
  if (data.result !== 'success' || !data.conversion_rates || typeof data.conversion_rates !== 'object') {
    throw new Error(`返回格式异常: ${data['error-type'] || data.result || 'unknown'}`)
  }
  return data.conversion_rates
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
//   API 返回 conversion_rates[BIZHONG] = R 表示 "1 CNY = R 外币"
//   因此：外币金额 JINE → CNY = JINE / R
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

  // 精确除法：CNY = JINE / rate，四舍五入 2 位
  const cny = amount.div(new Decimal(String(rate))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  return Number(cny)
}
