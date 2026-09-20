// ============================================================
// ERC Controller - IPC handlers 注册器 + 汇率定时刷新调度
// 职责：
//   - 把渲染层的汇率/国家列表/配置 IPC 请求分发给业务模块
//   - 单点定时刷新汇率（间隔读 ERC 配置，默认 30 分钟），结果广播给所有 ERC 渲染层
//
// IPC 命名空间：erc:*
//   - erc:exchange:getRate       渲染层主动拉取最新汇率（USD 锚定，可带 provider）
//   - erc:exchange:getCountries  渲染层主动拉取全部国家信息
//   - erc:exchange:rateUpdated   主进程定时刷新后向所有窗口广播（event channel）
//   - erc:config:get             读取汇率源地址/key 与刷新频率
//   - erc:config:set             保存配置（格式校验），即时重置定时器并立即拉取一次
//
// 调用方式：main.js 在 registerIpcHandlers 阶段调一次
//   registerErcController()
//   startRateScheduler()
//
// 单点调度的意义：避免多窗口（Home/FloatingHome）各自 setInterval 重复拉取
//   超出免费 API 月度配额；主进程唯一 timer，渲染层只订阅推送
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { fetchExchangeRate, fetchCountries, fetchCountriesWithCache, RATE_PROVIDERS, DEFAULT_RATE_PROVIDER } from './service.js'
import { getErcConfig, setErcConfig } from './configManager.js'

// 主进程记忆的当前汇率源：渲染层切换源时经 getRate 更新此处，
// 定时广播始终按该源拉取；重启后回落默认源（渲染层挂载时会再下发其持久化选择）
let currentProvider = DEFAULT_RATE_PROVIDER

// 定时刷新句柄：频率由配置驱动，保存配置后用 restartRateScheduler 即时重置
let refreshTimer = null

/**
 * 注册 ERC feature 的全部 IPC handlers
 */
export function registerErcController() {
  // 拉取最新汇率（以 USD 为锚定）
  // 参数 provider 为渲染层选择的数据源标识；合法则同步更新主进程当前源
  ipcMain.handle('erc:exchange:getRate', async (_event, provider) => {
    if (RATE_PROVIDERS.includes(provider)) {
      currentProvider = provider
    }
    return await fetchExchangeRate(currentProvider)
  })

  // 拉取全部国家信息（含币种代码、国旗、时区）
  // 走 fetchCountriesWithCache：未过期读本地缓存文件，过期/不存在/损坏调 API + 写文件
  //   maxAgeMs 用 ERC 配置的 refreshIntervalMin（与汇率同步频率一致，默认 30 分钟）
  //   API 失败 → 抛错给渲染层 catch，由 store.loadError 显示醒目错误提示（不返回旧数据兜底）
  ipcMain.handle('erc:exchange:getCountries', async () => {
    const maxAgeMs = getErcConfig().refreshIntervalMin * 60 * 1000
    return await fetchCountriesWithCache(maxAgeMs)
  })

  // 读取 ERC 配置（地址/key/刷新频率）
  ipcMain.handle('erc:config:get', () => {
    return getErcConfig()
  })

  // 保存 ERC 配置：
  //   格式校验通过即落盘（网络不通也不回滚，可能只是临时网络问题），
  //   随后即时重置刷新定时器，并立即按当前源拉取广播一次（让新地址/key 马上生效）。
  //   返回 { ok:false, error } 让渲染层区分"格式错误"与"网络错误"。
  ipcMain.handle('erc:config:set', async (_event, patch) => {
    let saved
    try {
      saved = setErcConfig(patch)
    } catch (e) {
      return { ok: false, stage: 'validate', error: e.message }
    }
    restartRateScheduler()
    let fetchError = null
    try {
      const res = await fetchExchangeRate(currentProvider)
      if (!res || res.result !== 'success') {
        fetchError = '汇率源返回异常，请检查地址与 Key'
      } else {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('erc:exchange:rateUpdated', res)
          }
        }
      }
    } catch (e) {
      fetchError = e?.message || '网络请求失败，请检查地址与 Key'
    }
    return { ok: !fetchError, stage: fetchError ? 'network' : null, error: fetchError, config: saved }
  })
}

/**
 * 拉取一次汇率并广播给所有窗口
 * 失败静默（保留上一次数据，符合"无 fallback data"约束）
 */
async function refreshAndBroadcast() {
  try {
    const res = await fetchExchangeRate(currentProvider)
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
 * （重）设定时刷新：间隔实时读配置（refreshIntervalMin 分钟，全局唯一）
 */
function restartRateScheduler() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  const minutes = getErcConfig().refreshIntervalMin
  refreshTimer = setInterval(refreshAndBroadcast, minutes * 60 * 1000)
}

/**
 * 启动汇率定时刷新调度器
 * 启动时立即拉一次（让冷启动尽快拿到最新数据），之后按配置间隔刷新
 */
export function startRateScheduler() {
  refreshAndBroadcast()
  restartRateScheduler()
}
