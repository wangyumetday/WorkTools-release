// ============================================================
// 悬浮窗管理器 + IPC 控制器
// 职责：创建/控制半透明置顶无边框的悬浮窗，支持 hover 展开/收缩
//        并注册 floating:* IPC handlers
//
// 窗口特性：
//   - transparent: true   半透明（配合渲染层 rgba 背景）
//   - frame: false        无边框
//   - alwaysOnTop: true   置顶
//   - skipTaskbar: true   不在任务栏占位
//   - resizable: true     frameless 无 OS resize 边框（用户无法拖边）；
//                          程序化 setBounds 需要它——resizable: false 在 Windows
//                          会把窗口尺寸锁死，setBounds 改高/宽被 clamp，展开无效
//   - backgroundColor: '#00000000'  透明窗口表面底色，消除圆角白边
//
// 三机制彻底解耦：
//   1. 拖拽移动：渲染层 mousedown → floating:dragStart/Stop IPC → 主进程
//      setInterval 轮询 screen.getCursorScreenPoint() 算 delta + setBounds。
//      不用 -webkit-app-region: drag（它会吞掉该区指针事件，与 hover 冲突：
//      鼠标滑过把手会触发 mouseleave → 误收缩）。自定义拖拽全条顶栏可拖，
//      且 mouseenter/mouseleave/mousedown 互不冲突。screen API 自动处理 DPI/多屏。
//   2. hover 展开/收缩：渲染层 mouseenter/mouseleave（DOM 坐标，恒正确）。
//      不用主进程 cursor 轮询——Electron 41.3+ frameless 透明窗口有
//      thickFrame HWND 外扩，getBounds() 与可见窗口偏移，轮询 hit-test 会
//      落到错误区域导致展开/收缩反复抖动。DOM 事件完全绕开该问题。
//      （来源：electron/electron #50332 thickFrame；#611 wontfix mouseleave）
//   3. 尺寸：两档 COLLAPSED 160x36（固定）↔ EXPANDED（默认 200x350，可被
//      用户拖边框改写并持久化到 userData/floating-window-size.json）。
//      animateResize 在两档间动画；用户改的展开态尺寸防抖写入文件，下次 expand 用它。
//
// 防护：
//   - isAnimating 互斥：动画中 expand/collapse 直接 return
//   - pinned 锁：主进程持有，pinned 时 collapseFloating 拒绝收缩
//   - ipcMain.handle 重复注册保护：注册前 removeHandler（避免热重载崩溃）
//
// IPC 命名空间：floating:*
//   - floating:open          打开悬浮窗（已存在则显示并置顶）
//   - floating:expand        展开到 EXPANDED 尺寸（renderer mouseenter 触发）
//   - floating:collapse      收缩到 COLLAPSED 尺寸（renderer mouseleave 3 秒后触发）
//   - floating:setOpacity    设置整窗透明度（0.1~1.0）
//   - floating:setZoom       设置整窗缩放因子（0.5~1.5）
//   - floating:close         关闭悬浮窗
//   - floating:togglePin     切换固定钉，返回新状态（true=已固定）
//   - floating:stateChange   主进程 → 渲染层推送（窗口打开/关闭状态）
// ============================================================

