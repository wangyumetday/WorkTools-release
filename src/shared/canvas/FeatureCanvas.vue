<!-- ============================================================
     FeatureCanvas.vue - ComfyUI 式功能画布（通用）
     职责：
       - 每个功能一张画布；由 nodeDefs 描述节点（标题/位置/尺寸/内容组件）
       - 交互：滚轮缩放、空白处拖动平移、节点标题栏拖动位置、NodeResizer 边框改宽高
       - 滚轮优先级（已拍板「滚动优先」）：节点内容区带 nowheel 类，
         滚轮命中内容 → 原样滚列表/表单；命中空白/标题 → vue-flow 缩放画布
       - 持久化：节点位置/尺寸 + 视口缩放平移 → userData/canvas-layouts.json（IPC）
       - 视口静止后经 viewportBus 广播，供虚拟列表等重新测量
     Props：
       - featureKey: 持久化分区 key（pcp / erc / ass）
       - nodeDefs:   [{ id, title, x, y, w, h, minW, minH, component }]
         component 需 markRaw（放 node.data 里避免深度响应化整棵组件）
     ============================================================ -->

<template>
  <div ref="wrapEl" class="feature-canvas" @wheel.capture="onWheel">
    <VueFlow
      :id="featureKey"
      v-model:nodes="nodes"
      :min-zoom="MIN_ZOOM"
      :max-zoom="MAX_ZOOM"
      :zoom-on-double-click="false"
      :delete-key-code="null"
      :nodes-connectable="false"
      :edges-updatable="false"
      :default-viewport="{ x: 0, y: 0, zoom: 1 }"
      @node-drag-stop="scheduleSave"
      @move-end="onMoveEnd"
    >
      <!-- 通用面板节点：标题栏（拖动把手）+ 内容区（内部滚动，不参与缩放/拖动/平移） -->
      <template #node-panel="nodeProps">
        <div class="cf-node" :class="{ 'is-selected': !!nodeProps.selected }">
          <div class="cf-node__header">{{ nodeProps.data.title }}</div>
          <div
            class="cf-node__content nowheel nodrag nopan"
            :class="{ 'is-fill': nodeProps.data.fill !== false }"
          >
            <component :is="nodeProps.data.component" />
          </div>
          <NodeResizer
            :node-id="nodeProps.id"
            :is-visible="!!nodeProps.selected"
            :min-width="nodeProps.data.minW ?? 320"
            :min-height="nodeProps.data.minH ?? 240"
            color="#8f96a3"
            @resize-end="scheduleSave"
          />
        </div>
      </template>

      <!-- 右下角圆形小地图：滚轮缩放画布（zoomable）、按住拖动平移画布（pannable），
           两种操作都走画布 d3 缩放通道 → 正常触发 moveEnd（保存布局 + 列表重测量） -->
      <MiniMap
        :pannable="true"
        :zoomable="true"
        position="bottom-right"
        :width="168"
        :height="168"
        mask-color="rgba(224, 228, 235, 0.16)"
        mask-stroke-color="#5b8ff9"
        :mask-stroke-width="1.5"
        node-color="#8f96a3"
        node-stroke-color="#4a4d55"
        :node-stroke-width="1"
        :node-border-radius="3"
      />
    </VueFlow>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import { MiniMap } from '@vue-flow/minimap'
// vue-flow 基础样式（库内部组件类名，需全局生效）
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/node-resizer/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import { notifyCanvasViewportChange } from './viewportBus.js'

const props = defineProps({
  featureKey: { type: String, required: true },
  nodeDefs: { type: Array, required: true }
})

const MIN_ZOOM = 0.3
const MAX_ZOOM = 2.5

// useVueFlow 与 VueFlow 组件用同一实例 id（featureKey）绑定，组件挂载后 store 自动可用
const { setViewport, getViewport } = useVueFlow(props.featureKey)

// ===== 由 nodeDefs 构造 vue-flow 节点对象 =====
//   尺寸用 style 固定（内容 100% 填充后由 ResizeObserver 实测回填 dimensions）；
//   dragHandle 限定只有标题栏能拖动节点；data.component 由父层 markRaw 传入
const nodes = ref(props.nodeDefs.map((d) => ({
  id: d.id,
  type: 'panel',
  position: { x: d.x, y: d.y },
  style: { width: `${d.w}px`, height: `${d.h}px` },
  dragHandle: '.cf-node__header',
  data: { title: d.title, component: d.component, minW: d.minW, minH: d.minH, fill: d.fill }
})))

// ===== 布局加载：本地记录（位置/尺寸/视口）覆盖默认值 =====
onMounted(async () => {
  try {
    const all = (await window.api?.canvas?.layoutGet?.()) || {}
    const mine = all?.[props.featureKey]
    if (!mine) return
    if (Array.isArray(mine.nodes)) {
      const byId = new Map(mine.nodes.filter((s) => s?.id).map((s) => [s.id, s]))
      for (const n of nodes.value) {
        const s = byId.get(n.id)
        if (!s) continue
        if (s.position) n.position = { x: s.position.x, y: s.position.y }
        if (s.dimensions?.width && s.dimensions?.height) {
          n.style = { width: `${s.dimensions.width}px`, height: `${s.dimensions.height}px` }
        }
      }
    }
    if (mine.viewport?.zoom) await setViewport(mine.viewport)
  } catch (e) {
    // 布局加载失败静默：不阻断功能使用（默认布局继续可用）
    console.warn('[canvas] load layout failed:', e?.message)
  }
})

