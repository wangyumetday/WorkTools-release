# 悬浮窗贴边吸附（史莱姆形态）实现方案

## Context

悬浮窗当前只有 collapsed(190×36) ↔ expanded(220×350) 两档，拖到屏幕边缘松手后窗口就停在边缘附近，没有"贴边收纳"机制。用户希望：拖动到屏幕上/左/右边框 30px 内时触发吸附，松手后窗口收缩成"一滩史莱姆"形态贴边（上吸附 80×32 横扁条，左/右吸附 32×80 纵扁条），吸附态 hover 自动恢复展开。

目标：在不破坏现有拖拽/hover/resize 持久化机制的前提下，新增"贴边吸附"作为第三档窗口状态。

## 设计原则

1. **unsnap 用硬切不动画**：回避 snapped 起拖时 unsnap 动画与 drag interval setBounds 互相覆盖的冲突（最高风险坑）。snapped→展开的平滑感由 `.floating-shell` 的 CSS `transition: width/height 0.15s` 兜底。
2. **snapped 是独立第三态**：`isExpanded=false`，避免污染现有 resize 持久化逻辑。
3. **滞回代替 debounce**：进入吸附候选 30px，离开必须拉远到 60px，避免边缘抖动反复触发。
4. **跨屏 2 帧最小停留**：避免跨屏瞬间 workArea 跳变误触发吸附。
5. **砍掉拖动预览动画**：拖到边缘但不松手时不做"挤压预览"，松手才吸附——省掉一半 IPC + 渲染层复杂度。如果实测体验不够，后续再加。
6. **不持久化吸附方向**：每次启动默认非吸附态（用户没明确要求持久化）。

## 涉及文件