import { app, BrowserWindow, ipcMain, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 收起态尺寸（固定：打开时默认显示的小条，只含顶栏）
const COLLAPSED = { width: 190, height: 36 }
// 展开态默认尺寸（用户没拖改边框时用此值）
const DEFAULT_EXPANDED = { width: 220, height: 350 }
// 展开态尺寸：用户拖边框改写后从持久化文件读，否则用 DEFAULT_EXPANDED。
// 文件：userData/floating-window-size.json；删除该文件可恢复默认尺寸。
// getSizeFile() lazy 取路径（app.getPath 需 app 初始化后调用才稳）
function getSizeFile() {
  return path.join(app.getPath('userData'), 'floating-window-size.json')
}
let expandedSize = null  // lazy 初始化（首次 getExpandedSize 时加载）
// isExpanded：当前是否展开态（动画结束时更新，用于 resize 持久化过滤）
let isExpanded = false

// 读展开态持久化尺寸；文件不存在/非法时用 DEFAULT_EXPANDED
function loadExpandedSize() {
  try {
    const raw = fs.readFileSync(getSizeFile(), 'utf8')
    const obj = JSON.parse(raw)
    if (Number.isFinite(obj.width) && Number.isFinite(obj.height)
        && obj.width >= 150 && obj.height >= COLLAPSED.height + 100) {
      return { width: Math.round(obj.width), height: Math.round(obj.height) }
    }
  } catch { /* 文件不存在或解析失败 */ }
  return { ...DEFAULT_EXPANDED }
}
function getExpandedSize() {
  if (!expandedSize) expandedSize = loadExpandedSize()
  return expandedSize
}
// 防抖写入展开态尺寸（用户拖边框时 resize 频繁触发，400ms 防抖合并）
let persistTimer = null
function persistExpandedSize(w, h) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      fs.writeFileSync(getSizeFile(), JSON.stringify({ width: w, height: h }))
    } catch { /* ignore */ }
  }, 400)
}

// 整窗透明度边界（与渲染层滑块范围一致，越界自动 clamp）
const OPACITY_MIN = 0.1
const OPACITY_MAX = 1.0
const OPACITY_DEFAULT = 1.0

// 整窗缩放因子边界（渲染层滑块 0.5~1.5，越界自动 clamp）
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.5

// 悬浮窗实例引用
let floatingWindow = null
// 主窗口引用（用于 stateChange 推送）
let mainWindowRef = null

// 动画进行中标记（避免 hover 决策与动画冲突）
let isAnimating = false

// ==================== 创建窗口 ====================
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
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    webPreferences: {
      // 隔离会话分区：否则 setZoomFactor 会按 origin 写入共享 default session，
      // 导致悬浮窗缩放因子泄漏到同 session 的其他窗口（主窗口等）
      partition: 'persist:floating',
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false
    }
  })

  floatingWindow.on('closed', () => {
    isAnimating = false
    isExpanded = false
    pinned = false
    if (dragTimer) {
      clearInterval(dragTimer)
      dragTimer = null
    }
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    floatingWindow = null
    mainWindowRef?.webContents.send('floating:stateChange', { open: false })
  })

  // 用户拖边框改尺寸：非动画、展开态时防抖持久化到文件
  floatingWindow.on('resize', () => {
    if (!floatingWindow || floatingWindow.isDestroyed()) return
    if (isAnimating || !isExpanded) return
    const [w, h] = floatingWindow.getSize()
    if (h <= COLLAPSED.height + 20) return  // 太矮不持久化（防误触）
    const exp = getExpandedSize()
    if (w === exp.width && h === exp.height) return
    expandedSize = { width: w, height: h }   // 更新内存值，供下次 expand 用
    persistExpandedSize(w, h)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    floatingWindow.loadURL(process.env.ELECTRON_RENDERER_URL + '#/floating')
  } else {
    floatingWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'floating' })
  }

  floatingWindow.setOpacity(OPACITY_DEFAULT)
  floatingWindow.show()
  pinned = false
  mainWindowRef?.webContents.send('floating:stateChange', { open: true })
}

// ==================== 展开收缩动画 ====================
let resizeAnimTimer = null
const ANIM_DURATION = 200
const ANIM_FRAME = 16

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3)
}

function animateResize(x, y, from, to, onComplete) {
  if (resizeAnimTimer) {
    clearInterval(resizeAnimTimer)
    resizeAnimTimer = null
  }
  isAnimating = true
  const steps = Math.max(8, Math.round(ANIM_DURATION / ANIM_FRAME))
  let i = 0
  resizeAnimTimer = setInterval(() => {
    i++
    const t = Math.min(1, i / steps)
    const e = easeOutCubic(t)
    const w = Math.round(from.width + (to.width - from.width) * e)
    const h = Math.round(from.height + (to.height - from.height) * e)
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.setBounds({ x, y, width: w, height: h })
    }
    if (t >= 1) {
      clearInterval(resizeAnimTimer)
      resizeAnimTimer = null
      isAnimating = false
      onComplete?.()
    }
  }, ANIM_FRAME)
}

