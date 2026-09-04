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

// ==================== 贴边吸附常量 ====================
// 拖到屏幕边框 SNAP_THRESHOLD_ENTER 内 → 候选吸附；已候选后必须拉远到 SNAP_THRESHOLD_EXIT 才取消（滞回防边缘抖动）
const SNAP_THRESHOLD_ENTER = 60
const SNAP_THRESHOLD_EXIT = 120
// 候选必须连续 SNAP_HYSTERESIS_FRAMES 帧才正式生效（防跨屏瞬间 workArea 跳变误触）
const SNAP_HYSTERESIS_FRAMES = 2
// 收入边框后露出的宽度（屏外主体 + 4px 露出条）：刚好够鼠标 hover 触发，不至于完全看不见
const SNAP_REVEAL = 4

// 悬浮窗实例引用
let floatingWindow = null
// 主窗口引用（用于 stateChange 推送）
let mainWindowRef = null

// 动画进行中标记（避免 hover 决策与动画冲突）
let isAnimating = false

// 用户正在拖边改大小标记（OS resize 进行中）
// 期间 snapOut 一律拒绝，避免虚框跟鼠标走但窗口 bounds 未变时 cursor 守卫误判"已离开"
// will-resize 触发时置 true；resize 触发后 debounce 500ms 无新事件置 false
let isResizing = false
let resizeEndTimer = null

// ==================== 贴边吸附状态 ====================
// mode: 'normal'（collapsed/expanded 双态）| 'snapped'（永远 expanded，子态 hidden/expanded）
let mode = 'normal'
// snapDir: null | 'top' | 'left' | 'right'（吸附模式下的方向）
let snapDir = null
// snapHidden: 吸附模式下是否处于"收入边框"状态（true=主体在屏外只露 12px，false=贴边框展开）
let snapHidden = false
// snapCandidate: 拖动中的临时候选方向（null | 'top'|'left'|'right'）
let snapCandidate = null
// snapCandidateFrames: 候选连续帧数（跨屏防误触）
let snapCandidateFrames = 0

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
    // 重置吸附状态
    mode = 'normal'
    snapDir = null
    snapHidden = false
    snapCandidate = null
    snapCandidateFrames = 0
    // 重置拖边状态
    isResizing = false
    if (resizeEndTimer) {
      clearTimeout(resizeEndTimer)
      resizeEndTimer = null
    }
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

  // ==================== OS resize 监听：拖边期间屏蔽 snapOut 自动收回 ====================
  // 原因：Windows 拖边时显示虚框跟鼠标走，实际窗口 bounds 不变。鼠标已离开原 bounds
  //       但 OS 在 resize 预览阶段，cursor 守卫用 getBounds() 判断会误判"已离开"→ snapOut 收回。
  //       will-resize 在用户开始拖边时触发一次（设 isResizing=true）；
  //       resize 在拖动过程中和松手时触发（debounce 500ms 无新事件视为结束，设 isResizing=false）。
  floatingWindow.on('will-resize', (_event) => {
    // 普通模式 collapsed 态也会触发（resizable: false 时不会，但 collapsed 时 resizable=true）
    // 吸附模式 snapHidden 态 resizable=false 不会触发 will-resize
    isResizing = true
    if (resizeEndTimer) {
      clearTimeout(resizeEndTimer)
      resizeEndTimer = null
    }
  })

  // 用户拖边框改尺寸：非动画、展开态时防抖持久化到文件
  floatingWindow.on('resize', () => {
    if (!floatingWindow || floatingWindow.isDestroyed()) return
    // resize 期间持续重置 debounce timer；500ms 无新 resize 视为拖边结束
    isResizing = true
    if (resizeEndTimer) clearTimeout(resizeEndTimer)
    resizeEndTimer = setTimeout(() => {
      isResizing = false
      resizeEndTimer = null
    }, 500)
    // 加 mode === 'snapped' 守卫：吸附模式下 setBounds 是程序化贴边，
    // 不应被当作用户拖改展开尺寸持久化（否则 12px 露出条尺寸会污染 expandedSize）
    if (isAnimating || !isExpanded || mode === 'snapped') return
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

// 通用 bounds 动画：插值 x/y/w/h。from/to 都需含 x/y/width/height。
// 用于：collapse/expand（位置不变仅尺寸变）+ snap 收入/弹出（位置+尺寸变）。
function animateBounds(from, to, onComplete) {
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
    const x = Math.round(from.x + (to.x - from.x) * e)
    const y = Math.round(from.y + (to.y - from.y) * e)
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

// 旧 API 兼容：固定 x,y，仅动画 w,h（collapse/expand 用）
function animateResize(x, y, from, to, onComplete) {
  animateBounds(
    { x, y, width: from.width, height: from.height },
    { x, y, width: to.width, height: to.height },
    onComplete
  )
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

// ==================== 贴边吸附 ====================
// 吸附模式有两种子态：
//   - hidden（收入边框）：窗口主体在屏外，只露 SNAP_REVEAL(4px) 一条
//   - expanded（贴边展开）：窗口贴边框展开，主体在屏内
// 进入吸附模式后永远 expanded 尺寸（不再 collapsed）；退出后按高度判 collapsed/expanded。
// 单一推送通道 floating:snapState 整包传 mode/dir/hidden/candidate 给渲染层。

// 计算吸附方向上的"贴边展开"位置（窗口主体在屏内，贴边框那侧紧贴边框）
function snapExpandedBounds(dir, display) {
  const wa = display.workArea
  const exp = getExpandedSize()
  const cur = floatingWindow ? floatingWindow.getBounds() : { x: wa.x, y: wa.y }
  let x, y
  if (dir === 'top') {
    // 顶贴顶向下展开：保持横向位置，clamp 到屏内
    x = cur.x
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - exp.width))
    y = wa.y
  } else if (dir === 'left') {
    x = wa.x
    y = cur.y
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - exp.height))
  } else if (dir === 'right') {
    x = wa.x + wa.width - exp.width
    y = cur.y
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - exp.height))
  }
  return { x, y, width: exp.width, height: exp.height }
}

