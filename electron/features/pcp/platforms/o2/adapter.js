// ============================================================
// O2 平台 adapter（模板，未实现，预留位置）
// 接入真实接口时：参考 trip/adapter.js 实现 prepareRequest/request/mergeResult
// 未实现的方法抛错，避免误调用
// ============================================================

import { configSchema, defaults } from './config.js'

export const key = 'o2'
// 平台中文名：用于导出文件名（O2导入政策{日期}.xlsx / 底价检查(O2){日期}.xlsx）和底价列名（O2底价）
export const displayName = 'O2'
export { configSchema, defaults }

export const compileConfig = (raw = {}) => ({ ...raw })

export async function login(credential) {
  return { sessionId: `mock-o2-${Math.random().toString(36).slice(2)}` }
}

export function prepareRequest() {
  throw new Error('O2 平台未实现：prepareRequest')
}

export async function request() {
  throw new Error('O2 平台未实现：request')
}

export function mergeResult() {
  throw new Error('O2 平台未实现：mergeResult')
}

export const exportTemplate = null

export default {
  key, displayName, configSchema, defaults,
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate
}
