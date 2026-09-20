<!-- ============================================================
     ERC Settings.vue - 汇率服务 + 悬浮窗外观配置页
     职责：
       - 配置汇率源（exchangerate）与币种富信息源（restcountries）的请求地址与 Key
       - 配置 ERC 全局汇率自动刷新频率（分钟，不按源区分）
       - 配置悬浮窗缩放因子、透明度与固定展开态变暗透明度（原位于悬浮窗底部滑块，迁移至此统一管理）
     数据流：
       - 汇率源/频率：api.erc.configGet/configSet → 主进程 configManager
         userData/config/ercConfig.json；保存后由主进程即时重置定时器
         并立即拉取一次当前源做网络验证（失败不回滚配置）
       - 悬浮窗缩放/透明度：拖动滑块实时 api.floating.setZoom/setOpacity 应用到
         悬浮窗；防抖 500ms 调 api.floating.saveConfig 持久化，主进程广播
         configUpdated 让悬浮窗更新 base 值。
     说明：本组件渲染于 Home.vue 的 <n-message-provider> 内，可直接 useMessage
     ============================================================ -->

<template>
  <div class="erc-settings">
    <div v-if="loading" class="settings-tip">正在加载配置...</div>

    <template v-else>
      <!-- 汇率源 + 币种富信息源各一张卡片：地址 + Key -->
      <div v-for="p in providerDefs" :key="p.id" class="provider-card">
        <div class="card-title">{{ p.label }}</div>
        <div class="form-row">
          <label>请求地址</label>
          <n-input
            v-model:value="form.providers[p.id].baseUrl"
            placeholder="https://..."
            size="small"
          />
        </div>
        <div class="form-row">
          <label>Key</label>
          <n-input
            v-model:value="form.providers[p.id].key"
            type="password"
            show-password-on="click"
            placeholder="API Key"
            size="small"
          />
        </div>
      </div>

      <!-- 全局刷新频率 -->
      <div class="provider-card">
        <div class="card-title">自动刷新</div>
        <div class="form-row form-row-inline">
          <label>每</label>
          <n-input-number
            v-model:value="form.refreshIntervalMin"
            :min="INTERVAL_MIN"
            :max="INTERVAL_MAX"
            :precision="0"
            size="small"
            class="interval-input"
          />
          <label>分钟自动刷新一次汇率（全局，1～1440）</label>
        </div>
      </div>

      <!-- 悬浮窗外观：缩放 + 透明度（拖动实时生效 + 防抖持久化） -->
      <div class="provider-card">
        <div class="card-title">悬浮窗外观</div>
        <div class="form-row">
          <label>缩放（{{ form.floating.zoom.toFixed(2) }}x）</label>
          <n-slider
            v-model:value="form.floating.zoom"
            :min="ZOOM_MIN"
            :max="ZOOM_MAX"
            :step="0.05"
            @update:value="onZoomChange"
          />
        </div>
        <div class="form-row">
          <label>透明度（{{ Math.round(form.floating.opacity * 100) }}%）</label>
          <n-slider
            v-model:value="form.floating.opacity"
            :min="OPACITY_MIN"
            :max="OPACITY_MAX"
            :step="0.05"
            @update:value="onOpacityChange"
          />
        </div>
        <div class="form-row">
          <label>固定展开后鼠标离开时透明度（{{ Math.round(form.floating.dimOpacity * 100) }}%，设为100%则不变暗）</label>
          <n-slider
            v-model:value="form.floating.dimOpacity"
            :min="DIM_OPACITY_MIN"
            :max="DIM_OPACITY_MAX"
            :step="0.05"
            @update:value="onDimOpacityChange"
          />
        </div>
      </div>

      <div class="settings-actions">
        <n-button type="primary" size="small" :loading="saving" @click="onSave">保存</n-button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted, onUnmounted } from 'vue'
import { NInput, NInputNumber, NButton, NSlider, useMessage } from 'naive-ui'
import api from '@/shared/api.js'

const message = useMessage()

// 与主进程 configManager.js 的边界保持一致
const INTERVAL_MIN = 1
const INTERVAL_MAX = 1440
const OPACITY_MIN = 0.1
const OPACITY_MAX = 1.0
// 固定展开态鼠标离开后的变暗透明度边界（与主进程 configManager 对齐）
const DIM_OPACITY_MIN = 0.05
const DIM_OPACITY_MAX = 1.0
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.5
// 悬浮窗外观持久化防抖：拖动滑块实时应用，但写盘合并为最后一次后 500ms
const FLOATING_SAVE_DEBOUNCE_MS = 500

// 展示顺序与标签（值与 configManager.js DEFAULT_CONFIG.providers 对应）
const providerDefs = [
  { id: 'exchangerate', label: 'ExchangeRate-API（汇率源）' },
  { id: 'restcountries', label: '币种富信息源API（中文名、国旗图标）' }
]

const loading = ref(true)
const saving = ref(false)

const form = reactive({
  providers: {
    exchangerate: { baseUrl: '', key: '' },
    restcountries: { baseUrl: '', key: '' }
  },
  refreshIntervalMin: 30,
  floating: { opacity: 1.0, zoom: 1.0, dimOpacity: 0.1 }
})