function expandFloating() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (isAnimating) return
  const [x, y] = floatingWindow.getPosition()
  animateResize(x, y, COLLAPSED, getExpandedSize(), () => { isExpanded = true })
}

function collapseFloating() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (isAnimating) return
  if (pinned) return
  const [x, y] = floatingWindow.getPosition()
  const [w, h] = floatingWindow.getSize()
  animateResize(x, y, { width: w, height: h }, COLLAPSED, () => { isExpanded = false })
}

// ==================== 自定义拖拽（渲染层 mousedown 触发） ====================
// 渲染层 mousedown → floating:dragStart → 记录起始 cursor + 窗口 bounds，
// setInterval 轮询当前 cursor 算 delta，setBounds 移动窗口；
// 渲染层 mouseup → floating:dragStop → clearInterval。
// screen.getCursorScreenPoint() 返回物理屏坐标，自动处理 DPI/多屏。
let dragTimer = null
let dragStartCursor = null
let dragStartBounds = null
const DRAG_FRAME = 16

function startDrag() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  dragStartCursor = screen.getCursorScreenPoint()
  dragStartBounds = floatingWindow.getBounds()
  dragTimer = setInterval(() => {
    if (!floatingWindow || floatingWindow.isDestroyed()) {
      clearInterval(dragTimer)
      dragTimer = null
      return
    }
    const cur = screen.getCursorScreenPoint()
    const nx = dragStartBounds.x + (cur.x - dragStartCursor.x)
    const ny = dragStartBounds.y + (cur.y - dragStartCursor.y)
    floatingWindow.setBounds({
      x: nx,
      y: ny,
      width: dragStartBounds.width,
      height: dragStartBounds.height
    })
  }, DRAG_FRAME)
}

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  dragStartCursor = null
  dragStartBounds = null
}

// ==================== 固定钉 ====================
// 主进程持有 source of truth，renderer 通过 togglePin 镜像用于图标显示
let pinned = false
function togglePin() {
  pinned = !pinned
  return pinned
}

// ==================== 透明度 ====================
function setOpacityFloating(value) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return false
  const num = Number(value)
  if (!Number.isFinite(num)) return false
  const clamped = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, num))
  floatingWindow.setOpacity(clamped)
  return true
}

// ==================== 缩放 ====================
// 用 webContents.setZoomFactor 做「缩放倍数」：CSS px 值不变，视口按比例缩放，
// 与 setBounds 增大物理 px 本质不同，符合「px 不变只是缩放」的需求。
function setZoomFloating(value) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return false
  const num = Number(value)
  if (!Number.isFinite(num)) return false
  floatingWindow.webContents.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, num)))
  return true
}

function closeFloating() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.close()
  }
}

// ==================== IPC 注册（含重复注册保护） ====================
// ipcMain.handle 重复注册同一 channel 会抛 "Attempted to register a second handler"，
// 热重载/多次调用会崩。注册前先 removeHandler 规避。
function handle(channel, fn) {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, fn)
}

export function registerFloatingController(mainWindow) {
  mainWindowRef = mainWindow
  handle('floating:open', () => openFloating())
  handle('floating:expand', () => expandFloating())
  handle('floating:collapse', () => collapseFloating())
  handle('floating:dragStart', () => startDrag())
  handle('floating:dragStop', () => stopDrag())
  handle('floating:setOpacity', (_e, value) => setOpacityFloating(value))
  handle('floating:setZoom', (_e, value) => setZoomFloating(value))
  handle('floating:close', () => closeFloating())
  handle('floating:togglePin', () => togglePin())

  mainWindow.on('closed', () => {
    if (resizeAnimTimer) {
      clearInterval(resizeAnimTimer)
      resizeAnimTimer = null
    }
    if (dragTimer) {
      clearInterval(dragTimer)
      dragTimer = null
    }
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    isAnimating = false
    isExpanded = false
    pinned = false
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.destroy()
    }
    floatingWindow = null
    mainWindowRef = null
  })
}