// ===== Ctrl+滚轮：任意位置直接缩放画布（指针为中心） =====
//   普通滚轮行为保持不变（内容滚动优先 / 空白缩放）；仅 Ctrl 按住时统一劫持为画布缩放。
//   capture 阶段拦截 + stopPropagation：d3 缩放处理器与内容滚动都收不到该事件。
const wrapEl = ref(null)

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

function onWheel(e) {
  if (!e.ctrlKey) return // 非 Ctrl：不干预，走默认（内容滚动 / 画布缩放）
  e.preventDefault()
  e.stopPropagation()

  const rect = wrapEl.value?.getBoundingClientRect()
  if (!rect) return
  // 指针在容器内的屏幕坐标（viewport.x/y 同为屏幕空间，可直接换算）
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  const vp = getViewport()
  const zoom = clampZoom(vp.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
  if (zoom === vp.zoom) return
  // 保持指针下的画布点不动：屏幕坐标 → 画布坐标 → 反推新平移
  const fx = (cx - vp.x) / vp.zoom
  const fy = (cy - vp.y) / vp.zoom
  setViewport({ x: cx - fx * zoom, y: cy - fy * zoom, zoom })
}

// ===== 布局保存：节点尺寸（dimensions 缺失时从 style 兜底解析） =====
function nodeSnapshot(n) {
  const fromStyle = (key) => {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(String(n.style?.[key] ?? ''))
    return m ? Number(m[1]) : 0
  }
  const w = Math.round(n.dimensions?.width || fromStyle('width') || 400)
  const h = Math.round(n.dimensions?.height || fromStyle('height') || 300)
  return {
    id: n.id,
    position: { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) },
    dimensions: { width: w, height: h }
  }
}

let saveTimer = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(doSave, 300)
}

function doSave() {
  saveTimer = null
  const payload = {
    nodes: nodes.value.map(nodeSnapshot),
    viewport: getViewport()
  }
  // 保存失败静默：布局不落盘不影响本次使用
  try { window.api?.canvas?.layoutSet?.({ key: props.featureKey, layout: payload }) } catch (e) {
    console.warn('[canvas] save layout failed:', e?.message)
  }
}

// ===== 视口变化（缩放/平移静止后）：保存 + 广播供虚拟列表重新测量 =====
let viewportTimer = null
function onMoveEnd() {
  scheduleSave()
  if (viewportTimer) clearTimeout(viewportTimer)
  viewportTimer = setTimeout(() => notifyCanvasViewportChange(), 200)
}

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (viewportTimer) clearTimeout(viewportTimer)
  doSave()
})
</script>

<style scoped>
.feature-canvas {
  width: 100%;
  /* 100vh 而非 100%：画布上方隔一层 n-config-provider wrapper div（高度 auto），
     % 高度链会断在那里导致高度塌陷为 0；内容区本就是整窗口高度，100vh 与原
     .home-layout / .erc-home / .ass-home 的做法一致 */
  height: 100vh;
  background: #1f1f21; /* 终端风深色画布底 */
  overflow: hidden;
}

/* 画布本身透明，透出深色底 */
.feature-canvas :deep(.vue-flow) {
  background: transparent;
}

/* 圆形小地图：终端风深色底盘 + 圆形裁剪（内部 SVG 为方形，圆角裁掉四角） */
.feature-canvas :deep(.vue-flow__minimap) {
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid #3a3d45;
  background: rgba(20, 21, 24, 0.72);
}

/* 节点 wrapper：去掉 theme-default 的白底/边框/内边距，样式全部收进 .cf-node */
.feature-canvas :deep(.vue-flow__node-panel) {
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
}

/* 面板节点：标题栏 + 内容区（内容 100% 填充节点尺寸） */
.cf-node {
  width: 100%;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  box-sizing: border-box;
  background: #fff;
  border: 1px solid #4a4d55;
  border-radius: 4px;
  overflow: hidden;
}

.cf-node.is-selected {
  border-color: #5b8ff9;
  box-shadow: 0 0 0 1px #5b8ff9;
}

/* 标题栏 = 拖动把手：终端风深色细条 */
.cf-node__header {
  flex: 0 0 auto;
  height: 26px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  background: #26262b;
  color: #c9cdd4;
  font-size: 12px;
  user-select: none;
  border-bottom: 1px solid #141416;
}

/* 内容区：占满节点剩余空间；内部组件自行滚动，
   nowheel/nodrag/nopan 让滚轮滚动内容而非缩放、按住内容不拖动节点/画布 */
.cf-node__content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* fill=true（默认）：内容组件撑满节点（Config 表单/任务列表整页填充）；
   fill=false：组件按自然高度排布（如顶部工具栏横条），超出时内容区自身滚动 */
.cf-node__content.is-fill {
  display: flex;
  flex-flow: column nowrap;
  overflow: hidden;
}

.cf-node__content.is-fill > * {
  flex: 1 1 auto;
  min-height: 0;
}
</style>