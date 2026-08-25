<!-- PCP Home.vue - 数据处理主页
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
          <StepFlow />
        </div>
        <!-- 右栏：任务监控 -->
        <div class="home-right">
          <TaskMonitor />
        </div>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import TopToolbar from '../components/TopToolbar.vue'
import ConfigPanel from '../components/ConfigPanel.vue'
import StepFlow from '../components/StepFlow.vue'
import TaskMonitor from '../components/TaskMonitor.vue'
import TaskProgressBar from '../components/TaskProgressBar.vue'
</script>

<style scoped>
/* 整体两栏布局：占满视口高度 */
.home-layout {
  display: flex;
  gap: 16px;
  height: 100vh;
  padding: 16px;
  overflow: hidden;
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
</style>