onMounted(async () => {
  try {
    const cfg = await api.erc.configGet()
    for (const p of providerDefs) {
      form.providers[p.id].baseUrl = cfg.providers[p.id].baseUrl
      form.providers[p.id].key = cfg.providers[p.id].key
    }
    form.refreshIntervalMin = cfg.refreshIntervalMin
    if (cfg.floating) {
      form.floating.opacity = cfg.floating.opacity
      form.floating.zoom = cfg.floating.zoom
      if (Number.isFinite(cfg.floating.dimOpacity)) {
        form.floating.dimOpacity = cfg.floating.dimOpacity
      }
    }
  } catch {
    message.error('配置读取失败')
  } finally {
    loading.value = false
  }
})

// ==================== 悬浮窗外观：实时应用 + 防抖持久化 ====================
let floatingSaveTimer = null
function scheduleFloatingSave() {
  if (floatingSaveTimer) clearTimeout(floatingSaveTimer)
  floatingSaveTimer = setTimeout(() => {
    floatingSaveTimer = null
    api.floating.saveConfig({ opacity: form.floating.opacity, zoom: form.floating.zoom, dimOpacity: form.floating.dimOpacity }).catch(() => {
      // 持久化失败不打断操作（实时应用已生效，下次拖动会重试）
    })
  }, FLOATING_SAVE_DEBOUNCE_MS)
}
function onZoomChange(v) {
  form.floating.zoom = v
  api.floating.setZoom(v)          // 实时应用到悬浮窗
  scheduleFloatingSave()           // 防抖持久化
}
function onOpacityChange(v) {
  form.floating.opacity = v
  api.floating.setOpacity(v)       // 实时应用到悬浮窗
  scheduleFloatingSave()           // 防抖持久化
}
function onDimOpacityChange(v) {
  form.floating.dimOpacity = v
  // 无独立实时 IPC：防抖 saveConfig 落盘后广播 configUpdated，
  // 悬浮窗重算 dim 目标值（鼠标在窗外时最多延迟 500ms 生效）
  scheduleFloatingSave()
}

onUnmounted(() => {
  if (floatingSaveTimer) {
    clearTimeout(floatingSaveTimer)
    floatingSaveTimer = null
  }
})

// 渲染层预校验（与主进程 validate 规则一致，提前拦截、少一次 IPC 往返）
// exchangerate 必填（汇率唯一源）；restcountries 允许留空（留空则用默认值）
function validateForm() {
  const exBaseUrl = form.providers.exchangerate.baseUrl.trim()
  if (!/^https?:\/\/.+/.test(exBaseUrl)) {
    return 'ExchangeRate-API 的地址必须以 http:// 或 https:// 开头'
  }
  if (!form.providers.exchangerate.key.trim()) {
    return 'ExchangeRate-API 的 Key 不能为空'
  }
  const rcBaseUrl = form.providers.restcountries.baseUrl.trim()
  if (rcBaseUrl && !/^https?:\/\/.+/.test(rcBaseUrl)) {
    return '币种富信息源的地址必须以 http:// 或 https:// 开头'
  }
  const n = Number(form.refreshIntervalMin)
  if (!Number.isInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX) {
    return `刷新频率必须是 ${INTERVAL_MIN}～${INTERVAL_MAX} 之间的整数`
  }
  return null
}

async function onSave() {
  const err = validateForm()
  if (err) {
    message.error(err)
    return
  }
  saving.value = true
  try {
    const payload = {
      providers: {
        exchangerate: {
          baseUrl: form.providers.exchangerate.baseUrl.trim(),
          key: form.providers.exchangerate.key.trim()
        },
        restcountries: {
          baseUrl: form.providers.restcountries.baseUrl.trim(),
          key: form.providers.restcountries.key.trim()
        }
      },
      refreshIntervalMin: Number(form.refreshIntervalMin)
    }
    const res = await api.erc.configSet(payload)
    if (res?.ok) {
      message.success('配置已保存，新地址与刷新频率即时生效')
    } else if (res?.stage === 'validate') {
      // 理论上渲染层已拦截，兜底展示主进程校验信息
      message.error(res.error || '配置校验失败')
    } else {
      // 网络验证失败：配置已落盘（可能只是临时网络问题），明确告知用户
      message.warning(`配置已保存，但当前汇率源验证失败：${res?.error || '网络错误'}`)
    }
  } catch (e) {
    message.error('保存失败：' + (e?.message || '未知错误'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.erc-settings {
  max-width: 640px;
  padding: 8px 4px;
}
.settings-tip {
  padding: 24px 0;
  color: #888;
  font-size: 13px;
}
.provider-card {
  border: 1px solid #333;
  border-radius: 4px;
  padding: 14px 16px;
  margin-bottom: 14px;
  background: #252525;
}
.card-title {
  font-size: 13px;
  color: #63e2b7;
  margin-bottom: 12px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.form-row:last-child {
  margin-bottom: 0;
}
.form-row label {
  font-size: 12px;
  color: #999;
}
.form-row-inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.interval-input {
  width: 110px;
}
.settings-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
