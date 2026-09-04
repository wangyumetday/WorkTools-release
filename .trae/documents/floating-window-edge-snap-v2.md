# 悬浮窗贴边吸附 V2（收入边框 + hover 弹出）实现方案

## Context

前一版方案做"史莱姆贴边"形态，用户改了需求：吸附后窗口主体收入屏幕边框外（只露 12px），鼠标碰到露出条 → 弹出贴边展开，离开 1s → 收回边框。吸附模式下永久展开（废除 collapsed 双态），pinned 语义改为"是否自动收回边框"。普通模式仍维持现有 collapsed/expanded 双态。

目标：新增"吸附模式"作为窗口的第二模式，与普通模式互斥切换；不破坏现有 hover/拖动/pin/resize 持久化机制。

## 用户已对齐的 4 个决策

1. **拖到附近未松手时的"被吸引效果"** = 边框反光高亮（拖动接近边框时，悬浮窗朝边框那一侧画加粗青色光带，提示将吸附；不动窗口位置）
2. **退出吸附模式** = 拖走则退出（吸附态按下拖动 → 跟随鼠标 → 拖离边框 30px 外松手 → 恢复普通双态）
3. **"吸附模式废除双态"仅对吸附模式生效**，普通模式仍保留 collapsed/expanded
4. **露出条宽度** = 12px

## 设计原则

1. **硬切不动画**：snapIn/snapOut/enterSnap/exitSnap 都用 setBounds 硬切，平滑感由 `.floating-shell` 的 CSS `transition: width/height 0.15s, transform 0.15s` 兜底
2. **单一状态通道**：主进程持有 mode/dir/hidden/candidate 全部状态，通过 `floating:snapState` 一个 IPC 推送整包给渲染层
3. **滞回防边缘抖动**：进入吸附候选 30px，离开候选 60px
4. **跨屏 2 帧最小停留**：连续 2 帧候选才正式生效，防跨屏瞬间误触
5. **吸附模式下永远展开尺寸**：进入吸附模式时若当前是 collapsed，先 expand 到 expandedSize 再开始吸附逻辑
6. **不持久化吸附状态**：重启默认普通模式（简化）
7. **pinned 双语义**：普通模式下控制是否自动 collapse；吸附模式下控制是否自动 snapOut（收回边框）

## 涉及文件

