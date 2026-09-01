<!-- ============================================================
     AssQueryForm.vue — 查询参数输入区（抽离自 Home.vue）
     职责：航线文件 + 航司 + 日期区间 + 开始/打开输出目录按钮
     纯展示组件：状态全部由 Home 持有，本组件只渲染 + 事件回抛
     ============================================================ -->

<template>
  <n-form label-placement="left" label-width="110px" :show-label="true" size="large">
    <n-form-item label="航线文件">
      <n-space align="center" style="width:100%;">
        <n-input
          :value="filePath"
          placeholder="请选择 .xlsx 文件（出发机场 / 到达机场 两列）"
          readonly
          clearable
          style="flex: 1;"
          @update:value="$emit('update:filePath', $event)"
          @clear="$emit('update:filePath', '')"
        />
        <n-button type="primary" :disabled="running" @click="$emit('pickFile')">选择文件</n-button>
      </n-space>
    </n-form-item>

    <n-form-item label="航司">
      <n-input
        :value="airline"
        placeholder="可选（不填 = 不指定航司，所有航线共用）"
        :disabled="running"
        @update:value="$emit('update:airline', $event)"
      />
    </n-form-item>

    <n-form-item label="日期区间">
      <n-date-picker
        :value="dateRange"
        type="daterange"
        value-format="yyyy-MM-dd"
        :actions="null"
        close-on-select
        :disabled="running"
        style="width: 360px;"
        @update:value="$emit('update:dateRange', $event)"
      />
    </n-form-item>

    <n-form-item label=" ">
      <n-space>
        <n-button
          type="primary"
          size="large"
          :disabled="!canStart || running"
          :loading="running"
          @click="$emit('start')"
        >
          {{ running ? '执行中…' : '开始执行' }}
        </n-button>

        <n-button
          size="large"
          :disabled="running"
          v-if="outputDir"
          @click="$emit('openOutputDir')"
        >打开输出目录</n-button>

        <n-button
          size="large"
          @click="$emit('clearStats')"
        >清空统计</n-button>
      </n-space>
    </n-form-item>
  </n-form>
</template>

<script setup>
import { NForm, NFormItem, NInput, NButton, NSpace, NDatePicker } from 'naive-ui'

defineProps({
  filePath: { type: String, default: '' },
  airline: { type: String, default: '' },
  dateRange: { type: [Array, Object], default: null },
  running: { type: Boolean, default: false },
  canStart: { type: Boolean, default: false },
  outputDir: { type: String, default: '' },
})

defineEmits([
  'update:filePath',
  'update:airline',
  'update:dateRange',
  'pickFile',
  'start',
  'openOutputDir',
  'clearStats',
])
</script>