<!-- ============================================================
     ERC Home.vue - 汇率转换主页
     职责：
       - 顶部 tabs 切换"汇率转换 / 全部币种 / 设置"三个页面（替代原侧边栏导航）
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
          <div class="header-title">
            <h2>汇率转换</h2>
            <span class="update-time">
              <button class="btn-refresh" :class="{ spinning: store.loading }"
                      :disabled="store.loading" @click="refreshRates"
                      title="手动刷新汇率" aria-label="刷新汇率">
                <svg class="icon-refresh" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M21 3v6h-6" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              汇率上次更新：{{ lastUpdateLabel || '暂无数据' }}
            </span>
          </div>
          <div class="header-actions">
            <ProviderSelect />
            <n-button size="small" @click="api.floating.open()">打开悬浮窗</n-button>
          </div>
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
            <!-- 设置：汇率源地址/Key 与全局刷新频率 -->
            <n-tab-pane name="settings" tab="设置">
              <Settings />
            </n-tab-pane>
          </n-tabs>
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  NConfigProvider, darkTheme, NMessageProvider, NLayout, NLayoutHeader,
  NLayoutContent, NTabs, NTabPane, NModal, NSpin, NButton
} from 'naive-ui'
import { useDataStore } from '../stores/data.js'
import api from '@/shared/api.js'
import CurrencyConverter from './CurrencyConverter.vue'
import addCurrency from '../components/addCurrency.vue'
import ProviderSelect from '../components/ProviderSelect.vue'
import Settings from './Settings.vue'

const store = useDataStore()

// 当前激活的 tab：汇率转换 / 全部币种
const activeTab = ref('converter')

// 汇率上次更新时间（本地时区 YYYY-MM-DD HH:mm），无数据时不展示
const lastUpdateLabel = computed(() => {
  const t = store.lastUpdateTime
  if (!t) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`
})

// 手动刷新汇率：复用 store.updata_exchangeRates（成功后 applyRateUpdate 会更新 lastUpdateTime）
async function refreshRates() {
  if (store.loading) return
  store.loading = true
  try {
    await store.updata_exchangeRates()
  } finally {
    store.loading = false
  }
}

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
  // 首次加载种入默认 CNY/USD（仅 activeCurrency 为空时生效）
  store.seedDefaultCurrencies()
  store.loading = false
  // 订阅主进程定时刷新推送（间隔在 ERC 设置页配置，默认 30 分钟）
  // 主进程单点调度，渲染层只接收，无需本地 setInterval
  api.erc.onRateUpdated((res) => {
    store.handleRateBroadcast(res)
  })
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
.header-title {
  display: flex;
  align-items: baseline;
  gap: 14px;
}
.header-title h2 {
  margin: 0;
  font-size: 18px;
}
/* 汇率上次更新时间：小字 + 刷新按钮 */
.update-time {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}
.btn-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: rgba(99, 226, 183, 0.85);
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.12s, color 0.12s;
}
.btn-refresh:hover:not(:disabled) {
  background: rgba(99, 226, 183, 0.15);
  color: #63e2b7;
}
.btn-refresh:disabled {
  cursor: default;
  opacity: 0.6;
}
.icon-refresh {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
/* 刷新中旋转动画 */
.btn-refresh.spinning .icon-refresh {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
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
