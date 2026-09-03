<!-- ============================================================
     FloatingShell.vue - 悬浮窗壳
     职责：
       - 顶部 drag bar（标题 + pin + close），收起/展开两态共用
       - 底部控制条：缩放滑块（api.floating.setZoom，0.5~1.5）+ 透明度滑块
         （api.floating.setOpacity），均 localStorage 持久化
       - hover 展开/收缩：渲染层 mouseenter/mouseleave（DOM 坐标恒正确，绕开
       Electron 41.3+ frameless 透明窗口 thickFrame HWND 外扩导致的坐标偏移）
           * mouseenter → 立即 expand（清掉待收缩定时器）
           * mouseleave → 300ms 后 collapse（pinned / 拖拽中 跳过）
       - 拖拽移动：自定义 DOM 拖拽（mousedown 起拖 → IPC → 主进程轮询 cursor
         + setBounds）。不用 -webkit-app-region: drag——它会吞掉该区指针事件，
         鼠标滑过把手会触发 mouseleave 导致窗口误收缩。全条顶栏都是普通 DOM，
         mouseenter/mouseleave/mousedown 互不冲突，整条顶栏既能拖又能 hover
       - 本组件根据窗口尺寸（resize 事件）推断 isCollapsed 决定内容显隐，
         并处理 pin/close/opacity 三个交互
     设计要点：
       - 拖拽中（isDragging）屏蔽 mouseleave 收缩，避免窗口移动时边界抖动触发误收缩
       - mousedown 命中按钮/输入等交互元素时不启动拖拽，保证 click 正常
       - pinned 状态由主进程持有 source of truth，本组件仅镜像用于图标显示
     ============================================================ -->

<template>
  <div class="floating-shell" @mouseenter="handleMouseEnter" @mouseleave="handleMouseLeave">
    <!-- ============ 顶部 drag bar（mousedown 自定义拖拽，整条可拖） ============ -->
    <div class="drag-bar" @mousedown="handleDragStart">
      <div class="drag-left">
        <svg class="ico ico-grip" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>
          <circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>
          <circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>
        </svg>
        <span class="drag-title">ERC 汇率换算</span>
      </div>
      <div class="drag-right">
        <button
          class="icon-btn"
          :class="{ 'is-pinned': pinned }"
          :title="pinned ? '已固定，点击解除' : '点击固定，悬浮窗不再收起'"
          @click="togglePin"
        >
          <svg class="ico" viewBox="0 0 24 24" :fill="pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 17v5"/>
            <path d="M9 10.76a2 2 0 0 1 .99-1.74l7.79-4.42a.5.5 0 0 1 .72.66l-3.62 5.15a2 2 0 0 0-.31 1.07V16a2 2 0 0 1-2 2h-3.06a2 2 0 0 1-2-2v-2.42a2 2 0 0 0-.31-1.07L3.15 7.48a.5.5 0 0 1 .72-.66l7.79 4.42A2 2 0 0 1 12 10.76"/>
          </svg>
        </button>
        <button
          class="icon-btn"
          title="关闭悬浮窗"
          @click="handleClose"
        >
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ============ 展开态：内容 + 控制条。
       始终渲染 DOM，v-if 会 destroy/re-create router-view 导致 FloatingHome
       状态被重置（srcRaw/cnyVal 等）。改为始终存在 + overflow:hidden 裁掉超出。 -->
    <div class="floating-body" :class="{ 'is-collapsed': isCollapsed }">
      <div class="floating-content">
        <router-view />
      </div>
      <div class="zoom-bar">
        <span class="zoom-label">缩放</span>
        <input
          class="zoom-slider"
          type="range"
          :min="0.5"
          :max="1.5"
          :step="0.05"
          :value="zoom"
          @input="handleZoom"
        />
        <span class="zoom-value">{{ zoom.toFixed(2) }}x</span>
      </div>
      <div class="opacity-bar">
        <span class="opacity-label">透明度</span>
        <input
          class="opacity-slider"
          type="range"
          :min="0.1"
          :max="1"
          :step="0.05"
          :value="opacity"
          @input="handleOpacity"
        />
        <span class="opacity-value">{{ Math.round(opacity * 100) }}%</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import api from '@/shared/api.js'

// 是否处于收起态（根据窗口尺寸推断：主进程 setBounds 改尺寸 → resize 事件 → updateMode）
const isCollapsed = ref(true)
// pin 固定钉（主进程持有 source of truth，此处仅镜像用于图标显示）
const pinned = ref(false)
// 整窗透明度
const opacity = ref(1.0)
// 整窗缩放因子（setZoomFactor：CSS px 不变、视口按比例缩放）
const zoom = ref(1.0)