// 计算吸附方向上的"收入边框"位置（窗口主体移到屏外，露 SNAP_REVEAL px）
function snapHiddenBounds(dir, display) {
  const wa = display.workArea
  const exp = getExpandedSize()
  const cur = floatingWindow ? floatingWindow.getBounds() : { x: wa.x, y: wa.y }
  let x, y
  if (dir === 'top') {
    // 主体在屏上方外，底边露出 SNAP_REVEAL(4px)
    x = cur.x
    x = Math.max(wa.x - exp.width + SNAP_REVEAL, Math.min(x, wa.x + wa.width - SNAP_REVEAL))
    y = wa.y - exp.height + SNAP_REVEAL
  } else if (dir === 'left') {
    x = wa.x - exp.width + SNAP_REVEAL
    y = cur.y
    y = Math.max(wa.y - exp.height + SNAP_REVEAL, Math.min(y, wa.y + wa.height - SNAP_REVEAL))
  } else if (dir === 'right') {
    x = wa.x + wa.width - SNAP_REVEAL
    y = cur.y
    y = Math.max(wa.y - exp.height + SNAP_REVEAL, Math.min(y, wa.y + wa.height - SNAP_REVEAL))
  }
  return { x, y, width: exp.width, height: exp.height }
}

// 主→渲染推送吸附状态整包
function pushSnapState() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('floating:snapState', {
      mode, dir: snapDir, hidden: snapHidden, candidate: snapCandidate
    })
  }
}

