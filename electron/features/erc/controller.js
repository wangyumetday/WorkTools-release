// ============================================================
// ERC Controller - IPC handlers 注册器
// 职责：把渲染层的汇率/国家列表 IPC 请求分发给 service 业务函数
//
// IPC 命名空间：erc:exchange:*
//   - erc:exchange:getRate      拉取最新汇率（USD 锚定）
//   - erc:exchange:getCountries 拉取全部国家信息
//
// 调用方式：main.js 在 registerIpcHandlers 阶段调一次
//   registerErcController()
// ============================================================

import { ipcMain } from 'electron'
import { fetchExchangeRate, fetchCountries } from './service.js'

/**
 * 注册 ERC feature 的全部 IPC handlers
 */
export function registerErcController() {
  // 拉取最新汇率（以 USD 为锚定）
  ipcMain.handle('erc:exchange:getRate', async () => {
    return await fetchExchangeRate()
  })

  // 拉取全部国家信息（含币种代码、国旗、时区）
  ipcMain.handle('erc:exchange:getCountries', async () => {
    return await fetchCountries()
  })
}
