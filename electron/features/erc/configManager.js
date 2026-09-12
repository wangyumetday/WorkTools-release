// ============================================================
// ERC ConfigManager - 汇率源与刷新频率配置管理器
// 职责：管理两个汇率源的请求地址/key 与全局自动刷新频率
//
// 持久化：userData/config/ercConfig.json
//   - 加载时与默认配置深合并，兼容老用户配置缺字段（地址/key 变更时自动补默认）
//   - 仅做格式校验后落盘；网络连通性由保存后的立即拉取验证，失败不回滚
//
// 与 pcp ConfigManager 同一范式（userData/config/*.json），但 ERC 配置结构
// 固定且简单，使用模块级懒加载单例，无需 class/DI。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

// 刷新频率边界（分钟，整数）
export const REFRESH_INTERVAL_MIN = 1
export const REFRESH_INTERVAL_MAX = 1440

// 默认配置（原硬编码在 service.js 的地址与 key 下沉至此）
//   providers.<id>.baseUrl 语义：
//     exchangerate : 不含 key 的基础地址，适配者拼 `${baseUrl}/${key}/latest/USD`
//     allratestoday: 完整批量汇率地址（query 已带 source=USD），key 走 Bearer 请求头
const DEFAULT_CONFIG = {
  providers: {
    exchangerate: {
      baseUrl: 'https://v6.exchangerate-api.com/v6',
      key: '966d147f84377b39f732f221'
    },
    allratestoday: {
      baseUrl: 'https://allratestoday.com/api/v1/rates?source=USD',
      key: 'art_live_bNsDvm7rZLEI1lbrcrKeQuNkmlosaccV'
    }
  },
  refreshIntervalMin: 30
}

function getConfigFile() {
  return path.join(app.getPath('userData'), 'config', 'ercConfig.json')
}

// 默认配置的深拷贝（防止调用方误改默认值）
function cloneDefaults() {
  return {
    providers: {
      exchangerate: { ...DEFAULT_CONFIG.providers.exchangerate },
      allratestoday: { ...DEFAULT_CONFIG.providers.allratestoday }
    },
    refreshIntervalMin: DEFAULT_CONFIG.refreshIntervalMin
  }
}

// 把磁盘配置合并到默认值之上（只保留已知键，老配置废弃字段自动剔除）
function mergeWithDefaults(saved) {
  const merged = cloneDefaults()
  if (!saved || typeof saved !== 'object') return merged
  for (const id of Object.keys(merged.providers)) {
    const s = saved.providers?.[id]
    if (s && typeof s === 'object') {
      if (typeof s.baseUrl === 'string' && s.baseUrl.trim()) {
        merged.providers[id].baseUrl = s.baseUrl.trim()
      }
      if (typeof s.key === 'string' && s.key.trim()) {
        merged.providers[id].key = s.key.trim()
      }
    }
  }
  if (Number.isFinite(saved.refreshIntervalMin)) {
    const n = Math.round(Number(saved.refreshIntervalMin))
    if (n >= REFRESH_INTERVAL_MIN && n <= REFRESH_INTERVAL_MAX) {
      merged.refreshIntervalMin = n
    }
  }
  return merged
}

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(getConfigFile(), 'utf-8')
    cache = mergeWithDefaults(JSON.parse(raw))
  } catch {
    // 文件不存在或解析失败：用默认值（不主动写盘，首次保存时创建）
    cache = mergeWithDefaults(null)
  }
  return cache
}

// 保存前格式校验；不通过抛 Error（controller 捕获后回传渲染层提示）
function validate(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('配置内容为空')
  for (const id of Object.keys(DEFAULT_CONFIG.providers)) {
    const p = patch.providers?.[id]
    if (!p || typeof p !== 'object') throw new Error(`缺少汇率源 ${id} 的配置`)
    const baseUrl = String(p.baseUrl ?? '').trim()
    if (!/^https?:\/\/.+/.test(baseUrl)) {
      throw new Error(`汇率源 ${id} 的地址必须以 http:// 或 https:// 开头`)
    }
    if (!String(p.key ?? '').trim()) {
      throw new Error(`汇率源 ${id} 的 Key 不能为空`)
    }
  }
  const interval = Number(patch.refreshIntervalMin)
  if (!Number.isInteger(interval) || interval < REFRESH_INTERVAL_MIN || interval > REFRESH_INTERVAL_MAX) {
    throw new Error(`刷新频率必须是 ${REFRESH_INTERVAL_MIN}～${REFRESH_INTERVAL_MAX} 之间的整数（分钟）`)
  }
}

// ==================== 对外接口 ====================

// 读取配置（深拷贝，调用方可安全读写）
export function getErcConfig() {
  const c = load()
  return {
    providers: {
      exchangerate: { ...c.providers.exchangerate },
      allratestoday: { ...c.providers.allratestoday }
    },
    refreshIntervalMin: c.refreshIntervalMin
  }
}

// 校验 → 合并落盘；成功返回新配置（深拷贝），失败抛 Error（不改动内存与磁盘）
export function setErcConfig(patch) {
  validate(patch)
  const next = mergeWithDefaults(patch)
  const file = getConfigFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8')
  cache = next
  return getErcConfig()
}