// 进入吸附模式（拖到边框 30px 内松手时调用）
function enterSnapMode(dir) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (isAnimating) return  // 防止动画中重入
  // 若当前 collapsed，先硬切到 expanded（吸附模式永远 expanded）
  if (!isExpanded) {
    const exp = getExpandedSize()
    const [x, y] = floatingWindow.getPosition()
    floatingWindow.setBounds({ x, y, width: exp.width, height: exp.height })
    isExpanded = true
  }
  mode = 'snapped'
  snapDir = dir
  // snapHidden 在动画结束后才设 true（动画期间内容跟滑出屏外，更自然）
  const from = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: from.x, y: from.y })
  const to = snapHiddenBounds(dir, display)
  pushSnapState()  // 立即推送 mode/dir（snapHidden=false）
  animateBounds(from, to, () => {
    snapHidden = true
    // 禁用 resizable：移除 Windows frame:false 窗口边缘 4-5px 不可见 OS resize 把手，
    // 否则鼠标 hover 4px 露出条会被 OS resize 拦截 → renderer mouseenter 不触发 → 不弹出
    floatingWindow.setResizable(false)
    pushSnapState()
  })
}

// 退出吸附模式（拖走时调用，恢复普通模式）
function exitSnapMode() {
  // 恢复 resizable：snapHidden 期间被禁用，需在拖拽/普通模式前恢复，否则 setBounds 被 clamp
  floatingWindow.setResizable(true)
  mode = 'normal'
  snapDir = null
  snapHidden = false
  const [h] = floatingWindow.getSize()
  isExpanded = h > COLLAPSED.height + 50  // 与渲染层 HEIGHT_THRESHOLD 对齐
  pushSnapState()
}

// 渲染层 mouseenter 调用：从收入态弹出来（贴边展开）+ 动画
function snapIn() {
  if (mode !== 'snapped' || !snapDir || !snapHidden) return
  if (isAnimating) return
  // pinned 不阻止 snapIn（pinned 控制 snapOut 不控制 snapIn）
  // 启用 resizable，否则动画中 setBounds 会被 Windows clamp
  floatingWindow.setResizable(true)
  const from = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: from.x, y: from.y })
  const to = snapExpandedBounds(snapDir, display)
  // 动画期间保持 snapHidden=true（空壳滑出，内容不显示）
  // 动画结束切 snapHidden=false（内容出现）
  // 弹出态保持 resizable=true：让用户能拖边改大小。
  //  副作用：窗口边缘 ~5px OS resize 把手会吞 mouseenter/mouseleave，
  //   误触发 snapOut 自动收回——由 snapOut 内的 cursor 守卫拦截。
  animateBounds(from, to, () => {
    snapHidden = false
    pushSnapState()
  })
}

