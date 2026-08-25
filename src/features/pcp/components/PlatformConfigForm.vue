<!-- ============================================================
     PCP PlatformConfigForm.vue - 单个平台的配置表单（阶段4：schema 驱动）
     职责：根据平台 configSchema 动态渲染配置项（异构：JXGJ 公式 / TRIP 一整套 / O2-O3 简单）
     数据流：
       - props.schema / props.config 由父组件 PlatformConfig 注入（拉一次 schema 共享给 4 个表单）
       - 表单值同步到本地 localConfig（deep watch 兜底父组件刷新）
       - 点击保存 → emit('save', { platform, data: localConfig })
     闪烁引导：jxgj_config/o_config 时由 store.blinkTarget 触发本组件抖动
       - jxgj_config + platform=jxgj → 抖动
       - o_config    + platform=trip → 抖动（trip 作为"第一个 O"引导用户去启用）
     说明：纯展示+表单组件，无 IPC 调用
     ============================================================ -->

<template>
  <n-form :model="localConfig" label-placement="left" label-width="160px" :show-required-mark="false"
    style="max-width: 640px; margin-top: 16px" :class="{ 'pcp-blink-shake': shouldBlink }">
    <n-form-item v-for="field in schemaFields" :key="field.key" :label="field.label"
      :validation-status="fieldValidationStatus(field)" :feedback="fieldFeedback(field)">
      <!-- boolean → 开关 -->
      <n-switch v-if="field.type === 'boolean'" v-model:value="localConfig[field.key]" />
      <!-- number → 数字输入 -->
      <n-input-number v-else-if="field.type === 'number'" v-model:value="localConfig[field.key]" style="width: 100%" />
      <!-- formula / string → 文本输入 -->
      <!-- PriceRange → 数组输入，格式为 [min, max,drop] -->
      <n-space vertical v-else-if="field.type === 'PriceRange'" v-model:value="localConfig[field.key]"
        style="width: 100%">
        <n-cascader v-model:value="value" placeholder="没啥用的值" :expand-trigger="hover" :options="options"
          :show-path="showPath" :bordered="true" @update:value="handleUpdateValue" />
      </n-space>

      <n-input v-else v-model:value="localConfig[field.key]" :placeholder="field.help ? field.help : ''" />
      <!-- 字段 help（小字说明，schema 注释即 UI 提示） -->
      <template v-if="field.help && field.type !== 'string'" #feedback>
        <span style="color: #999; font-size: 12px">{{ field.help }}</span>
      </template>
    </n-form-item>
  </n-form>
</template>

<script setup>
import { ref, watch, computed, nextTick } from 'vue'
import { NForm, NFormItem, NInput, NInputNumber, NSwitch, NButton } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

// 父组件注入：平台配置值 + 平台 key + schema
const props = defineProps({
  config: { type: Object, default: () => ({}) },
  platform: { type: String, default: '' },
  schema: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['save'])
const store = useTaskStore()

// 本地编辑副本（避免直接改 props）
const localConfig = ref({ ...props.config })

// 防止 props 注入触发的 watch 误判为"用户编辑"
let suppressWatch = false

// 父组件 config 变化时同步到本地（保存后父组件重载会触发，用 suppressWatch 跳过这次）
watch(() => props.config, (newVal) => {
  suppressWatch = true
  localConfig.value = { ...newVal }
  nextTick(() => { suppressWatch = false })
}, { deep: true })

// 配置变化规则（用户需求）：
//   - 用户改任意非 enabled 字段 → 自动把 enabled 置为 false（标记"配置已脏，需重新启用"）
//   - 用户手动拨启用开关（无论 false→true 还是 true→false）→ 同步本页配置进系统（emit save）
//   - 字段编辑触发的自动未启用 不触发同步（只是脏标记）
// 用 JSON.stringify getter 绕过 deep watch oldVal===newVal 同引用问题
// autoDisabling 标志区分"用户手拨开关"与"自动脏标记"，避免 true→false 被当脏标记跳过（原"假切换"bug）
let autoDisabling = false
watch(
  () => JSON.stringify(localConfig.value),
  (newStr, oldStr) => {
    if (suppressWatch) return
    const newObj = JSON.parse(newStr)
    const oldObj = oldStr ? JSON.parse(oldStr) : {}
    let changedKey = null
    for (const k in newObj) {
      if (newObj[k] !== oldObj[k]) { changedKey = k; break }
    }
    if (changedKey === null) return

    if (changedKey === 'enabled') {
      // 自动脏标记产生的 enabled 变化 → 跳过保存
      if (autoDisabling) return
      // 用户手动拨启用开关（两向都同步）→ emit save 持久化
      emit('save', { platform: props.platform, data: { ...localConfig.value } })
      return
    }

    // 其他字段变化 → 自动未启用（脏标记，等用户重新启用才同步）
    if (newObj.enabled !== false) {
      autoDisabling = true
      localConfig.value.enabled = false
      nextTick(() => { autoDisabling = false })
    }
  }
)

// schema → 有序字段数组（按 schema 声明顺序渲染）
const schemaFields = computed(() => {
  const schema = props.schema || {}
  return Object.keys(schema).map(key => ({ key, ...schema[key] }))
})

// 公式轻量 UX 预检：去掉 cost 和空白后，剩余应仅为 数字/./+-*/()
// 权威校验在主进程 mathjs（AST 白名单 + BigNumber），此处仅给即时提示，不引入大库到渲染进程
function formulaFeedback(field) {
  if (field.type !== 'formula') return ''
  const s = String(localConfig.value[field.key] || '').trim()
  if (!s) return field.help || ''  // 空公式合法：运行时降级为原价；显示 help
  const residual = s.replace(/cost/g, '').replace(/\s/g, '')
  if (!/^[0-9.+\-*/()]*$/.test(residual)) {
    return '只能用 + - * / ( )、数字和 cost，例如 cost*1.1+50'
  }
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) return '括号不匹配：出现多余的 )'
    }
  }
  if (depth !== 0) return '括号不匹配：缺少 )'
  return field.help || ''
}

function fieldFeedback(field) {
  if (field.type === 'formula') return formulaFeedback(field)
  return field.help || ''
}

function fieldValidationStatus(field) {
  if (field.type !== 'formula') return undefined
  const s = String(localConfig.value[field.key] || '').trim()
  if (!s) return undefined  // 空公式合法
  const residual = s.replace(/cost/g, '').replace(/\s/g, '')
  if (!/^[0-9.+\-*/()]*$/.test(residual)) return 'error'
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth < 0) return 'error'
  }
  return depth !== 0 ? 'error' : undefined
}

// 闪烁引导：本平台 config 缺失时抖动
//   jxgj_config + platform=jxgj → 抖
//   o_config    + platform=trip → 抖（trip 作为第一个 O，引导用户启用）
const shouldBlink = computed(() => {
  const t = store.blinkTarget
  if (!t) return false
  if (t === `${props.platform}_config`) return true
  if (t === 'o_config' && props.platform === 'trip') return true
  return false
})
</script>
