<!-- ============================================================
     PCP ConfigPanel.vue - 配置面板组件
     职责：通过标签页切换 账号管理 / 平台配置 两个子组件
     布局：占满父容器剩余高度，标签页内容区滚动
     ============================================================ -->

<template>
  <div class="config-panel">
    <n-tabs
      v-model:value="activeTab"
      type="line"
      animated
      size="large"
      class="config-tabs"
    >
      <n-tab-pane name="credential" tab="账号管理">
        <CredentialManager ref="credentialRef" />
      </n-tab-pane>
      <n-tab-pane name="platform" tab="平台配置">
        <PlatformConfig />
      </n-tab-pane>
      <template #suffix>
        <n-button
          v-show="activeTab === 'credential'"
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
