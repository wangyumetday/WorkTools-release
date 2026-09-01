<!-- PCP Home.vue - 比价工具主页
     左栏：自适应宽度，纵向排列 TopToolbar / ConfigPanel / StepFlow
     右栏：固定宽度，占满高度的 TaskMonitor -->

<template>
  <n-config-provider>
    <n-message-provider>
      <div class="home-layout">
        <!-- 左栏：三组件纵向排列 -->
        <div class="home-left">
          <TopToolbar />
          <ConfigPanel class="home-left__main" />
          <StageFlow />
        </div>
        <!-- 右栏：任务监控 -->
        <div class="home-right">
          <TaskMonitor />
        </div>
        <!-- Dev 模式标识：仅当处于 Dev 模式时显示（按住左Ctrl+8888 切换 auto/dev） -->
        <n-tag v-if="isDevMode" type="error" class="pcp-dev-indicator">Dev:On</n-tag>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { NConfigProvider, NMessageProvider, NTag } from 'naive-ui'
import TopToolbar from '../components/TopToolbar.vue'
import ConfigPanel from '../components/ConfigPanel.vue'
import StageFlow from '../components/StageFlow.vue'
import TaskMonitor from '../components/TaskMonitor.vue'
import TaskProgressBar from '../components/TaskProgressBar.vue'
import { useTaskStore } from '../stores/task.js'
import { installPcpDevListener } from '@/shared/secretUnlock'

const store = useTaskStore()

// Dev 模式：开启后步骤流需手动点击触发；关闭则点"开始"自动跑到底
const isDevMode = computed(() => store.pipelineState.mode === 'dev')

// PCP Dev 密码门：按住左 Ctrl + 8888 翻转 auto/dev 模式（n-tag 仅作显示）
let removeDevListener = null
onMounted(() => {
  // 首次挂载确保 store 已初始化（监听器注册 + 拉取 pipelineState）
  if (typeof store.init === 'function') store.init()
  removeDevListener = installPcpDevListener(() => {
    store.setMode(isDevMode.value ? 'auto' : 'dev')
  })
})
onBeforeUnmount(() => {
  if (removeDevListener) removeDevListener()
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
  /* 给 dev 按钮绝对定位提供锚点 */
}

/* 左栏：自适应宽度，纵向排列子组件 */
.home-left {
  display: flex;
  flex-direction: column;
  flex: 1;
  /* min-width: 600px; */
  gap: 12px;
}

/* 中间配置面板占满剩余高度 */
.home-left__main {
  flex: 1;
  min-height: 0;
}

/* 右栏：固定宽度，占满高度 */
.home-right {
  width: 320px;
  min-width: 280px;
  max-width: 480px;
  flex-shrink: 0;
  height: 100%;
  overflow: hidden;
}

/* Dev 模式标识：定位到左下角，仅显示用 */
.pcp-dev-indicator {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 10;
}
</style>
