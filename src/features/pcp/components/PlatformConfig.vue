<!-- ============================================================
     PCP PlatformConfig.vue - 平台配置管理组件
     职责：用 n-tabs 切换 4 平台，每个 tab 内渲染 PlatformConfigForm
     数据流：
       - onMounted 调 api.pcp.configGet() 拉取 4 平台配置
       - 表单 emit('save', { platform, data }) → 调 api.pcp.configSet({ [platform]: data }) → 重新 loadConfig
     进行中锁定（设计：真实步骤流运行时不可改配置）：
       - 父组件 ConfigPanel 按 pipelineInProgress 透传 disabled
       - 禁用平台 tab 切换、PlatformConfigForm 所有输入控件、enabled switch、RangePricing
       - handleSave 提前 return（后端 IPC 还有 failIfInProgress 二次拦截，防绕过）
     ============================================================ -->

<template>
  <div class="platform-config">
    <!-- 进行中锁提示（切换到平台配置 tab 后依然可看到） -->
    <n-alert
      v-if="disabled"
      type="warning"
      show-icon
      class="pc-inner-lock"
      title="步骤流进行中，平台配置已锁定"
    >
      完成或终止锦绣国际 / OTA / 合并阶段后才可修改。
    </n-alert>

    <!-- display-directive="show":切 tab 不卸载组件，未保存的编辑不会丢 -->
    <n-tabs
      v-model:value="activePlatform"
      type="segment"
      display-directive="show"
      :disabled="disabled"
    >
      <n-tab-pane name="jxgj" tab="锦绣国际">
        <PlatformConfigForm
          :config="config.jxgj"
          :schema="schema.jxgj"
          :disabled="disabled"
          platform="jxgj"
          @save="handleSave"
        />
      </n-tab-pane>
      <n-tab-pane name="trip" tab="携程OTA平台">
        <PlatformConfigForm
          :config="config.trip"
          :schema="schema.trip"
          :disabled="disabled"
          platform="trip"
          @save="handleSave"
        />
      </n-tab-pane>
      <n-tab-pane name="o2" tab="O2平台">
        <PlatformConfigForm
          :config="config.o2"
          :schema="schema.o2"
          :disabled="disabled"
          platform="o2"
          @save="handleSave"
        />
      </n-tab-pane>
      <n-tab-pane name="o3" tab="O3平台">
        <PlatformConfigForm
          :config="config.o3"
          :schema="schema.o3"
          :disabled="disabled"
          platform="o3"
          @save="handleSave"
        />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { NTabs, NTabPane, NAlert } from 'naive-ui'
import PlatformConfigForm from './PlatformConfigForm.vue'
import message from '@/shared/message.js'
import api from '@/shared/api.js'
import { useTaskStore } from '../stores/task.js'

const props = defineProps({
  // 父组件(ConfigPanel)按 pipelineInProgress 透传：进行中 true=禁用
  disabled: { type: Boolean, default: false }
})

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
// ★ 进行中提前拦截（后端仍会 failIfInProgress 二次兜底）
async function handleSave({ platform, data }) {
  if (props.disabled) {
    message.warning('步骤流进行中，禁止保存平台配置；请先完成或终止')
    return
  }
  const nameMap = { jxgj: '锦绣国际', trip: '携程OTA', o2: 'O2', o3: 'O3' }
  const patch = { [platform]: data }
  // console.log(`[PlatformConfig] handleSave: sending patch =`, patch)
  const result = await api.pcp.configSet(patch)
  const merged = (result && result.merged) ? result.merged : result
  const runtimeInfo = (result && result.runtimeInfo) ? result.runtimeInfo : null
  // console.log(
  //   `[PlatformConfig] handleSave DONE:` +
  //   (runtimeInfo ? ` runtimeRevision=${runtimeInfo.revision}` : ''),
  //   '\n  merged =', merged,
  //   runtimeInfo ? '\n  runtimeSummary =' : null,
  //   runtimeInfo ? runtimeInfo.summary : null
  // )
  message.success(`${nameMap[platform] || platform} 平台配置已保存` +
    (runtimeInfo ? `（运行时栈 rev${runtimeInfo.revision}）` : ''))
  // 保存后再 loadConfig 刷新父组件 config.value（子组件 props 同步用）
  await loadConfig()
}

// 阶段3：门禁失败闪烁引导
watch(() => store.blinkTarget, (t) => {
  if (t === 'jxgj_config' || t === 'jxgj_credential') {
    activePlatform.value = 'jxgj'
    return
  }
  if (t === 'o_config' || t === 'o_credential') {
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
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pc-inner-lock {
  flex-shrink: 0;
}
</style>
