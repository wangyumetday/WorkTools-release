// ERC ConfigManager - 汇率源、币种富信息源、刷新频率与悬浮窗外观配置管理器
// 职责：管理汇率源（xxklf 默认 / exchangerate）与币种富信息源（restcountries）的
//       地址/key、全局自动刷新频率、悬浮窗缩放/透明度
//
// 持久化：userData/config/ercConfig.json
//   - 文件带 schemaVersion；与当前版本不一致（接入新汇率源等结构变更）→ 整文件失效回默认
//   - 加载时与默认配置深合并，兼容老用户配置缺字段（地址/key 变更时自动补默认）
//   - 仅做格式校验后落盘；网络连通性由保存后的立即拉取验证，失败不回滚
//
// 与 pcp ConfigManager 同一范式（userData/config/*.json），但 ERC 配置结构
// 固定且简单，使用模块级懒加载单例，无需 class/DI。

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

// 刷新频率边界（分钟，整数）
export const REFRESH_INTERVAL_MIN = 1
export const REFRESH_INTERVAL_MAX = 1440

// ercConfig.json 结构版本：汇率源集合/默认刷新频率变更时递增，旧文件整体失效回默认
const ERC_CONFIG_SCHEMA = 2

// 悬浮窗缩放/透明度边界（与 floatingWindow.js 的 OPACITY_MIN/MAX、ZOOM_MIN/MAX 对齐）
export const FLOATING_OPACITY_MIN = 0.1
export const FLOATING_OPACITY_MAX = 1.0
export const FLOATING_ZOOM_MIN = 0.5
export const FLOATING_ZOOM_MAX = 1.5
// 固定展开态鼠标离开后的透明度（dim）边界。上限 1.0：设为 1.0 即不变暗
// （实际生效值由渲染层取 min(dimOpacity, baseOpacity)，不会比原本更亮）
export const FLOATING_DIM_OPACITY_MIN = 0.05
export const FLOATING_DIM_OPACITY_MAX = 1.0

// 默认配置（原硬编码在 service.js 的地址与 key 下沉至此）
//   providers.<id>.baseUrl 语义：
//     xxklf        : 锦绣国际汇率接口（默认汇率源，CNY 基准，无需 Key）
//     exchangerate : 不含 key 的基础地址，适配者拼 `${baseUrl}/${key}/latest/USD`
//     restcountries : 币种富信息源（中文名、国旗图标），完整批量国家列表地址，key 走 Bearer 请求头
//   refreshIntervalMin：全局汇率自动刷新频率默认 180 分钟（3 小时）
//   floating：悬浮窗外观（缩放/透明度），由 ERC 设置页统一配置，持久化在主进程
//     （悬浮窗独立 session partition，localStorage 与主窗不共享，故放主进程配置）
const DEFAULT_CONFIG = {
  providers: {
    xxklf: {
      baseUrl: 'https://ticket-int.xxklf.com/api/ExchangeRate/all',
      key: ''
    },
    exchangerate: {
      baseUrl: 'https://v6.exchangerate-api.com/v6',
      key: '966d147f84377b39f732f221'
    },
    restcountries: {
      baseUrl: 'https://api.restcountries.com/countries/v5',
      key: 'rc_live_f4b2574cecc9494dad9a9452e2d05752'
    }
  },
  refreshIntervalMin: 180,
  floating: {
    opacity: 1.0,
    zoom: 1.0,
    dimOpacity: 0.1
  }
}

function getConfigFile() {
  return path.join(app.getPath('userData'), 'config', 'ercConfig.json')
}

