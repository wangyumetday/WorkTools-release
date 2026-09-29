<!-- ============================================================
     PCP Home.vue - 比价工具主页（ComfyUI 式画布）
     三个节点：顶部工具栏 / 配置面板 / 任务监控
     - 节点拖动（标题栏）、边框改宽高、画布缩放平移由 FeatureCanvas 提供
     - 默认布局 ≈ 原三栏布局；布局持久化到 userData/canvas-layouts.json
     ============================================================ -->

<template>
  <n-config-provider>
    <n-message-provider>
      <FeatureCanvas feature-key="pcp" :node-defs="nodeDefs" />
      <!-- ★ 全局 busy mask：主进程长操作（生成运行日志/下载 Excel 等）期间屏蔽用户操作 -->
      <!--   避免 Windows 检测主线程不响应弹"无响应是否关闭"，让用户知道程序在干什么 -->
      <div v-if="store.busy.active" class="busy-mask" role="alertdialog" aria-busy="true">
        <div class="busy-card">
          <div class="busy-spinner" aria-hidden="true"></div>
          <div class="busy-label">{{ store.busy.label || '处理中...' }}</div>
          <div v-if="store.busy.detail" class="busy-detail">{{ store.busy.detail }}</div>
        </div>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { markRaw, onMounted } from 'vue'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import FeatureCanvas from '@/shared/canvas/FeatureCanvas.vue'
import TopToolbar from '../components/TopToolbar.vue'
import ConfigPanel from '../components/ConfigPanel.vue'
import TaskMonitor from '../components/TaskMonitor.vue'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// 节点定义（component 需 markRaw：进入 node.data 时不被 Vue 深度响应化）
// fill: 是否撑满节点 — 工具栏按内容自然高度，配置/监控整块填充
const nodeDefs = [
  {
    id: 'topbar', title: '顶部工具栏', x: 40, y: 40,
    w: 980, h: 210, minW: 640, minH: 160, fill: false,
    component: markRaw(TopToolbar)
  },
  {
    id: 'config', title: '配置面板', x: 40, y: 270,
    w: 700, h: 620, minW: 480, minH: 420,
    component: markRaw(ConfigPanel)
  },
  {
    id: 'monitor', title: '任务监控', x: 760, y: 270,
    w: 560, h: 620, minW: 440, minH: 340,
    component: markRaw(TaskMonitor)
  }
]

onMounted(() => {
  // 首次挂载确保 store 已初始化（监听器注册 + 拉取 pipelineState）
  if (typeof store.init === 'function') store.init()
})
</script>

<style scoped>
/* 全局 busy mask：覆盖整个画布，屏蔽鼠标点击 + 滚动 + 选择 */
.busy-mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 20, 20, 0.55);
  backdrop-filter: blur(2px);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: wait;
  user-select: none;
}

.busy-card {
  min-width: 260px;
  padding: 24px 36px;
  background: var(--bg-color, #fff);
  color: var(--text-color, #333);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
}

.busy-spinner {
  width: 36px;
  height: 36px;
  margin: 0 auto 14px;
  border: 3px solid #e0e0e0;
  border-top-color: #4a90e2;
  border-radius: 50%;
  animation: busy-spin 0.8s linear infinite;
}

@keyframes busy-spin {
  to { transform: rotate(360deg); }
}

.busy-label {
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 4px;
}

.busy-detail {
  font-size: 12px;
  color: #888;
  line-height: 1.5;
}
</style>