// 渲染层 mouseleave 1s 后调用：从弹出来收回边框 + 动画
// 返回 true 表示已开始收回动画；false 表示被 cursor 守卫拒绝（鼠标仍在窗口边缘把手区）
function snapOut() {
  if (mode !== 'snapped' || !snapDir || snapHidden) return false
  if (pinned) return false  // pinned 不自动收回
  if (isAnimating) return false
  if (isResizing) return false  // 用户在拖边改大小，虚框跟鼠标走但 bounds 未变，一律拒绝
  // cursor 守卫：鼠标仍在窗口 bounds（含 ~6px OS resize 把手外延）内时拒绝收回。
  // 解决 frameless transparent 窗口 resizable:true 时 thickFrame 外扩把手吞 mouseleave
  // 导致的误触发问题。鼠标真移出窗口外才执行 snapOut。
  const PAD = 8  // OS resize 把手宽度（实测 ~5-6px，加安全边）
  const cursor = screen.getCursorScreenPoint()
  const b = floatingWindow.getBounds()
  const stillInside =
    cursor.x >= b.x - PAD && cursor.x <= b.x + b.width + PAD &&
    cursor.y >= b.y - PAD && cursor.y <= b.y + b.height + PAD
  if (stillInside) return false
  const from = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: from.x, y: from.y })
  const to = snapHiddenBounds(snapDir, display)
  // 动画期间保持 snapHidden=false（内容跟滑出屏外）
  // 动画结束切 snapHidden=true（内容隐藏）+ 禁用 resizable 防 OS resize 把手吞 hover
  animateBounds(from, to, () => {
    snapHidden = true
    floatingWindow.setResizable(false)
    pushSnapState()
  })
  return true
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
  // 取消正在进行的动画（包括 snap 动画），让 drag 立即接管
  // 不再用 isAnimating 拒绝起拖——用户拖拽应当能随时打断动画
  if (resizeAnimTimer) {
    clearInterval(resizeAnimTimer)
    resizeAnimTimer = null
    isAnimating = false
  }
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  // 吸附模式下起拖：保持窗口当前位置不动，只确保处于展开态。
  // 拖拽 interval 是 delta 增量式（dragStartBounds + 光标位移），按住窗口任意点都天然跟手，
  // 绝不能把窗口中心对齐到光标——那会让按住顶栏拖动时窗口跳半身高。
  if (mode === 'snapped') {
    // 启用 resizable：snapHidden 期间被禁用，否则 setBounds 会被 Windows clamp
    floatingWindow.setResizable(true)
    if (snapHidden) {
      // 竞态兜底：hover→snapIn 动画未完成时就按下了（极少数情况）。
      // 立即硬切到贴边展开位置（不动画，drag 马上接管），光标处正好落在窗口拖把区域附近
      const b = floatingWindow.getBounds()
      const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y })
      floatingWindow.setBounds(snapExpandedBounds(snapDir, display))
      snapHidden = false
      pushSnapState()
    }
    // 临时退出吸附视觉（仍处 mode='snapped'，等松手时决定 exitSnap 还是重新吸附）
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
    // 贴边吸附候选检测：每帧检查窗口相对屏幕 workArea 的位置
    const wb = floatingWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: wb.x + Math.round(wb.width / 2), y: wb.y + Math.round(wb.height / 2) })
    const wa = display.workArea
    let candidate = null
    if (wb.y <= wa.y + SNAP_THRESHOLD_ENTER) candidate = 'top'
    else if (wb.x <= wa.x + SNAP_THRESHOLD_ENTER) candidate = 'left'
    else if (wb.x + wb.width >= wa.x + wa.width - SNAP_THRESHOLD_ENTER) candidate = 'right'
    // 滞回：已进入候选后，必须拉远到 SNAP_THRESHOLD_EXIT 才取消
    if (!candidate && snapCandidate) {
      if (snapCandidate === 'top' && wb.y > wa.y + SNAP_THRESHOLD_EXIT) candidate = null
      else if (snapCandidate === 'left' && wb.x > wa.x + SNAP_THRESHOLD_EXIT) candidate = null
      else if (snapCandidate === 'right' && wb.x + wb.width < wa.x + wa.width - SNAP_THRESHOLD_EXIT) candidate = null
      else candidate = snapCandidate  // 仍在滞回带内，保持
    }
    if (candidate === snapCandidate) {
      snapCandidateFrames++
    } else {
      snapCandidate = candidate
      snapCandidateFrames = 1
    }
    // 候选正式生效（≥2 帧）才推送给渲染层显示"边框反光"
    const effective = snapCandidate && snapCandidateFrames >= SNAP_HYSTERESIS_FRAMES ? snapCandidate : null
    // 只在 effective 变化时推送（避免 16ms 一次 IPC 风暴）
    if (effective !== lastEffectiveCandidate) {
      lastEffectiveCandidate = effective
      // candidate 字段用 effective 推送，让渲染层只对正式生效的候选显示反光
      const prevCandidate = snapCandidate
      snapCandidate = effective
      pushSnapState()
      snapCandidate = prevCandidate
    }
  }, DRAG_FRAME)
}

