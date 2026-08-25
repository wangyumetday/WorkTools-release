<!-- ============================================================
     PCP PlatformConfigForm.vue - 单个平台的配置表单
     职责：表单编辑单个平台的 3 个字段（底价公式/上浮比例/启用开关），保存时 emit('save')
     数据流：
       - props.config 同步到本地 localConfig（deep watch 兜底父组件刷新）
       - 点击保存 → emit('save', { platform, data: localConfig })
     说明：纯展示+表单组件，无 IPC 调用
     ============================================================ -->

<template>
  <n-form :model="localConfig" label-placement="left" label-width="120px" style="max-width: 600px; margin-top: 16px">
    <n-form-item label="底价公式" :validation-status="formulaStatus" :feedback="formulaFeedback">
      <n-input v-model:value="localConfig.floorPriceFormula" placeholder="例如：cost*1.1+50（仅加减乘除，空格随意）" />
    </n-form-item>
    <!-- <n-form-item v-if="false" label="报价上浮(%)">
      <n-input-number v-model:value="localConfig.markupPercent" :min="0" :max="1000" :step="1" style="width: 100%" />
    </n-form-item> -->
    <n-form-item label="启用规则" v-if="false">
      <n-switch v-model:value="localConfig.enabled" />
    </n-form-item>
    <n-form-item>
      <n-button type="primary" @click="handleSave">保存配置</n-button>
    </n-form-item>
  </n-form>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { NForm, NFormItem, NInput, NInputNumber, NSwitch, NButton } from 'naive-ui'

// 父组件传入的平台配置（jxgj/trip/o2/o3 之一）
const props = defineProps({
  config: {
    type: Object,
    default: () => ({})
  },
  platform: {
    type: String,
    default: ''
  }
})

// 保存事件（父组件 PlatformConfig 监听后调 IPC）
const emit = defineEmits(['save'])

// 本地编辑副本（避免直接改 props）
const localConfig = ref({ ...props.config })

// 父组件 config 变化时同步到本地（deep watch 兜底父组件刷新）
watch(() => props.config, (newVal) => {
  localConfig.value = { ...newVal }
}, { deep: true })

// 底价公式轻量 UX 预检：去掉 cost 和空白后，剩余应仅为 数字/./+-*/()
// 权威校验在主进程 mathjs（AST 白名单 + BigNumber），此处仅给即时提示，不引入大库到渲染进程
const formulaFeedback = computed(() => {
  const s = (localConfig.value.floorPriceFormula || '').trim()
  if (!s) return ''  // 空公式合法：运行时降级为原价
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
  return ''
})
const formulaStatus = computed(() => (formulaFeedback.value ? 'error' : undefined))

// 点击保存：emit 平台 + 本地数据
function handleSave() {
  emit('save', {
    platform: props.platform,
    data: { ...localConfig.value }
  })
}
</script>
