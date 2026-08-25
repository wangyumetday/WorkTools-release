<!-- ============================================================
     FloatingShell.vue - 悬浮窗壳
     职责：紧凑布局 + 半透明背景 + 收缩/展开视觉切换 + 鼠标进出 IPC 联动
     数据流：
       - 鼠标进入 → api.floating.expand() → 主进程 setBounds 展开尺寸 → resize → 显示 ERC Home
       - 鼠标离开（延迟 300ms）→ api.floating.collapse() → 主进程 setBounds 缩成图标 → resize → 显示图标
     说明：
       - 半透明效果由两层组合：主进程 transparent=true + 本组件 rgba 背景
       - 收缩态显示图标（可拖动），展开态显示拖动条 + ERC Home
       - collapse 加 300ms 延迟，避免鼠标边缘抖动反复触发尺寸切换
       - -webkit-app-region: drag 标记可拖动区域，no-drag 标记交互区，避免 input/button 被拖动吞掉
     ============================================================ -->

<template>
  <div
    class="floating-shell"
    @mouseenter="handleExpand"
    @mouseleave="handleCollapse"
  >
    <!-- 收缩态：只显示一个图标（整个图标可拖动） -->
    <div v-if="isCollapsed" class="floating-icon" />

    <!-- 展开态：顶部拖动条 + ERC 操作界面 -->
    <template v-else>
      <div class="drag-bar" />
      <router-view />
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import api from '@/shared/api.js'

// 是否处于收缩态（根据窗口宽度判断：<=收缩尺寸宽度视为收缩）
const isCollapsed = ref(true)

// 根据当前窗口宽度更新收缩/展开态
function updateMode() {
  isCollapsed.value = window.innerWidth <= 100
}

// collapse 延迟计时器引用（用于 mouseenter 时取消未执行的收缩）
let collapseTimer = null

// 鼠标进入：立即展开（取消未执行的收缩）
function handleExpand() {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  api.floating.expand()
}

// 鼠标离开：延迟 300ms 收缩（避免边缘抖动反复触发）
function handleCollapse() {
  collapseTimer = setTimeout(() => {
    api.floating.collapse()
    collapseTimer = null
  }, 300)
}

onMounted(() => {
  updateMode()
  window.addEventListener('resize', updateMode)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateMode)
  if (collapseTimer) clearTimeout(collapseTimer)
})
</script>

<style scoped>
.floating-shell {
  width: 100%;
  height: 100vh;
  /* 半透明背景：主进程 transparent=true 让窗口透明，这里控制可见半透明度 */
  background: rgba(30, 30, 30, 0.9);
  border-radius: 12px;
  overflow: hidden;
  color: #fff;
  /* 默认 no-drag：交互区可点击；拖动靠 .drag-bar 和 .floating-icon */
  -webkit-app-region: no-drag;
}

/* 收缩态图标：圆形半透明，可拖动 */
.floating-icon {
  width: 100%;
  height: 100%;
  background: rgba(99, 226, 183, 0.85);
  border-radius: 50%;
  -webkit-app-region: drag;
  cursor: move;
}

/* 展开态拖动条：可拖动移动窗口 */
.drag-bar {
  height: 22px;
  background: rgba(255, 255, 255, 0.08);
  -webkit-app-region: drag;
  cursor: move;
}
</style>
