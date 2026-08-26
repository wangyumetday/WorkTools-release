<!-- ============================================================
     PCP ConfigPanel.vue - 配置面板组件
     职责：通过标签页切换 账号管理 / 平台配置 两个子组件
     布局：占满父容器剩余高度，标签页内容区滚动
     ============================================================ -->

<template>
  <div class="config-panel">
    <!-- 设计：真实步骤流进行中，禁止修改任何基础配置 → 顶部醒目警示条 + 子组件全部 disabled -->
    <n-alert
      v-if="pipelineInProgress"
      type="warning"
      show-icon
      class="cp-lock-banner"
      title="步骤流进行中，基础配置已锁定"
    >
      上传文件 / 下载结果 不算真实步骤流；
      当前为锦绣国际 / OTA / 合并阶段。完成或终止后才能编辑「账号管理」「平台配置」。
    </n-alert>

    <n-tabs
      v-model:value="activeTab"
      type="line"
      animated
      size="large"
      class="config-tabs"
      :disabled="pipelineInProgress"
    >
      <n-tab-pane name="credential" tab="账号管理">
        <CredentialManager ref="credentialRef" :disabled="pipelineInProgress" />
      </n-tab-pane>
      <n-tab-pane name="platform" tab="平台配置">
        <PlatformConfig :disabled="pipelineInProgress" />
      </n-tab-pane>
      <template #suffix>
        <n-button
          v-show="activeTab === 'credential'"
          :disabled="pipelineInProgress"
          tertiary
          type="primary"
          style="width: 120px"
          @click="credentialRef?.openAddModal()"
        >
          添加账号
        </n-button>
      </template>
    </n-tabs>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { NTabs, NTabPane } from 'naive-ui'
import CredentialManager from './CredentialManager.vue'
import PlatformConfig from './PlatformConfig.vue'
import { useTaskStore } from '../stores/task.js'

const activeTab = ref('credential')
const credentialRef = ref(null)
const store = useTaskStore()
// 从统一 store 取"是否进行中"：前端 UI 禁用；后端 IPC 仍做二次拦截（防绕过前端禁用直接调 IPC）
const pipelineInProgress = store.pipelineInProgress

// 阶段3：门禁失败闪烁引导
//   *_config    → 切到「平台配置」标签页（PlatformConfig 内部再切到对应平台 sub-tab）
//   *_credential→ 切到「账号管理」标签页（CredentialManager 内部抖动对应平台卡片）
const CONFIG_BLINKS = ['jxgj_config', 'o_config']
const CREDENTIAL_BLINKS = ['jxgj_credential', 'o_credential']
watch(() => store.blinkTarget, (t) => {
  if (CONFIG_BLINKS.includes(t)) activeTab.value = 'platform'
  else if (CREDENTIAL_BLINKS.includes(t)) activeTab.value = 'credential'
})
</script>

<style scoped>
/* 配置面板：占满父容器剩余高度 */
.config-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 进行中锁定提示条：不占滚动高度，固定在顶部 */
.cp-lock-banner {
  margin-bottom: 8px;
  flex-shrink: 0;
}

/* 标签页容器：填满父高度 */
.config-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 让 naive-ui 的 tabs 根元素也跟随伸缩 */
.config-tabs :deep(.n-tabs) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* 标签页内容区：占满剩余高度并支持滚动 */
.config-tabs :deep(.n-tab-pane) {
  height: 100%;
  overflow-y: auto;
  padding: 12px 4px 4px;
}

.config-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  min-height: 0;
}
</style>
