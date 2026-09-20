<!-- ============================================================
     ERC Home.vue - 汇率转换主页
     职责：
       - 顶部 tabs 切换"全部币种 / 设置"两个页面（汇率转换页已移除）
       - 全局 loading modal（拉取汇率时显示）
       - onMounted 初始化币种和汇率数据（若今日已同步则跳过）
     主题：darkTheme（保留原 currencyExchangeTool 暗色风格）
     布局：n-config-provider + n-message-provider + n-layout
     ============================================================ -->

<template>
  <n-config-provider :theme="darkTheme">
    <n-message-provider>
      <div class="erc-home">
        <div class="erc-header">
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
            <n-button size="small" @click="api.floating.open()">打开悬浮窗</n-button>
          </div>
        </div>

        <!-- 全局 loading：拉取汇率时显示 -->
        <n-modal :show="store.loading" transform-origin="center">
          <n-spin :show="store.loading" :scale="0.60" :stroke-width="16" stroke="rgba(99, 226, 183, 0.7)" class="loading-spin">
            <template #description>
              <div class="loading-text">正在更新汇率...</div>
            </template>
          </n-spin>
        </n-modal>

        <!-- 币种列表加载失败提示条：API 拉取失败时醒目提示，附重试按钮 -->
        <div v-if="store.loadError" class="erc-load-error">
          <span class="erc-load-error-text">币种数据加载失败，请检查网络或 API 配置后重试</span>
          <button class="erc-load-error-retry" :disabled="retrying" @click="retryLoadCountries">重试</button>
        </div>

        <div class="erc-content">
          <n-tabs
            v-model:value="activeTab"
            type="line"
            animated
            class="erc-tabs"
            :pane-wrapper-style="{
              flex: '1 1 auto',
              minHeight: '0',
              minWidth: '0',
              overflow: 'hidden'
            }"
            :pane-style="{
              height: '100%',
              minHeight: '0',
              minWidth: '0',
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column'
            }"
          >
            <!-- 全部币种：展示所有币种（纯展示，无点选） -->
            <n-tab-pane name="all" tab="全部币种">
              <addCurrency :selectable="false" />
            </n-tab-pane>
            <!-- 设置：汇率源地址/Key 与全局刷新频率 -->
            <n-tab-pane name="settings" tab="设置">
              <Settings />
            </n-tab-pane>
          </n-tabs>
        </div>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  NConfigProvider, darkTheme, NMessageProvider,
  NTabs, NTabPane, NModal, NSpin, NButton
} from 'naive-ui'
import { useDataStore } from '../stores/data.js'
import api from '@/shared/api.js'
import addCurrency from '../components/addCurrency.vue'
import Settings from './Settings.vue'

const store = useDataStore()

// 当前激活的 tab：全部币种 / 设置
const activeTab = ref('all')

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

// 手动重试币种列表拉取：store.loadError 为 true 时由用户点击触发
//   不复用 store.loading（loading 语义是"汇率拉取中"），用本地 ref 控制 button disabled
//   重试成功后必须再调 updata_exchangeRates：load 拉的是国家列表（rate=0），
//   需要单独拉汇率才有 rate，否则 seedDefaultCurrencies 种入的 CNY/USD rate=0 算不出值
const retrying = ref(false)
async function retryLoadCountries() {
  if (retrying.value) return
  retrying.value = true
  try {
    await store.load_all_countries_list()
    if (store.loadError) return
    await store.updata_exchangeRates()
    // 重试成功后联动种入默认币种（若之前因 loadError 未执行）
    store.seedDefaultCurrencies()
  } finally {
    retrying.value = false
  }
}

// 初始化：拉国家列表 → 拉汇率 → 种入默认 CNY/USD
// 关键：currencies_list 不再持久化（改由主进程 fetchCountriesWithCache 管理），
//   冷启动 fresh 数据里 rate 全是 0，必须每次都拉一次 rate；旧逻辑用 syncDate
//   判断"今天是否拉过"已失效，因为 currencies_list 持久化的前提不存在了。
onMounted(async () => {
  store.loading = true
  try {
    if (store.currencies_list.length === 0) {
      await store.load_all_countries_list()
    }
    // 加载失败：loadError=true 已驱动顶部错误条，后续步骤无意义，早 return
    if (store.loadError) return
    await store.updata_exchangeRates()
    // 首次加载种入默认 CNY/USD（仅 activeCurrency 为空时生效）
    store.seedDefaultCurrencies()
  } finally {
    store.loading = false
  }
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
  min-height: 0;
  background: #1e1e1e;
  color: #fff;
  display: flex;
  flex-flow: column nowrap;
  /* flex-direction: column; */
  overflow: hidden;
}
.erc-header {
  padding: 16px 24px;
  border-bottom: 1px solid #333;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
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
/* 币种列表加载失败提示条：紧贴 header 下方，红底白字醒目 */
.erc-load-error {
  flex-shrink: 0;
  padding: 10px 24px;
  background: rgba(220, 50, 50, 0.92);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.erc-load-error-text {
  flex: 1 1 auto;
}
.erc-load-error-retry {
  flex: 0 0 auto;
  padding: 4px 14px;
  background: #fff;
  color: #d63232;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}
.erc-load-error-retry:hover:not(:disabled) {
  background: #f0f0f0;
}
.erc-load-error-retry:disabled {
  cursor: default;
  opacity: 0.55;
}
.erc-content {
  padding: 16px 24px;
  /* flex: 1 1 auto; */
  flex: 1;
  min-height: 0;
  /* height: 100%; */
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}
/*
 * 整个页面不滚动，只让当前 Tab 的内容区域滚动。
 * 页面 -> content -> tabs -> pane wrapper -> pane，每一级都允许 flex 子项收缩。
 */
.erc-tabs {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.erc-tabs :deep(.n-tabs-nav) {
  flex: 0 0 auto;
}
.erc-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.erc-tabs :deep(.n-tab-pane) {
  min-height: 0;
  min-width: 0;
  overflow: auto;
  box-sizing: border-box;
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
