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
        <PlatformConfigForm :config="config.jxgj" :schema="schema.jxgj" platform="jxgj" @save="handleSave" />
      </n-tab-pane>
      <n-tab-pane name="trip" tab="携程OTA平台">
        <PlatformConfigForm :config="config.trip" :schema="schema.trip" platform="trip" @save="handleSave" />
      </n-tab-pane>
      <n-tab-pane name="o2" tab="O2平台">
        <PlatformConfigForm :config="config.o2" :schema="schema.o2" platform="o2" @save="handleSave" />
      </n-tab-pane>
      <n-tab-pane name="o3" tab="O3平台">
        <PlatformConfigForm :config="config.o3" :schema="schema.o3" platform="o3" @save="handleSave" />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { NTabs, NTabPane } from 'naive-ui'
import PlatformConfigForm from './PlatformConfigForm.vue'
import message from '@/shared/message.js'
import api from '@/shared/api.js'
import { useTaskStore } from '../stores/task.js'

// 当前激活的 tab（代码 key 用简称）
const activePlatform = ref('jxgj')
// 4 平台的配置（底价公式 / 上浮比例 / 启用开关）
const config = ref({
  jxgj: {},
  trip: {},
  o2: {},
  o3: {}
})
// 4 平台的配置 schema（驱动 PlatformConfigForm 自动渲染，阶段4）
const schema = ref({
  jxgj: {},
  trip: {},
  o2: {},
  o3: {}
})

const store = useTaskStore()

// 拉取全部平台配置 + schema（schema 拉一次即可，配置每次保存后刷新）
async function loadConfig() {
  const [result, schemaResult] = await Promise.all([
    api.pcp.configGet(),
    api.pcp.configGetSchema()
  ])
  config.value = result
  if (schemaResult && typeof schemaResult === 'object') schema.value = schemaResult
}

// 保存单平台配置（PlatformConfigForm emit 触发）
async function handleSave({ platform, data }) {
  const newConfig = { [platform]: data }
  await api.pcp.configSet(newConfig)
  const nameMap = { jxgj: '锦绣国际', trip: '携程OTA', o2: 'O2', o3: 'O3' }
  message.success(`${nameMap[platform] || platform} 平台配置已保存`)
  await loadConfig()
}

// 阶段3：门禁失败闪烁引导
//   jxgj_config / jxgj_credential → 切到 jxgj tab（PlatformConfigForm 内部会抖动）
//   o_config / o_credential        → 切到第一个启用的 O 平台 tab（trip→o2→o3 顺序）
watch(() => store.blinkTarget, (t) => {
  if (t === 'jxgj_config' || t === 'jxgj_credential') {
    activePlatform.value = 'jxgj'
    return
  }
  if (t === 'o_config' || t === 'o_credential') {
    // 优先切到第一个"已启用"的 O 平台；都没启用就切到 trip（让用户去启用）
    const oKeys = ['trip', 'o2', 'o3']
    const firstEnabled = oKeys.find(k => config.value?.[k]?.enabled)
    activePlatform.value = firstEnabled || 'trip'
  }
})

onMounted(() => {
  loadConfig()
})
</script>

<style scoped>
.platform-config {
  width: 100%;
}
</style>
