// ============================================================
// ERC Controller - IPC handlers 注册器 + 汇率定时刷新调度
// 职责：
//   - 把渲染层的汇率/国家列表 IPC 请求分发给 service 业务函数
//   - 单点定时刷新汇率（30 分钟一次），结果广播给所有 ERC 渲染层
//
// IPC 命名空间：erc:exchange:*
//   - erc:exchange:getRate       渲染层主动拉取最新汇率（USD 锚定）
//   - erc:exchange:getCountries  渲染层主动拉取全部国家信息
//   - erc:exchange:rateUpdated   主进程定时刷新后向所有窗口广播（event channel）
//
// 调用方式：main.js 在 registerIpcHandlers 阶段调一次
//   registerErcController()
//   startRateScheduler()
//
// 单点调度的意义：避免多窗口（Home/FloatingHome）各自 setInterval 重复拉取
//   超出免费 API 月度配额；主进程唯一 timer，渲染层只订阅推送
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { fetchExchangeRate, fetchCountries } from './service.js'

const RATE_REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 30 分钟

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

/**
 * 拉取一次汇率并广播给所有窗口
 * 失败静默（保留上一次数据，符合"无 fallback data"约束）
 */
async function refreshAndBroadcast() {
  try {
    const res = await fetchExchangeRate()
    if (!res || res.result !== 'success') return
    // 广播给所有窗口（Home + FloatingHome 都监听）
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('erc:exchange:rateUpdated', res)
      }
    }
  } catch (e) {
    // 静默失败：网络抖动不打断用户操作
  }
}

/**
 * 启动汇率定时刷新调度器
 * 启动时立即拉一次（让冷启动尽快拿到最新数据），之后每 30 分钟一次
 */
export function startRateScheduler() {
  // 立即拉一次（不等 30 分钟）
  refreshAndBroadcast()
  setInterval(refreshAndBroadcast, RATE_REFRESH_INTERVAL_MS)
}
