<!-- ============================================================
     PCP PlatformConfig.vue - 平台配置管理组件
     职责：用 n-tabs 切换 4 平台，每个 tab 内渲染 PlatformConfigForm
     数据流：
       - onMounted 调 api.pcp.configGet() 拉取 4 平台配置
       - 表单 emit('save', { platform, data }) → 调 api.pcp.configSet({ [platform]: data }) → 重新 loadConfig
     ============================================================ -->

<template>
  <div class="platform-config">
    <n-tabs v-model:value="activePlatform" type="segment">
      <n-tab-pane name="jxgj" tab="锦绣国际">
        <PlatformConfigForm :config="config.jxgj" platform="jxgj" @save="handleSave" />
      </n-tab-pane>
      <n-tab-pane name="trip" tab="携程OTA平台">
        <PlatformConfigForm :config="config.trip" platform="trip" @save="handleSave" />
      </n-tab-pane>
      <n-tab-pane name="o2" tab="O2平台">
        <PlatformConfigForm :config="config.o2" platform="o2" @save="handleSave" />
      </n-tab-pane>
      <n-tab-pane name="o3" tab="O3平台">
        <PlatformConfigForm :config="config.o3" platform="o3" @save="handleSave" />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { NTabs, NTabPane } from 'naive-ui'
import PlatformConfigForm from './PlatformConfigForm.vue'
import message from '@/shared/message.js'
import api from '@/shared/api.js'

// 当前激活的 tab（代码 key 用简称）
const activePlatform = ref('jxgj')
// 4 平台的配置（底价公式 / 上浮比例 / 启用开关）
const config = ref({
  jxgj: {},
  trip: {},
  o2: {},
  o3: {}
})

// 拉取全部平台配置
async function loadConfig() {
  const result = await api.pcp.configGet()
  config.value = result
}

// 保存单平台配置（PlatformConfigForm emit 触发）
async function handleSave({ platform, data }) {
  const newConfig = { [platform]: data }
  await api.pcp.configSet(newConfig)
  const nameMap = { jxgj: '锦绣国际', trip: '携程OTA', o2: 'O2', o3: 'O3' }
  message.success(`${nameMap[platform] || platform} 平台配置已保存`)
  await loadConfig()
}

onMounted(() => {
  loadConfig()
})
</script>

<style scoped>
.platform-config {
  width: 100%;
}
</style>
