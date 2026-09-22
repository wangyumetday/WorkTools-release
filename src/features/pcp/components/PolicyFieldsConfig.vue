<!-- ============================================================
     PCP PolicyFieldsConfig.vue - 锦绣政策字段配置组件
     职责：配置新格式政策导入文件里 12 项「锦绣配置」字段（11 个文本 + 1 个主行参与开关）
       - 字段值支持 ${变量} 拼接（如 ${出发机场}-${到达机场}）
       - 「主行参与」开关：关闭=主行只作套餐公用信息来源，套餐各生成一条政策行；
         开启=主行参与比价并产出政策行
       - 右侧列出可用变量供参考
       - 进行中锁定（与平台配置同源 disabled）
     数据流：onMounted 拉 policyFieldsGet → 输入 → 保存 policyFieldsSet
     ============================================================ -->

<template>
  <div class="policy-fields-config">
    <n-alert
      v-if="disabled"
      type="warning"
      show-icon
      class="pfc-lock"
      title="步骤流进行中，政策字段配置已锁定"
    >
      完成或终止步骤流后才可修改。
    </n-alert>

    <div class="pfc-body">
      <!-- 左：字段输入区 -->
      <div class="pfc-fields">
        <div class="pfc-hint">
          新格式政策导入文件的 11 个字段在此配置。值支持用 <code>${变量名}</code> 拼接运行时数据（如 <code>${航司名}/${出发机场}-${到达机场}</code>），导出时逐行替换。
          「主行参与」开关：关闭时主行只作为套餐的公用信息来源（机场/城市/航班号等），仅套餐参与比价并各生成一条政策行；开启时主行参与比价并产出政策行。
        </div>
        <div v-for="f in schema" :key="f.key" class="pfc-row">
          <label class="pfc-label" :title="f.key">{{ f.label }}</label>
          <n-switch
            v-if="f.type === 'switch'"
            v-model:value="form[f.key]"
            :disabled="disabled"
            class="pfc-switch"
          />
          <n-input
            v-else
            v-model:value="form[f.key]"
            :placeholder="`默认：${f.default ?? ''}`"
            :disabled="disabled"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 3 }"
            class="pfc-input"
          />
        </div>
        <div class="pfc-actions">
          <n-button
            type="primary"
            :disabled="disabled || saving"
            :loading="saving"
            @click="handleSave"
          >保存配置</n-button>
          <n-button :disabled="disabled" quaternary @click="handleReset">恢复默认</n-button>
        </div>
      </div>

      <!-- 右：可用变量参考（左键单击复制 ${变量名} 引用格式） -->
      <div class="pfc-vars">
        <div class="pfc-vars-title">可用变量</div>
        <div class="pfc-vars-hint">在字段值里用 ${变量名} 引用，导出时替换为该行实际数据；左键单击变量即可复制</div>
        <div
          v-for="v in vars"
          :key="v.name"
          class="pfc-var pfc-var--clickable"
          :title="`点击复制 \${${v.name}}`"
          @click="copyVar(v.name)"
        >
          <code class="pfc-var-name">{{ '${' + v.name + '}' }}</code>
          <span class="pfc-var-desc">{{ v.desc }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { NInput, NButton, NAlert, NSwitch } from 'naive-ui'
import message from '@/shared/message.js'
import api from '@/shared/api.js'

const props = defineProps({
  // 父组件(ConfigPanel)按 pipelineInProgress 透传：进行中 true=禁用
  disabled: { type: Boolean, default: false }
})

// 字段 schema（label + default），从后端拉
const schema = ref([])
// 可用变量列表（name + desc），从后端拉
const vars = ref([])
// 表单值（key → 用户填写值）
const form = ref({})
const saving = ref(false)

async function load() {
  const res = await api.pcp.policyFieldsGet()
  schema.value = res?.schema || []
  vars.value = res?.vars || []
  form.value = { ...(res?.fields || {}) }
}

async function handleSave() {
  if (props.disabled) {
    message.warning('步骤流进行中，禁止保存政策字段配置')
    return
  }
  saving.value = true
  try {
    const res = await api.pcp.policyFieldsSet({ ...form.value })
    form.value = { ...(res?.fields || {}) }
    message.success('政策字段配置已保存')
  } catch (e) {
    message.error('保存失败：' + (e?.message || e))
  } finally {
    saving.value = false
  }
}

function handleReset() {
  for (const f of schema.value) {
    form.value[f.key] = f.default
  }
}

// 左键单击变量名 → 复制 ${变量名} 引用格式到剪贴板，方便直接粘贴到左侧输入框
async function copyVar(name) {
  const text = '${' + name + '}'
  try {
    await navigator.clipboard.writeText(text)
    message.success(`已复制 ${text}`)
  } catch (e) {
    message.error('复制失败：' + (e?.message || e))
  }
}

onMounted(load)
</script>

<style scoped>
.policy-fields-config {
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pfc-lock { flex-shrink: 0; }
.pfc-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  overflow: hidden;
}
/* 左：字段输入区，可滚动 */
.pfc-fields {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pfc-hint {
  font-size: 12px;
  color: #888;
  line-height: 1.6;
  background: #f5f5f5;
  padding: 8px 10px;
  border-radius: 4px;
}
.pfc-hint code {
  background: #e8e8e8;
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 11px;
}
.pfc-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.pfc-label {
  width: 120px;
  flex-shrink: 0;
  font-size: 13px;
  color: #333;
  line-height: 32px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pfc-input { flex: 1; }
.pfc-switch { margin-top: 6px; }
.pfc-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  padding-left: 128px;
}
/* 右：变量参考，固定宽度 */
.pfc-vars {
  width: 240px;
  flex-shrink: 0;
  overflow-y: auto;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pfc-vars-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}
.pfc-vars-hint {
  font-size: 11px;
  color: #999;
  line-height: 1.5;
  margin-bottom: 4px;
}
.pfc-var {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 0;
  border-bottom: 1px dashed #eee;
}
.pfc-var:last-child { border-bottom: none; }
/* 可点击复制：手型 + hover 浅底提示 */
.pfc-var--clickable { cursor: pointer; }
.pfc-var--clickable:hover { background: #f0f7f4; }
.pfc-var-name {
  font-size: 12px;
  color: #0a7;
  background: #eef7f3;
  padding: 1px 4px;
  border-radius: 2px;
  width: fit-content;
}
.pfc-var-desc {
  font-size: 11px;
  color: #888;
}
</style>
