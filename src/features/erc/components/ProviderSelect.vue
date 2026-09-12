<!-- ============================================================
     ProviderSelect.vue - 汇率数据源选择器
     职责：切换 ERC 汇率源（exchangerate / allratestoday）
     说明：useMessage 只能在 <n-message-provider> 的【后代组件】中调用，
           Home.vue 自身是 provider 的声明者，故选择器必须独立成子组件
     ============================================================ -->

<template>
  <n-select
    :value="store.rateProvider"
    :options="providerOptions"
    size="small"
    class="provider-select"
    @update:value="onProviderChange"
  />
</template>

<script setup>
import { NSelect, useMessage } from 'naive-ui'
import { useDataStore } from '../stores/data.js'

const store = useDataStore()
const message = useMessage()

// 选项值与主进程 service.js 的 RATE_PROVIDERS 对应
const providerOptions = [
  { label: 'ExchangeRate-API', value: 'exchangerate' },
  { label: 'AllRatesToday', value: 'allratestoday' }
]

// 切换汇率源：成功才提交（store 内部保证），失败提示并保持原数据源
async function onProviderChange(value) {
  store.loading = true
  try {
    await store.changeRateProvider(value)
  } catch (e) {
    message.error('汇率源切换失败，已保留原数据源')
  } finally {
    store.loading = false
  }
}
</script>

<style scoped>
.provider-select {
  width: 180px;
}
</style>
