// ============================================================
// PlatformAdapter 注册中心
// 职责：替代老 taskManager 中的 PLATFORM_COMPILERS + O_PLATFORM_HANDLERS 两张硬编码映射表
// 新增平台：在 platforms/ 下建 <key>/ 目录，实现 adapter，在此 register(adapter)
// 调度器/编排器通过 registry.get(key) 动态分发，零硬编码
// ============================================================

import jxgj from './jxgj/adapter.js'
import trip from './trip/adapter.js'
import o2 from './o2/adapter.js'
import o3 from './o3/adapter.js'

const _registry = new Map()

/**
 * ARCH-5：O 平台 key 常量（替代散落各处的 ['trip','o2','o3'] 硬编码）
 *   新增 O 平台时只需在此数组追加 key + 在下方 register
 *   jxgj 是数据源平台（非 O 平台），不在此列表
 */
export const O_PLATFORM_KEYS = ['trip', 'o2', 'o3']

/** 数据源平台 key（jxgj，非 O 平台） */
export const SOURCE_PLATFORM_KEYS = ['jxgj']

/**
 * 注册一个平台 adapter
 * @param {object} adapter - PlatformAdapter（必须含 key + 7 方法）
 */
export function register(adapter) {
  if (!adapter?.key) throw new Error('PlatformAdapter 缺少 key')
  if (_registry.has(adapter.key)) {
    console.warn(`[registry] 平台 ${adapter.key} 重复注册，后注册覆盖前者`)
  }
  _registry.set(adapter.key, adapter)
}

/**
 * 取平台 adapter
 * @param {string} key - 'jxgj' | 'trip' | 'o2' | 'o3'
 */
export function get(key) {
  const a = _registry.get(key)
  if (!a) throw new Error(`未注册的平台: ${key}`)
  return a
}

/** 所有已注册平台 adapter */
export function all() {
  return Array.from(_registry.values())
}

/** 所有已注册平台 key */
export function keys() {
  return Array.from(_registry.keys())
}

/** 所有 O 平台 adapter（ARCH-5：动态过滤） */
export function oPlatforms() {
  return O_PLATFORM_KEYS.map(k => _registry.get(k)).filter(Boolean)
}

// ===== 初始化：注册内置平台 =====
register(jxgj)
register(trip)
register(o2)
register(o3)

export default { register, get, all, keys, oPlatforms, O_PLATFORM_KEYS, SOURCE_PLATFORM_KEYS }