const OPACITY_KEY = 'floating:opacity'
const OPACITY_MIN = 0.1
const OPACITY_MAX = 1.0

const ZOOM_KEY = 'floating:zoom'
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.5

// 收起/展开高度阈值（收起态 36，展开态 ≥200；用 100 区分两态）。
// 用高度而非宽度：用户拖边框改宽度后，宽度不再可靠区分两态；高度稳定。
const HEIGHT_THRESHOLD = 100
// 收缩定时器句柄（mouseleave 后 3 秒延迟收缩；mouseenter 立即取消，避免抖动）
let collapseTimer = null
function clearCollapseTimer() {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
}

// 根据窗口高度更新收起/展开态。
// setZoomFactor 会按缩放因子缩小 CSS 视口（innerHeight = 物理高度 / 缩放），
// 需乘回 zoom 还原物理高度，否则缩放后阈值会误判收起/展开。
function updateMode() {
  const physicalHeight = window.innerHeight * zoom.value
  isCollapsed.value = physicalHeight <= HEIGHT_THRESHOLD
}

// mouseenter：立即展开（清掉待收缩定时器，避免重入抖动）。
// isCollapsed 守卫避免已展开态重复发 IPC。
function handleMouseEnter() {
  clearCollapseTimer()
  if (isCollapsed.value) {
    api.floating.expand()
  }
}

// mouseleave：3 秒后收缩（pinned / 拖拽中 跳过）。
// 3 秒延迟容许鼠标短暂滑出又滑回（切窗口/误移）；mouseenter 会清掉待收缩定时器。
function handleMouseLeave() {
  if (isDragging) return
  clearCollapseTimer()
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    if (!pinned.value && !isCollapsed.value) {
      api.floating.collapse()
    }
  }, 1200)
}

// ==================== 自定义拖拽（不用 -webkit-app-region: drag） ====================
// isDragging：拖拽进行中标记，用于屏蔽 mouseleave 误收缩
let isDragging = false
// 起拖：命中交互元素（按钮/输入/删除钮）则放行 click，不拖拽；否则发起拖拽
function handleDragStart(e) {
  if (e.button !== 0) return                          // 仅左键
  if (e.target.closest('button, input, .crow-del')) return  // 交互元素放行
  isDragging = true
  clearCollapseTimer()                                // 起拖清掉待收缩，避免拖拽中收缩
  api.floating.dragStart()
  // mouseup 可能在 drag-bar 外松开，用 window 监听 + once 自动清理
  window.addEventListener('mouseup', handleDragEnd, { once: true })
}
// 松拖：通知主进程停止 cursor 轮询
function handleDragEnd() {
  isDragging = false
  api.floating.dragStop()
}

function togglePin() {
  // 切换由主进程持有，返回新状态后镜像到本地 ref
  api.floating.togglePin().then((v) => { pinned.value = !!v })
}

function handleClose() {
  api.floating.close()
}

// ==================== 透明度 ====================
function handleOpacity(e) {
  const v = parseFloat(e.target.value)
  if (!Number.isFinite(v)) return
  const clamped = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, v))
  opacity.value = clamped
  localStorage.setItem(OPACITY_KEY, String(clamped))
  api.floating.setOpacity(clamped)
}

function loadOpacity() {
  const saved = localStorage.getItem(OPACITY_KEY)
  if (!saved) return
  const n = parseFloat(saved)
  if (Number.isFinite(n)) {
    opacity.value = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, n))
  }
}

// ==================== 缩放 ====================
function handleZoom(e) {
  const v = parseFloat(e.target.value)
  if (!Number.isFinite(v)) return
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))
  zoom.value = clamped
  localStorage.setItem(ZOOM_KEY, String(clamped))
  api.floating.setZoom(clamped)
  updateMode()  // setZoomFactor 改变 CSS 视口，若不重算会误判收起/展开
}

function loadZoom() {
  const saved = localStorage.getItem(ZOOM_KEY)
  if (!saved) return
  const n = parseFloat(saved)
  if (Number.isFinite(n)) {
    zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n))
  }
}

onMounted(() => {
  loadOpacity()
  loadZoom()
  api.floating.setOpacity(opacity.value)
  api.floating.setZoom(zoom.value)
  updateMode()
  window.addEventListener('resize', updateMode)
})

onUnmounted(() => {
  clearCollapseTimer()
  window.removeEventListener('mouseup', handleDragEnd)
  if (isDragging) {
    isDragging = false
    api.floating.dragStop()
  }
  window.removeEventListener('resize', updateMode)
})
</script>