- [electron/shared/floatingWindow.js](file:///d:/WorkTools-release/electron/shared/floatingWindow.js) — 主进程：吸附状态机、拖动扩展、IPC 注册、pinned 语义扩展
- [src/shell/FloatingShell.vue](file:///d:/WorkTools-release/src/shell/FloatingShell.vue) — 渲染层：状态镜像、mouseenter/mouseleave/dragStart 分支改造、边框反光 CSS
- [electron/preload.js](file:///d:/WorkTools-release/electron/preload.js) — 暴露 onSnapState 监听 + snapIn/snapOut invoke（带 disposer）

## 状态机

### 主进程状态变量（floatingWindow.js）

在现有 `isExpanded`/`pinned` 附近新增：

```js
let mode = 'normal'         // 'normal' | 'snapped'
let snapDir = null          // null | 'top' | 'left' | 'right'（吸附模式下的方向）
let snapHidden = false      // 吸附模式下是否处于"收入边框"状态
let snapCandidate = null    // 拖动中的临时候选方向（null | 'top'|'left'|'right'）
let snapCandidateFrames = 0 // 候选连续帧数（跨屏防误触）
const SNAP_THRESHOLD_ENTER = 30
const SNAP_THRESHOLD_EXIT = 60
const SNAP_HYSTERESIS_FRAMES = 2
const SNAP_REVEAL = 12       // 收入边框后露出的宽度
const SNAP_AUTOHIDE_MS = 1000  // 鼠标移走后多久自动收回边框
```

### 状态转移

```
普通模式（collapsed/expanded 双态 + pinned 控制 collapse）
  │
  │ 拖到边框 30px 内松手
  ▼
吸附模式（永远 expanded）─ hidden（收入边框，露 12px）⇄ expanded（贴边框展开）
  │                                  ▲                │
  │                                  │ mouseleave 1s  │ mouseenter
  │                                  │ (pinned 跳过)  │
  │                                  └────────────────┘
  │
  │ 按下拖动 → 跟随鼠标 → 拖离边框 30px 外松手
  ▼
普通模式（按窗口高度判断 collapsed/expanded）
```

## 实施步骤

### 1. 主进程常量与状态（floatingWindow.js）

按上文"状态变量"块新增。

### 2. 计算吸附位置的两个 helper

```js
// 计算吸附方向上的"贴边展开"位置（窗口主体在屏内，贴边框那侧紧贴边框）
function snapExpandedBounds(dir, display) {
  const wa = display.workArea
  const exp = getExpandedSize()
  let x, y
  if (dir === 'top') { x = ...; y = wa.y }                    // 顶贴顶向下展开
  else if (dir === 'left') { x = wa.x; y = ... }             // 左贴左向右展开
  else if (dir === 'right') { x = wa.x + wa.width - exp.width; y = ... }  // 右贴右向左展开
  return { x, y, width: exp.width, height: exp.height }
}

// 计算吸附方向上的"收入边框"位置（窗口主体移到屏外，露 12px）
function snapHiddenBounds(dir, display) {
  const wa = display.workArea
  const exp = getExpandedSize()
  let x, y
  if (dir === 'top') { x = ...; y = wa.y - exp.height + SNAP_REVEAL }   // 主体在屏上方外
  else if (dir === 'left') { x = wa.x - exp.width + SNAP_REVEAL; y = ... }  // 主体在屏左方外
  else if (dir === 'right') { x = wa.x + wa.width - SNAP_REVEAL; y = ... } // 主体在屏右方外
  return { x, y, width: exp.width, height: exp.height }
}
```

> x/y 横向/纵向居中保持：top 时窗口横向中心保持拖动落点附近，left/right 时纵向中心保持。具体计算见实施时，原则是不让窗口溢出当前屏 workArea 另一侧。

### 3. enterSnapMode(dir) / exitSnapMode() / snapIn() / snapOut()

```js
function enterSnapMode(dir) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  // 若当前 collapsed，先硬切到 expanded（吸附模式永远展开）
  if (!isExpanded) {
    const exp = getExpandedSize()
    const [x, y] = floatingWindow.getPosition()
    floatingWindow.setBounds({ x, y, width: exp.width, height: exp.height })
    isExpanded = true
  }
  mode = 'snapped'
  snapDir = dir
  snapHidden = true  // 默认进入即收入边框
  const bounds = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  floatingWindow.setBounds(snapHiddenBounds(dir, display))
  pushSnapState()
}

function exitSnapMode() {
  // 拖走时调用，恢复普通模式（按当前高度判断 collapsed/expanded）
  mode = 'normal'
  snapDir = null
  snapHidden = false
  const [h] = floatingWindow.getSize()
  isExpanded = h > COLLAPSED.height + 50  // 与渲染层 HEIGHT_THRESHOLD 对齐
  pushSnapState()
}

function snapIn() {  // 渲染层 mouseenter 调用
  if (mode !== 'snapped' || !snapDir || !snapHidden) return
  if (pinned) return  // pinned 时也允许弹出来；此守卫去掉。注释：pinned 控制 snapOut 不控制 snapIn
  snapHidden = false
  const bounds = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  floatingWindow.setBounds(snapExpandedBounds(snapDir, display))
  pushSnapState()
}

function snapOut() {  // 渲染层 mouseleave 1s 后调用
  if (mode !== 'snapped' || !snapDir || snapHidden) return
  if (pinned) return  // pinned 不自动收回
  snapHidden = true
  const bounds = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  floatingWindow.setBounds(snapHiddenBounds(snapDir, display))
  pushSnapState()
}

function pushSnapState() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('floating:snapState', {
      mode, dir: snapDir, hidden: snapHidden, candidate: snapCandidate
    })
  }
}
```

> 注意 `floatingWindow.webContents.send`，不是 `mainWindowRef?.webContents.send`（这是既有 `floating:stateChange` 推送目标的常见误解）。

### 4. 扩展 drag interval 加入吸附候选检测（startDrag 内）

在现有 16ms `setInterval` 的 `setBounds` 后追加：

```js
const wb = floatingWindow.getBounds()
const display = screen.getDisplayNearestPoint({ x: wb.x + wb.width/2, y: wb.y + wb.height/2 })
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
if (candidate === snapCandidate) snapCandidateFrames++
else { snapCandidate = candidate; snapCandidateFrames = 1 }
// 仅当候选正式生效（≥2 帧）且状态变化时推送给渲染层显示"边框反光"
const effective = snapCandidate && snapCandidateFrames >= SNAP_HYSTERESIS_FRAMES ? snapCandidate : null
// （渲染层用 effective 显示反光；不影响松手判断，松手时再读 snapCandidateFrames）
```

### 5. 改造 startDrag 头部处理吸附模式起拖

```js
function startDrag() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return
  if (isAnimating) return  // 守卫：动画中拒绝起拖
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  // 吸附模式下起拖：先硬切到展开尺寸并移到鼠标当前位置（不动画，回避与 drag interval 冲突）
  if (mode === 'snapped') {
    const cur = screen.getCursorScreenPoint()
    const exp = getExpandedSize()
    // 把窗口中心放到鼠标处（鼠标在窗口内任意位置都跟手）
    const nx = cur.x - Math.round(exp.width / 2)
    const ny = cur.y - Math.round(exp.height / 2)
    floatingWindow.setBounds({ x: nx, y: ny, width: exp.width, height: exp.height })
    // 临时退出吸附视觉（但仍处 mode='snapped'，等松手时决定 exitSnap 还是重新吸附）
    snapHidden = false
    pushSnapState()
  }
  dragStartCursor = screen.getCursorScreenPoint()
  dragStartBounds = floatingWindow.getBounds()
  dragTimer = setInterval(/* 原逻辑 + 步骤 4 候选检测 */, DRAG_FRAME)
}
```

### 6. 改造 stopDrag 处理吸附/退出落点

```js
function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  const wb = floatingWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: wb.x + wb.width/2, y: wb.y + wb.height/2 })
  const wa = display.workArea
  // 判断松手时是否处于边框 30px 内（含跨屏 2 帧最小停留验证）
  const inSnapZone = snapCandidate && snapCandidateFrames >= SNAP_HYSTERESIS_FRAMES
  if (mode === 'snapped') {
    // 吸附模式下松手：若拖离边框 30px 外 → 退出吸附模式；否则按 snapCandidate 重新吸附
    const draggedOut =
      (snapDir === 'top' && wb.y > wa.y + SNAP_THRESHOLD_EXIT) ||
      (snapDir === 'left' && wb.x > wa.x + SNAP_THRESHOLD_EXIT) ||
      (snapDir === 'right' && wb.x + wb.width < wa.x + wa.width - SNAP_THRESHOLD_EXIT)
    if (draggedOut && !inSnapZone) {
      exitSnapMode()  // 恢复普通模式，按当前高度判断 collapsed/expanded
    } else if (inSnapZone && snapCandidate !== snapDir) {
      // 切到新方向吸附
      snapDir = snapCandidate
      snapHidden = true
      floatingWindow.setBounds(snapHiddenBounds(snapDir, display))
      pushSnapState()
    } else {
      // 回到原方向吸附（仍 hidden）
      snapHidden = true
      floatingWindow.setBounds(snapHiddenBounds(snapDir, display))
      pushSnapState()
    }
  } else {
    // 普通模式下松手：若在边框候选区 → 进入吸附模式
    if (inSnapZone) {
      enterSnapMode(snapCandidate)
    }
  }
  snapCandidate = null
  snapCandidateFrames = 0
  dragStartCursor = null
  dragStartBounds = null
}
```

### 7. 修复 resize 持久化守卫

在 resize handler 头部加 `mode === 'snapped'` 短路（吸附模式下 setBounds 是程序化贴边，不应被当作用户拖改展开尺寸持久化）：

```js
floatingWindow.on('resize', () => {
  if (isAnimating || !isExpanded || mode === 'snapped') return  // 加 mode 守卫
  // ... 原防抖持久化逻辑
})
```

### 8. pinned 语义扩展（floatingWindow.js togglePin）

`togglePin` 本身不变，但语义在吸附模式下生效方式不同：

- 普通模式：pinned=true → `collapseFloating()` 内 `if (pinned) return` 守卫已有，挡住自动 collapse
- 吸附模式：pinned=true → `snapOut()` 内 `if (pinned) return` 守卫挡住自动收回边框

无需新代码，只是在 snapOut/snapIn 里加 pinned 守卫即可（步骤 3 已含）。

### 9. 注册 IPC（registerFloatingController 内）

```js
handle('floating:snapIn',  () => snapIn())
handle('floating:snapOut', () => snapOut())
```

> 不新增 `floating:enterSnap` / `floating:exitSnap` invoke——这两个由 stopDrag 内部根据落点自动触发，不由渲染层主动调用。

### 10. preload 暴露（electron/preload.js）

在 `floating` API 块内追加，监听器返回 disposer 防累积：

```js
// 监听吸附状态变化（主→渲染推送），返回 disposer
onSnapState: (callback) => {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on('floating:snapState', handler)
  return () => ipcRenderer.removeListener('floating:snapState', handler)
},
// 渲染层 mouseenter 触发弹出
snapIn:  () => ipcRenderer.invoke('floating:snapIn'),
// 渲染层 mouseleave 1s 后触发收回
snapOut: () => ipcRenderer.invoke('floating:snapOut'),
```

### 11. 渲染层状态镜像（FloatingShell.vue）

新增 ref + 监听 + 卸载清理：

```js
const snapMode = ref('normal')        // 'normal' | 'snapped'
const snapDir = ref(null)             // null | 'top'|'left'|'right'
const snapHidden = ref(false)
const snapCandidate = ref(null)       // 拖动中的反光提示方向
let snapStateDisposer = null

onMounted(() => {
  // ... 原有
  snapStateDisposer = api.floating.onSnapState((s) => {
    snapMode.value = s.mode
    snapDir.value = s.dir
    snapHidden.value = s.hidden
    snapCandidate.value = s.candidate
  })
})

onUnmounted(() => {
  // ... 原有
  snapStateDisposer?.()
})
```

### 12. 渲染层 mouseenter/mouseleave/dragStart 改造

```js
let snapAutoHideTimer = null
function clearSnapAutoHide() {
  if (snapAutoHideTimer) { clearTimeout(snapAutoHideTimer); snapAutoHideTimer = null }
}

function handleMouseEnter() {
  if (isDragging) return  // 守卫：拖拽中拒绝（修复既有 bug）
  clearCollapseTimer()
  clearSnapAutoHide()
  if (snapMode.value === 'snapped') {
    // 吸附模式：触发弹出
    if (snapHidden.value) api.floating.snapIn()
    return
  }
  if (isCollapsed.value) api.floating.expand()
}

function handleMouseLeave() {
  if (isDragging) return
  if (snapMode.value === 'snapped') {
    // 吸附模式：1s 后收回边框
    clearSnapAutoHide()
    snapAutoHideTimer = setTimeout(() => {
      snapAutoHideTimer = null
      if (snapMode.value === 'snapped' && !snapHidden.value) {
        api.floating.snapOut()
      }
    }, 1000)
    return
  }
  clearCollapseTimer()
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    if (!pinned.value && !isCollapsed.value) api.floating.collapse()
  }, 1200)
}

function handleDragStart(e) {
  if (e.button !== 0) return
  if (e.target.closest('button, input, .crow-del')) return
  isDragging = true
  clearCollapseTimer()
  clearSnapAutoHide()
  api.floating.dragStart()  // 主进程 startDrag 内会处理吸附模式起拖硬切
  window.addEventListener('mouseup', handleDragEnd, { once: true })
}
```

### 13. 模板根元素绑定 class

```html
<div
  class="floating-shell"
  :class="{
    'is-collapsed': isCollapsed,
    'is-snapped': snapMode === 'snapped',
    'is-snap-hidden': snapMode === 'snapped' && snapHidden,
    [`is-snap-${snapDir}`]: snapMode === 'snapped' && snapDir,
    [`is-near-${snapCandidate}`]: snapCandidate
  }"
  @mouseenter="handleMouseEnter"
  @mouseleave="handleMouseLeave"
>
```

### 14. 边框反光高亮 + 收入/弹出 CSS

```css
.floating-shell {
  /* 兜底硬切平滑感（主进程不动画，CSS 兜底） */
  transition: width 0.15s ease, height 0.15s ease;
}

/* ==================== 边框反光高亮（拖动中靠近边框时） ==================== */
/* 朝候选方向那一侧画加粗青色 inset 光带，模拟"边框反光"投射到窗口边缘 */
.floating-shell.is-near-top {
  box-shadow:
    inset 0 0 0 0 rgba(0, 255, 255, 0),
    inset 0 4px 8px -2px rgba(0, 255, 255, 0.55);  /* 朝顶边反光 */
}
.floating-shell.is-near-left {
  box-shadow:
    inset 4px 0 8px -2px rgba(0, 255, 255, 0.55),
    inset 0 0 0 0 rgba(0, 255, 255, 0);
}
.floating-shell.is-near-right {
  box-shadow:
    inset -4px 0 8px -2px rgba(0, 255, 255, 0.55),
    inset 0 0 0 0 rgba(0, 255, 255, 0);
}
/* 注意：原 .floating-shell 已有 inset 青色内阴影，is-near-* 需覆盖（不全替换） */
.floating-shell.is-near-top,
.floating-shell.is-near-left,
.floating-shell.is-near-right {
  box-shadow:
    inset 0px 0px 2px 1px rgba(0, 255, 255, 0.3),
    inset 0px 0px 2px 2px rgba(0, 255, 255, 0.2),
    var(--snap-glow, none);
}
.floating-shell.is-near-top   { --snap-glow: inset 0 4px 12px -2px rgba(0, 255, 255, 0.7); }
.floating-shell.is-near-left  { --snap-glow: inset 4px 0 12px -2px rgba(0, 255, 255, 0.7); }
.floating-shell.is-near-right { --snap-glow: inset -4px 0 12px -2px rgba(0, 255, 255, 0.7); }

/* ==================== 吸附模式：弹出态贴边 ==================== */
/* 弹出态 .floating-shell 视觉与普通展开一致，仅靠 setBounds 位置贴边 */
.floating-shell.is-snapped.is-snap-hidden:not(.is-collapsed) {
  /* 收入态：露出 12px 一条，drag-bar 内容隐藏（容器保留作 mousedown 承载） */
}
.floating-shell.is-snapped.is-snap-hidden .drag-bar > * {
  display: none;
}
.floating-shell.is-snapped.is-snap-hidden .floating-body {
  display: none;  /* 收入态主体在屏外，渲染层也藏掉省内存 */
}
/* 收入态露出 12px 的一条加粗青色光带，让用户能看到"边框上有东西" */
.floating-shell.is-snapped.is-snap-hidden {
  background: rgb(30, 30, 30);  /* 保持暗灰，反光由 inset 阴影表达 */
}
.floating-shell.is-snapped.is-snap-hidden.is-snap-top {
  box-shadow: inset 0 -2px 6px 1px rgba(0, 255, 255, 0.55);  /* 底边露出 12px 加亮 */
}
.floating-shell.is-snapped.is-snap-hidden.is-snap-left {
  box-shadow: inset -2px 0 6px 1px rgba(0, 255, 255, 0.55);  /* 右边露出 12px 加亮 */
}
.floating-shell.is-snapped.is-snap-hidden.is-snap-right {
  box-shadow: inset 2px 0 6px 1px rgba(0, 255, 255, 0.55);  /* 左边露出 12px 加亮 */
}
```

## 不做的项

- ❌ snapIn/snapOut/enterSnap/exitSnap 用 animateResize（用硬切回避 isAnimating 冲突）
- ❌ 持久化吸附状态（重启默认普通模式）
- ❌ 单独的 snap 视觉装饰（史莱姆呼吸、形变）—— 抓住"露出 12px + 反光"的极简视觉
- ❌ `floating:enterSnap` / `floating:exitSnap` invoke 通道（这两个由 stopDrag 自动触发）

## 验证清单

启动 `npm run dev` 后真实拖拽测试：

1. **进入吸附**：从普通模式拖悬浮窗到屏顶 30px 内 → 顶部出现青色反光带 → 松手 → 窗口滑到屏顶外，仅底边 12px 露出 + 青色光带
2. **左右吸附同上**：分别拖到屏左/右 30px 内 → 反光带在对应侧 → 松手 → 收入屏外只露 12px
3. **hover 弹出**：鼠标移到 12px 露出条 → 窗口立即滑入屏内，贴边框展开（顶吸附贴顶向下展开 350px）
4. **mouseleave 1s 收回**：弹出态下鼠标移出窗口 → 1s 后自动滑回屏外收入
5. **pinned 不自动收回**：吸附模式下点 pin → mouseleave 1s 不收回；再点 pin 取消 → 1s 后收回
6. **吸附模式直接拖走退出**：吸附态 mousedown → 窗口立即硬切到展开尺寸跟随鼠标 → 拖到屏中部松手 → 恢复普通双态（按当前高度判 collapsed/expanded）
7. **吸附模式切换方向**：top 吸附 → 拖到屏左 30px 内松手 → 切到 left 吸附
8. **滞回防抖**：拖到 30-60px 中间地带来回抖 → 不反复触发候选（松手时才定）
9. **跨屏不误触**：从主屏快速拖到副屏瞬间 → 不触发候选（2 帧停留保护）
10. **多显示器吸附**：拖到副屏边缘 → 在副屏吸附（不在主屏）
11. **持久化未污染**：吸附后查看 `userData/floating-window-size.json` → 仍是上次的展开尺寸，不是 12px 露出条尺寸
12. **普通模式既有 hover 未破坏**：collapsed → hover 仍展开；expanded → mouseleave 1200ms 仍收缩
13. **普通模式拖动未破坏**：从展开态直接拖到屏中部松手 → 窗口停在中部，不进入吸附

## 已知限制

- Electron 41.3+ frameless+transparent 的 thickFrame HWND 外扩约 8-16px 让 `getBounds` 与可见边略有偏差，吸附触发可能比预期晚 8px。若实测滞后，把 `SNAP_THRESHOLD_ENTER` 从 30 调到 40。
- Windows 透明窗口可以 setBounds 到屏外（验证清单第 1 步会确认这点；若 OS clamp 露出条为 0，需改用窗口透明度模拟收入）。
- Linux/Wayland 下 `screen.getCursorScreenPoint` 不工作，吸附功能失效（项目 Windows-only，不关心）。
