<!-- PCP Home.vue - 比价工具主页
     左栏：自适应宽度，纵向排列 TopToolbar / ConfigPanel
     右栏：固定宽度，占满高度的 TaskMonitor -->

<template>
  <n-config-provider>
    <n-message-provider>
      <div class="home-layout">
        <!-- 左栏：两组件纵向排列 -->
        <div class="home-left">
          <TopToolbar />
          <ConfigPanel class="home-left__main" />
        </div>
        <!-- 拖动线：按住左右拖动调整右栏宽度（320~680px） -->
        <div
          class="home-splitter"
          :class="{ 'is-dragging': dragging }"
          @mousedown="startDrag"
        />
        <!-- 右栏：任务监控（宽度可拖拽） -->
        <div class="home-right" :style="{ flexBasis: rightWidth + 'px' }">
          <TaskMonitor />
        </div>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import TopToolbar from '../components/TopToolbar.vue'
import ConfigPanel from '../components/ConfigPanel.vue'
import TaskMonitor from '../components/TaskMonitor.vue'
import TaskProgressBar from '../components/TaskProgressBar.vue'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// ===== 右栏宽度拖拽 =====
//   默认 380px（原固定 440px 略收窄），范围 320~680px；
//   宽度 = 视口宽 - 鼠标X - 布局右内边距(16)
const RIGHT_DEFAULT = 400
const RIGHT_MIN = 300
const RIGHT_MAX = 800
const rightWidth = ref(RIGHT_DEFAULT)
const dragging = ref(false)

function onDragMove(e) {
  const w = window.innerWidth - e.clientX - 16
  rightWidth.value = Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, w))
}

function stopDrag() {
  dragging.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', stopDrag)
}

function startDrag(e) {
  e.preventDefault()
  dragging.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', stopDrag)
}

onMounted(() => {
  // 首次挂载确保 store 已初始化（监听器注册 + 拉取 pipelineState）
  if (typeof store.init === 'function') store.init()
})
onBeforeUnmount(() => {
  stopDrag()
})
</script>

<style scoped>
/* 整体两栏布局：占满视口高度 */
.home-layout {
  display: flex;
  gap: 16px;
  height: 100vh;
  padding: 16px;
  overflow: hidden;
  position: relative;
}

/* 左栏：自适应宽度，纵向排列子组件
   ★ min-width:0：允许左栏在窗口较窄、右栏占宽增大时收缩到内容固有宽度以下，
     否则 flex 项默认 min-width:auto 会被内部表单/工具栏顶到 ~700px，
     把固定宽度的右栏挤出可视区被裁切（左栏内部 ConfigPanel 自带滚动承接溢出） */
.home-left {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  gap: 12px;
}

/* 中间配置面板占满剩余高度 */
.home-left__main {
  flex: 1;
  min-height: 0;
}

/* 左右分栏拖动线：6px 热区，内藏 1px 竖线；负边距吃掉部分 gap，不额外撑宽间距 */
.home-splitter {
  flex: 0 0 6px;
  margin: 0 -5px;
  position: relative;
  cursor: col-resize;
  z-index: 5;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    background: #d9d9d9;
    transition: background 0.15s ease, width 0.15s ease;
    transform: translateX(-0.5px);
  }

  &:hover::after,
  &.is-dragging::after {
    width: 2px;
    background: #1890ff;
    transform: translateX(-1px);
  }
}

/* 右栏：宽度由拖动线控制（flex-basis 内联），占满高度 */
.home-right {
  flex: 0 0 auto;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
</style>