- [electron/shared/floatingWindow.js](file:///d:/WorkTools-release/electron/shared/floatingWindow.js) — 主进程：新增 snap 状态机、扩展 drag interval、修 resize 守卫、注册 IPC
- [src/shell/FloatingShell.vue](file:///d:/WorkTools-release/src/shell/FloatingShell.vue) — 渲染层：镜像 snap 状态、改造 mouseenter/mouseleave 分支、史莱姆 CSS
- [electron/preload.js](file:///d:/WorkTools-release/electron/preload.js) — 暴露 onSnapped 监听 + unsnap invoke（带 disposer 清理）

## 实施步骤

### 1. 主进程常量与状态（floatingWindow.js）

在 `COLLAPSED`/`DEFAULT_EXPANDED` 常量区附近新增：

```js
const SNAP_TOP = { width: 80, height: 32 }    // 上吸附：横扁条贴顶
const SNAP_SIDE = { width: 32, height: 80 }   // 左/右吸附：纵扁条贴侧
const SNAP_THRESHOLD_ENTER = 30              // 进入吸附候选的距离
const SNAP_THRESHOLD_EXIT = 60               // 离开吸附候选的距离（滞回）
const SNAP_HYSTERESIS_FRAMES = 2             // 跨屏最小停留帧数（32ms）
```

在 `isExpanded`/`pinned` 等状态变量附近新增：

```js
let snapped = null        // null | 'top' | 'left' | 'right'，吸附态方向
let snapCandidate = null  // 拖动中的临时候选
let snapCandidateFrames = 0  // 候选连续帧数（用于跨屏防误触）
```

### 2. snapFloating(dir) 实现（硬切不动画）

```js
function snapFloating(dir) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (isAnimating) return
  const bounds = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  const wa = display.workArea
  let nx = bounds.x, ny = bounds.y, nw, nh
  if (dir === 'top') {
    nw = SNAP_TOP.width; nh = SNAP_TOP.height
    nx = bounds.x + Math.round((bounds.width - nw) / 2)  // 横向居中保持
    ny = wa.y                                            // 贴顶
  } else if (dir === 'left') {
    nw = SNAP_SIDE.width; nh = SNAP_SIDE.height
    nx = wa.x                                            // 贴左
    ny = bounds.y + Math.round((bounds.height - nh) / 2) // 纵向居中保持
  } else if (dir === 'right') {
    nw = SNAP_SIDE.width; nh = SNAP_SIDE.height
    nx = wa.x + wa.width - nw                           // 贴右
    ny = bounds.y + Math.round((bounds.height - nh) / 2)
  } else return
  floatingWindow.setBounds({ x: nx, y: ny, width: nw, height: nh })
  snapped = dir
  isExpanded = false  // 关键：snapped 既非展开也非收缩，置 false 防 resize 持久化污染
  if (!floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('floating:snapped', { dir })
  }
}
```

### 3. unsnapFloating() 实现（硬切 + 位置锚点）

恢复展开尺寸，按方向调整 x/y 让鼠标仍落在窗口内（避免 mouseleave 立即触发）：

```js
function unsnapFloating() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (isAnimating) return
  if (!snapped) return
  const bounds = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  const wa = display.workArea
  const exp = getExpandedSize()
  let nx, ny
  if (snapped === 'top') {
    nx = bounds.x + Math.round((bounds.width - exp.width) / 2)  // 横向居中
    nx = Math.max(wa.x, Math.min(nx, wa.x + wa.width - exp.width))
    ny = wa.y  // 仍贴顶向下展开
  } else if (snapped === 'left') {
    nx = wa.x  // 仍贴左向右展开
    ny = bounds.y + Math.round((bounds.height - exp.height) / 2)
    ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - exp.height))
  } else if (snapped === 'right') {
    // 向左展开，让鼠标仍落在窗口右 32px 内
    nx = wa.x + wa.width - exp.width
    nx = Math.max(wa.x, nx)
    ny = bounds.y + Math.round((bounds.height - exp.height) / 2)
    ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - exp.height))
  }
  floatingWindow.setBounds({ x: nx, y: ny, width: exp.width, height: exp.height })
  snapped = null
  isExpanded = true
  if (!floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('floating:snapped', { dir: null })
  }
}
```

### 4. 扩展 drag interval 加入吸附检测（startDrag 内）

在现有 16ms 轮询的 `setBounds` 后追加贴边检测。每帧：

```js
const wb = floatingWindow.getBounds()
const display = screen.getDisplayNearestPoint({ x: wb.x + Math.round(wb.width/2), y: wb.y + Math.round(wb.height/2) })
const wa = display.workArea
let candidate = null
if (wb.y <= wa.y + SNAP_THRESHOLD_ENTER) candidate = 'top'
else if (wb.x <= wa.x + SNAP_THRESHOLD_ENTER) candidate = 'left'
else if (wb.x + wb.width >= wa.x + wa.width - SNAP_THRESHOLD_ENTER) candidate = 'right'

if (candidate === snapCandidate) {
  snapCandidateFrames++
} else {
  snapCandidate = candidate
  snapCandidateFrames = 1
}
// 跨屏防误触：连续 SNAP_HYSTERESIS_FRAMES 帧才确认候选
// （此处不发 IPC，松手时才根据最终候选决定是否 snap）
```

> **滞回**：`candidate === null` 时若曾经吸附过，离开阈值用 60px。实现上记 `lastSnappedDirWhileDragging`，但本方案简化为松手时再判一次，不维护滞回状态——拖动中不发 IPC，无抖动风险，松手瞬间判断即可。

### 5. 改造 stopDrag 处理吸附落点

```js
function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  // 松手瞬间检查最终候选（连续 ≥2 帧的候选）
  if (snapCandidate && snapCandidateFrames >= SNAP_HYSTERESIS_FRAMES) {
    snapFloating(snapCandidate)
  }
  snapCandidate = null
  snapCandidateFrames = 0
  dragStartCursor = null
  dragStartBounds = null
}
```

### 6. startDrag 头部处理"已吸附则先硬切恢复"

避免 drag interval 用 snapped 尺寸做 dragStartBounds 与 unsnap 动画冲突：

```js
function startDrag() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (isAnimating) return  // 守卫：动画中拒绝起拖
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  // 若当前是吸附态，先硬切恢复展开尺寸 + 调整位置让窗口不溢屏且鼠标在内
  if (snapped) {
    unsnapFloating()  // 硬切，无动画，立即完成
  }
  dragStartCursor = screen.getCursorScreenPoint()
  dragStartBounds = floatingWindow.getBounds()  // 此时已是展开尺寸
  dragTimer = setInterval(/* 原逻辑 + 步骤 4 的吸附检测 */, DRAG_FRAME)
}
```

### 7. 修复 resize 持久化守卫（关键 bug 修复）

在 resize handler 头部加 `snapped` 短路（与 `isExpanded=false` 双保险）：

```js
floatingWindow.on('resize', () => {
  if (isAnimating || !isExpanded || snapped) return  // 加 snapped 守卫
  // ... 原防抖持久化逻辑
})
```

### 8. 注册 IPC

在 `registerFloatingController` 内追加：

```js
handle('floating:unsnap', () => unsnapFloating())
```

> 不新增 `floating:snap` invoke——snap 由 stopDrag 内部自动触发，不由渲染层主动调用。
> 主→渲染推送 `floating:snapped` 通过 `floatingWindow.webContents.send`（注意不是 `mainWindowRef`）。

### 9. preload 暴露（electron/preload.js）

在 `floating` API 块内追加，监听器返回 disposer 防止累积：

```js
// 监听吸附态变化（主→渲染推送，dir = null/'top'/'left'/'right'），返回 disposer
onSnapped: (callback) => {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on('floating:snapped', handler)
  return () => ipcRenderer.removeListener('floating:snapped', handler)
},
// 渲染层主动触发脱离吸附（hover 史莱姆时调用）
unsnap: () => ipcRenderer.invoke('floating:unsnap'),
```

### 10. 渲染层状态镜像与事件改造（FloatingShell.vue）

新增 ref 与监听：

```js
const snappedDir = ref(null)  // null | 'top' | 'let' | 'right'
let unsnapDisposer = null

onMounted(() => {
  // ... 原有
  unsnapDisposer = api.floating.onSnapped((data) => {
    snappedDir.value = data?.dir ?? null
  })
})

onUnmounted(() => {
  // ... 原有
  unsnapDisposer?.()
})
```

改造 mouseenter/mouseleave：

```js
function handleMouseEnter() {
  if (isDragging) return  // 守卫：拖拽中拒绝 expand（修复既有 bug）
  clearCollapseTimer()
  if (snappedDir.value) {
    api.floating.unnap()  // 吸附态优先 unsnap，不走 expand
    return
  }
  if (isCollapsed.value) {
    api.floating.expand()
  }
}

function handleMouseLeave() {
  if (isDragging) return
  if (snappedDir.value) return  // 吸附态显式短路，不靠 isCollapsed 间接保护
  clearCollapseTimer()
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    if (!pinned.value && !isCollapsed.value) {
      api.floating.collapse()
    }
  }, 1200)
}
```

### 11. 模板根元素绑定 snap class

```html
<div
  class="floating-shell"
  :class="{
    'is-collapsed': isCollapsed,
    'is-snapped': snappedDir,
    [`is-snapped-${snappedDir}`]: snappedDir
  }"
  @mouseenter="handleMouseEnter"
  @mouseleave="handleMouseLeave"
>
```

### 12. 史莱姆 CSS

```css
/* ==================== 史莱姆吸附态 ==================== */
/* snapped 时窗口物理尺寸由主进程 setBounds 控制（80×32 / 32×80），
   渲染层只负责视觉：drag-bar 内容隐藏（容器保留承载 mousedown），
   .floating-shell 用渐变 + 非对称圆角 + 高光模拟"一滩"贴边史莱姆。 */

.floating-shell.is-snapped {
  border-radius: 0;          /* 覆盖默认 12px，贴边侧由方向类单独扁平 */
  background: radial-gradient(ellipse at 30% 30%, rgba(99, 226, 183, 0.5), rgba(20, 50, 40, 0.95));
  box-shadow:
    inset 0 0 1px 1px rgba(0, 255, 255, 0.45),
    inset 0 0 4px 2px rgba(99, 226, 183, 0.25);
  animation: slime-breathe 2.4s ease-in-out infinite;
}

/* 上吸附：贴顶侧（top）扁平，底侧饱满圆 */
.floating-shell.is-snapped-top {
  border-radius: 0 0 50% 50% / 0 0 100% 100%;
}
/* 左吸附：左侧扁平，右侧饱满圆 */
.floating-shell.is-snapped-left {
  border-radius: 0 50% 50% 0 / 0 100% 100% 0;
}
/* 右吸附：右侧扁平，左侧饱满圆 */
.floating-shell.is-snapped-right {
  border-radius: 50% 0 0 50% / 100% 0 0 100%;
}

/* snapped 态 drag-bar：隐藏内容（grip/标题/按钮），保留容器作 mousedown 承载层 */
.floating-shell.is-snapped .drag-bar {
  border-bottom: none;
  background: transparent;
}
.floating-shell.is-snapped .drag-bar > * {
  display: none;
}

/* 史莱姆 idle 呼吸：scale 1.0 → 1.04 → 1.0，营造湿润生命感 */
@keyframes slime-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.04); }
}
```

> `.floating-shell` 顶部追加 `transition: width 0.15s, height 0.15s` 兜底主进程硬切的视觉过渡（主进程不动画，靠 CSS 缓动）。

## 不做的项

- ❌ 拖动中接近边缘的"挤压预览"动画（松手才吸附，简化）
- ❌ 吸附方向持久化（重启默认非吸附）
- ❌ `floating:edgeNear` IPC + 渲染层 is-near-* CSS（预览相关全砍）
- ❌ unsnap 用 animateResize（用硬切回避 isAnimating 冲突）
- ❌ 单独的 `floating:snap` invoke 通道（snap 由 stopDrag 内部触发）

## 验证清单

启动 `npm run dev` 后用真实拖拽测试：

1. **基础吸附**：拖悬浮窗到屏幕顶部 30px 内松手 → 窗口变成 80×32 史莱姆贴顶，有呼吸动画
2. **左右吸附**：分别拖到屏幕左/右 30px 内松手 → 变成 32×80 史莱姆贴侧
3. **滞回**：拖到 30-60px 中间地带来回抖动 → 不反复触发吸附（松手才定）
4. **hover 恢复**：鼠标移到史莱姆上 → 立即恢复展开尺寸 + 内容可见
5. **right 吸附恢复位置**：右吸附后 hover → 窗口向左展开（不溢屏），鼠标仍在窗口内
6. **吸附态直接拖走**：在史莱姆上 mousedown 拖动 → 窗口立即硬切到展开尺寸 + 跟手拖（无动画卡顿）
7. **多显示器**：拖到副屏边缘 → 在副屏吸附（不在主屏）
8. **跨屏不误触**：从主屏快速拖到副屏瞬间 → 不触发吸附（2 帧停留保护）
9. **持久化未污染**：吸附后查看 `userData/floating-window-size.json` → 仍是上次的展开尺寸，不是 80×32/32×80
10. **pinned 与 snap 共存**：pinned 状态下拖到边缘 → 仍能吸附；吸附后 hover 恢复 → pinned 不阻止恢复
11. **既有 hover 未破坏**：collapsed → hover 仍展开；expanded → mouseleave 1200ms 仍收缩
12. **既有拖动未破坏**：从展开态直接拖到屏幕中部松手 → 窗口停在中部，不吸附

## 已知限制

- Electron 41.3+ frameless+transparent 的 thickFrame HWND 外扩约 8-16px 让 `getBounds` 与可见边略有偏差，吸附触发可能比预期晚 8px。若实测体验滞后，把 `SNAP_THRESHOLD_ENTER` 从 30 调到 40。
- Linux/Wayland 下 `screen.getCursorScreenPoint` 不工作，整个吸附功能失效（项目 Windows-only，不关心）。