// 记录上一次推送的"正式生效候选"，避免每帧 IPC 风暴
let lastEffectiveCandidate = null

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    dragStartCursor = null
    dragStartBounds = null
    snapCandidate = null
    snapCandidateFrames = 0
    return
  }
  const wb = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: wb.x + Math.round(wb.width / 2), y: wb.y + Math.round(wb.height / 2) })
  const wa = display.workArea
  // 松手时判断是否处于边框候选区（含跨屏 2 帧最小停留验证）
  const inSnapZone = snapCandidate && snapCandidateFrames >= SNAP_HYSTERESIS_FRAMES
  if (mode === 'snapped') {
    // 吸附模式下松手：若拖离边框 SNAP_THRESHOLD_EXIT 外且不在新候选区 → 退出吸附模式
    const draggedOut =
      (snapDir === 'top' && wb.y > wa.y + SNAP_THRESHOLD_EXIT) ||
      (snapDir === 'left' && wb.x > wa.x + SNAP_THRESHOLD_EXIT) ||
      (snapDir === 'right' && wb.x + wb.width < wa.x + wa.width - SNAP_THRESHOLD_EXIT)
    if (draggedOut && !inSnapZone) {
      exitSnapMode()  // 恢复普通模式，按当前高度判断 collapsed/expanded
    } else {
      // 切到新方向吸附 或 回到原方向吸附：都动画滑到 snapHiddenBounds
      // 动画期间保持 snapHidden=false（内容跟滑出屏外），动画结束才切 true + 禁用 resizable
      if (inSnapZone && snapCandidate !== snapDir) {
        snapDir = snapCandidate
      }
      const from = floatingWindow.getBounds()
      const to = snapHiddenBounds(snapDir, display)
      animateBounds(from, to, () => {
        snapHidden = true
        floatingWindow.setResizable(false)
        pushSnapState()
      })
    }
  } else {
    // 普通模式下松手：若在边框候选区 → 进入吸附模式（带动画）
    if (inSnapZone) {
      enterSnapMode(snapCandidate)
    }
  }
  // 清空候选（用 null 推送一次让渲染层取消反光）
  snapCandidate = null
  snapCandidateFrames = 0
  lastEffectiveCandidate = null
  pushSnapState()
  dragStartCursor = null
  dragStartBounds = null
}

// ==================== 固定钉 ====================
// 主进程持有 source of truth，renderer 通过 togglePin 镜像用于图标显示
let pinned = false
// togglePin 双模式语义：
//   - 普通态：仅切换状态，副作用在 collapse 时生效（pinned 拒绝收缩）
//   - 吸附态：切到钉住时若当前 snapHidden=true（收入态）立即 snapIn 弹出来，
//     因为「钉住=留边框上」与 snapHidden=true 矛盾；
//     切到未钉时不主动 snapOut（保留展开态，等下次 mouseleave 1s 后自动收回）
function togglePin() {
  pinned = !pinned
  // 吸附态副作用：钉住立即弹出来（带动画）
  if (pinned && mode === 'snapped' && snapHidden) {
    if (isAnimating) {
      // 动画中：直接改目标——动画完成后会被新的 snapIn 推进
      // 简单处理：清掉当前动画，让下面的 animateBounds 接管
      if (resizeAnimTimer) {
        clearInterval(resizeAnimTimer)
        resizeAnimTimer = null
        isAnimating = false
      }
    }
    // 启用 resizable：snapHidden 期间被禁用，否则 setBounds 会被 Windows clamp
    floatingWindow.setResizable(true)
    const from = floatingWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: from.x, y: from.y })
    const to = snapExpandedBounds(snapDir, display)
    // 动画期间保持 snapHidden=true，结束才切 false（与 snapIn 一致：空壳滑出，内容到位后出现）
    // 弹出态保持 resizable=true（同 snapIn，让用户能拖边改大小；mouseleave 误触发由 snapOut 守卫拦截）
    animateBounds(from, to, () => {
      snapHidden = false
      pushSnapState()
    })
  }
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
  // 贴边吸附：渲染层 mouseenter 调 snapIn 弹出，mouseleave 1s 后调 snapOut 收回
  // 进入/退出吸附模式由 stopDrag 内部按落点自动触发，不暴露 invoke
  handle('floating:snapIn', () => snapIn())
  handle('floating:snapOut', () => snapOut())

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
    // 重置吸附状态
    mode = 'normal'
    snapDir = null
    snapHidden = false
    snapCandidate = null
    snapCandidateFrames = 0
    lastEffectiveCandidate = null
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.destroy()
    }
    floatingWindow = null
    mainWindowRef = null
  })
}
