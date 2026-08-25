// ============================================================
// 悬浮窗管理器 + IPC 控制器
// 职责：创建/控制半透明置顶无边框的悬浮窗，支持展开/收缩尺寸切换
//        并注册 floating:* IPC handlers
//
// 窗口特性：
//   - transparent: true   半透明（配合渲染层 rgba 背景）
//   - frame: false        无边框（可拖动区域由渲染层 -webkit-app-region: drag 实现）
//   - alwaysOnTop: true   置顶
//   - skipTaskbar: true   不在任务栏占位
//   - resizable: false   固定尺寸（由 setBounds 切换，不允许用户拖拽边框改尺寸）
//
// 尺寸切换：
//   - collapsed: 80x80    收缩态，只显示一个图标
//   - expanded:  320x480  展开态，显示完整 ERC 操作界面
//   - 切换时保持窗口左上角位置不变（图标在左上角，展开向右下扩展）
//
// IPC 命名空间：floating:*
//   - floating:open        打开悬浮窗（已存在则显示并置顶）
//   - floating:expand      鼠标进入 → 展开尺寸
//   - floating:collapse     鼠标离开 → 收缩尺寸
//   - floating:close       关闭悬浮窗
//   - floating:stateChange 主进程 → 渲染层推送（窗口打开/关闭状态变化）
// ============================================================

import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 收缩/展开尺寸常量
const COLLAPSED = { width: 80, height: 80 }
const EXPANDED = { width: 320, height: 480 }

// 悬浮窗实例引用
let floatingWindow = null
// 主窗口引用（用于 stateChange 推送）
let mainWindowRef = null

// 创建并显示悬浮窗（已存在则显示并置顶）
function openFloating() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.show()
    floatingWindow.focus()
    return
  }
  floatingWindow = new BrowserWindow({
    width: COLLAPSED.width,
    height: COLLAPSED.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false
    }
  })

  // 悬浮窗关闭时清理引用 + 通知主窗口
  floatingWindow.on('closed', () => {
    floatingWindow = null
    mainWindowRef?.webContents.send('floating:stateChange', { open: false })
  })

  // 加载悬浮窗路由（#/floating → redirect 到 /floating/erc）
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    floatingWindow.loadURL(process.env.ELECTRON_RENDERER_URL + '#/floating')
  } else {
    floatingWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'floating' })
  }

  floatingWindow.show()
  mainWindowRef?.webContents.send('floating:stateChange', { open: true })
}

// 展开悬浮窗（保持左上角位置不变）
function expandFloating() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  const [x, y] = floatingWindow.getPosition()
  floatingWindow.setBounds({
    x, y,
    width: EXPANDED.width,
    height: EXPANDED.height
  })
}

// 收缩悬浮窗（保持左上角位置不变）
function collapseFloating() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  const [x, y] = floatingWindow.getPosition()
  floatingWindow.setBounds({
    x, y,
    width: COLLAPSED.width,
    height: COLLAPSED.height
  })
}

// 关闭悬浮窗
function closeFloating() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.close()
  }
}

/**
 * 注册 floating:* IPC handlers
 * @param {BrowserWindow} mainWindow 主窗口（用于 stateChange 推送）
 */
export function registerFloatingController(mainWindow) {
  mainWindowRef = mainWindow
  ipcMain.handle('floating:open', () => openFloating())
  ipcMain.handle('floating:expand', () => expandFloating())
  ipcMain.handle('floating:collapse', () => collapseFloating())
  ipcMain.handle('floating:close', () => closeFloating())

  // 主窗口关闭时，主动销毁悬浮窗
  //   否则悬浮窗会成为孤儿窗口继续飘在屏幕上（window-all-closed 不会触发，
  //   因为悬浮窗还开着，app 不退出，dev server 也不会停）
  //   设计决策：悬浮窗是主窗口的"附属窗口"，主窗口关了它就该关
  mainWindow.on('closed', () => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.destroy()
    }
    floatingWindow = null
    mainWindowRef = null
  })
}
