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