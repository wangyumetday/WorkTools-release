// 预留拓展位 adapter（模板，未实现）
// 接入真实平台时：复制本目录改为新平台 key，参考 trip/adapter.js 实现
//   prepareRequest / request / mergeResult，并在 registry.js 注册
// 未实现的方法抛错，避免误调用

import { configSchema, defaults } from './config.js'

export const key = 'reserved'
// 平台中文名：用于导出文件名（预留拓展位导入政策{日期}.xlsx）和底价列名
export const displayName = '预留拓展位'
export { configSchema, defaults }

export const compileConfig = (raw = {}) => ({ ...raw })

export async function login(credential) {
  return { sessionId: `mock-reserved-${Math.random().toString(36).slice(2)}` }
}

export function prepareRequest() {
  throw new Error('预留拓展位平台未实现：prepareRequest')
}

export async function request() {
  throw new Error('预留拓展位平台未实现：request')
}

export function mergeResult() {
  throw new Error('预留拓展位平台未实现：mergeResult')
}

export const exportTemplate = null

export default {
  key, displayName, configSchema, defaults,
  compileConfig, login, prepareRequest, request, mergeResult, exportTemplate
}