<style scoped>
/* 壳层：撑满窗口，半透明暗色背景。
   边缘发光用 inset 内阴影：窗口 transparent + 壳层 100vh 撑满，正向（外）
   box-shadow 会画在窗口物理边界外被 Chromium 裁掉看不见；inset 画在壳层内侧、
   沿圆角边缘，稳定可见且不占盒模型（无需 border/box-sizing，零布局影响）。
   青色 #00ffff 与深灰背景高对比，让悬浮窗（尤其收起态小条）在桌面上易被发现。 */
.floating-shell {
  width: 100%;
  height: 100vh;
  background: rgb(30, 30, 30);
  border-radius: 12px;
  overflow: hidden;
  color: #fff;
  display: flex;
  flex-direction: column;
  position: relative;
  box-shadow:
    inset 0px 0px 2px 1px rgba(0, 255, 255, 0.4),
    inset 0px 0px 2px 4px rgba(0, 255, 255, 0.2);
}

/* ==================== drag bar ==================== */
/* 自定义 DOM 拖拽：mousedown 起拖 → IPC → 主进程轮询 cursor + setBounds。
   完全不用 -webkit-app-region: drag（它会吞掉该区指针事件，导致 mouseenter
   在把手区不触发、滑过把手触发 mouseleave → 窗口误收缩）。
   全条顶栏都是普通 DOM，mouseenter/mouseleave/mousedown 互不冲突，
   鼠标在顶栏内任意移动（含把手）绝不触发收缩。 */
.drag-bar {
  height: 36px;
  flex: 0 0 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  box-sizing: border-box;
  user-select: none;
  cursor: grab;
}
/* grip 图标：纯装饰（拖拽由 .drag-bar 的 mousedown 统一处理） */
.ico-grip {
  pointer-events: none;
}
.drag-left {
  display: flex;
  align-items: center;
  gap: 6px;
}
.drag-title {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.72);
  user-select: none;
}
.drag-right {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* ==================== 图标按钮 ==================== */
.icon-btn {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.12s, background 0.12s;
}
.icon-btn:hover {
  color: rgba(255, 255, 255, 0.95);
  background: rgba(255, 255, 255, 0.1);
}
.icon-btn.is-pinned {
  color: rgba(255, 255, 255, 0.95);
}
.icon-btn.is-pinned:hover {
  background: rgba(255, 255, 255, 0.12);
}

.ico {
  width: 14px;
  height: 14px;
  display: block;
  pointer-events: none;
}

/* ==================== 展开态主体 ==================== */
.floating-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 收起态：主进程把窗口物理高度缩到 36px（仅顶栏），DOM 溢出已被
   .floating-shell { overflow: hidden } 裁掉。再加 visibility + pointer-events
   让它彻底不响应事件，避免收起态意外触发内部 hover/input。 */
.floating-body.is-collapsed {
  visibility: hidden;
  pointer-events: none;
}
.floating-content {
  -webkit-app-region: no-drag;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* ==================== 缩放 / 透明度滑块条 ==================== */
.opacity-bar,
.zoom-bar {
  -webkit-app-region: no-drag;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.25);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  box-sizing: border-box;
}

/* ==================== 渐显过渡 ==================== */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ==================== 滚动条统一：4px 细，半透明 thumb，透明 track
   （与 .fh-sync-list / addCurrency.vue 的 .currency-list 保持一致） */
.floating-content::-webkit-scrollbar {
  width: 4px;
}
.floating-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}
.floating-content::-webkit-scrollbar-track {
  background: transparent;
}

.opacity-label,
.zoom-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
  user-select: none;
  flex: 0 0 auto;
}
.opacity-value,
.zoom-value {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.78);
  font-variant-numeric: tabular-nums;
  flex: 0 0 36px;
  text-align: right;
  user-select: none;
}

.opacity-slider,
.zoom-slider {
  flex: 1 1 auto;
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.opacity-slider::-webkit-slider-thumb,
.zoom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  border: none;
}
.opacity-slider::-moz-range-thumb,
.zoom-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  border: none;
}
</style>

<!-- 非 scoped：仅悬浮窗渲染进程生效（独立 BrowserWindow，CSS 上下文与主窗口隔离）。
     透明窗口圆角处会露出浏览器默认 body 白底，必须把 html/body/#app 设为透明，
     配合主进程 backgroundColor: '#00000000' 才能彻底消除圆角白边。 -->
<style>
html,
body,
#app {
  background: transparent !important;
}
</style>