// 默认配置的深拷贝（防止调用方误改默认值）
function cloneDefaults() {
  return {
    providers: {
      xxklf: { ...DEFAULT_CONFIG.providers.xxklf },
      exchangerate: { ...DEFAULT_CONFIG.providers.exchangerate },
      restcountries: { ...DEFAULT_CONFIG.providers.restcountries }
    },
    refreshIntervalMin: DEFAULT_CONFIG.refreshIntervalMin,
    floating: { ...DEFAULT_CONFIG.floating }
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
  if (saved.floating && typeof saved.floating === 'object') {
    if (Number.isFinite(saved.floating.opacity)) {
      merged.floating.opacity = Math.min(FLOATING_OPACITY_MAX, Math.max(FLOATING_OPACITY_MIN, Number(saved.floating.opacity)))
    }
    if (Number.isFinite(saved.floating.zoom)) {
      merged.floating.zoom = Math.min(FLOATING_ZOOM_MAX, Math.max(FLOATING_ZOOM_MIN, Number(saved.floating.zoom)))
    }
    if (Number.isFinite(saved.floating.dimOpacity)) {
      merged.floating.dimOpacity = Math.min(FLOATING_DIM_OPACITY_MAX, Math.max(FLOATING_DIM_OPACITY_MIN, Number(saved.floating.dimOpacity)))
    }
  }
  return merged
}

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(getConfigFile(), 'utf-8')
    const parsed = JSON.parse(raw)
    // schemaVersion 不一致（接入新汇率源等结构变更）→ 旧文件整体失效，回默认配置
    cache = (parsed && parsed.schemaVersion === ERC_CONFIG_SCHEMA)
      ? mergeWithDefaults(parsed)
      : mergeWithDefaults(null)
  } catch {
    // 文件不存在或解析失败：用默认值（不主动写盘，首次保存时创建）
    cache = mergeWithDefaults(null)
  }
  return cache
}

function persist() {
  const file = getConfigFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: ERC_CONFIG_SCHEMA, ...cache }, null, 2), 'utf-8')
}

// 保存前格式校验；不通过抛 Error（controller 捕获后回传渲染层提示）
// xxklf（默认源）与 exchangerate 地址必填；xxklf 无需 Key；restcountries 允许留空（留空则用默认值）
function validate(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('配置内容为空')

  const xx = patch.providers?.xxklf
  if (!xx || typeof xx !== 'object') throw new Error('缺少汇率源 xxklf 的配置')
  const xxBaseUrl = String(xx.baseUrl ?? '').trim()
  if (!/^https?:\/\/.+/.test(xxBaseUrl)) {
    throw new Error('锦绣国际汇率接口的地址必须以 http:// 或 https:// 开头')
  }

  const ex = patch.providers?.exchangerate
  if (!ex || typeof ex !== 'object') throw new Error('缺少汇率源 exchangerate 的配置')
  const exBaseUrl = String(ex.baseUrl ?? '').trim()
  if (!/^https?:\/\/.+/.test(exBaseUrl)) {
    throw new Error('ExchangeRate-API 的地址必须以 http:// 或 https:// 开头')
  }
  if (!String(ex.key ?? '').trim()) {
    throw new Error('ExchangeRate-API 的 Key 不能为空')
  }

  const rc = patch.providers?.restcountries
  if (rc && typeof rc === 'object') {
    const rcBaseUrl = String(rc.baseUrl ?? '').trim()
    if (rcBaseUrl && !/^https?:\/\/.+/.test(rcBaseUrl)) {
      throw new Error('币种富信息源的地址必须以 http:// 或 https:// 开头')
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
      xxklf: { ...c.providers.xxklf },
      exchangerate: { ...c.providers.exchangerate },
      restcountries: { ...c.providers.restcountries }
    },
    refreshIntervalMin: c.refreshIntervalMin,
    floating: { ...c.floating }
  }
}

// 校验 → 合并落盘；成功返回新配置（深拷贝），失败抛 Error（不改动内存与磁盘）
export function setErcConfig(patch) {
  validate(patch)
  const next = mergeWithDefaults(patch)
  cache = next
  persist()
  return getErcConfig()
}

// 读取悬浮窗外观配置（深拷贝）
export function getFloatingConfig() {
  return { ...load().floating }
}

// 部分更新悬浮窗外观配置并落盘（仅接受 opacity / zoom / dimOpacity 字段，自动 clamp）。
// 由 floatingWindow.js 的 IPC 调用，传入 { opacity?, zoom?, dimOpacity? }。
export function updateFloatingConfig(patch) {
  if (!patch || typeof patch !== 'object') return getFloatingConfig()
  const c = load()
  if (Number.isFinite(patch.opacity)) {
    c.floating.opacity = Math.min(FLOATING_OPACITY_MAX, Math.max(FLOATING_OPACITY_MIN, Number(patch.opacity)))
  }
  if (Number.isFinite(patch.zoom)) {
    c.floating.zoom = Math.min(FLOATING_ZOOM_MAX, Math.max(FLOATING_ZOOM_MIN, Number(patch.zoom)))
  }
  if (Number.isFinite(patch.dimOpacity)) {
    c.floating.dimOpacity = Math.min(FLOATING_DIM_OPACITY_MAX, Math.max(FLOATING_DIM_OPACITY_MIN, Number(patch.dimOpacity)))
  }
  persist()
  return getFloatingConfig()
}
