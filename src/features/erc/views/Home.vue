<!-- ============================================================
     ERC Home.vue - 汇率转换主页
     职责：
       - 顶部 tabs 切换"汇率转换"和"全部币种"两个页面（替代原侧边栏导航）
       - 全局 loading modal（拉取汇率时显示）
       - onMounted 初始化币种和汇率数据（若今日已同步则跳过）
     主题：darkTheme（保留原 currencyExchangeTool 暗色风格）
     布局：n-config-provider + n-message-provider + n-layout
     ============================================================ -->

<template>
  <n-config-provider :theme="darkTheme">
    <n-message-provider>
      <n-layout class="erc-home">
        <n-layout-header class="erc-header">
          <h2>汇率转换</h2>
          <n-button size="small" @click="api.floating.open()">打开悬浮窗</n-button>
        </n-layout-header>

        <!-- 全局 loading：拉取汇率时显示 -->
        <n-modal :show="store.loading" transform-origin="center">
          <n-spin :show="store.loading" :scale="0.60" :stroke-width="16" stroke="rgba(99, 226, 183, 0.7)" class="loading-spin">
            <template #description>
              <div class="loading-text">正在更新汇率...</div>
            </template>
          </n-spin>
        </n-modal>

        <n-layout-content class="erc-content" :native-scrollbar="false">
          <n-tabs v-model:value="activeTab" type="line" animated>
            <!-- 汇率转换：多币种同步换算 + 加币种 drawer -->
            <n-tab-pane name="converter" tab="汇率转换">
              <CurrencyConverter />
            </n-tab-pane>
            <!-- 全部币种：展示所有币种网格，点击可加入换算 -->
            <n-tab-pane name="all" tab="全部币种">
              <addCurrency />
            </n-tab-pane>
          </n-tabs>
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import {
  NConfigProvider, darkTheme, NMessageProvider, NLayout, NLayoutHeader,
  NLayoutContent, NTabs, NTabPane, NModal, NSpin, NButton
} from 'naive-ui'
import { useDataStore } from '../stores/data.js'
import api from '@/shared/api.js'
import CurrencyConverter from './CurrencyConverter.vue'
import addCurrency from '../components/addCurrency.vue'

const store = useDataStore()

// 当前激活的 tab：汇率转换 / 全部币种
const activeTab = ref('converter')

// 初始化：若币种列表空则拉国家列表，若今日未同步汇率则更新
onMounted(async () => {
  store.loading = true
  const today = new Date().toISOString().substring(0, 10)
  if (store.currencies_list.length === 0) {
    await store.load_all_countries_list()
  }
  if (store.syncDate !== today) {
    await store.updata_exchangeRates()
  }
  store.loading = false
})
</script>

<style scoped>
.erc-home {
  width: 100%;
  height: 100vh;
  background: #1e1e1e;
  color: #fff;
}
.erc-header {
  padding: 16px 24px;
  border-bottom: 1px solid #333;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.erc-content {
  padding: 16px 24px;
}
.loading-spin {
  width: 280px;
  height: 48px;
  line-height: 48px;
  background-color: rgba(99, 226, 183, 0.08);
  display: flex;
  flex-flow: row nowrap;
  justify-content: center;
  align-items: center;
  border-radius: 4px;
}
.loading-text {
  font-size: 20px;
  color: rgba(99, 226, 183, 0.7);
  margin: 0 0 0 8px;
}
</style>
