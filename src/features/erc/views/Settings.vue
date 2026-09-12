<!-- ============================================================
     ERC Settings.vue - 汇率服务配置页
     职责：
       - 配置两个汇率源（exchangerate / allratestoday）的请求地址与 Key
       - 配置 ERC 全局汇率自动刷新频率（分钟，不按源区分）
     数据流：api.erc.configGet/configSet → 主进程 configManager
       userData/config/ercConfig.json；保存后由主进程即时重置定时器
       并立即拉取一次当前源做网络验证（失败不回滚配置）
     说明：本组件渲染于 Home.vue 的 <n-message-provider> 内，可直接 useMessage
     ============================================================ -->

<template>
  <div class="erc-settings">
    <div v-if="loading" class="settings-tip">正在加载配置...</div>

    <template v-else>
      <!-- 两个汇率源各一张卡片：地址 + Key -->
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

      <div class="settings-actions">
        <n-button type="primary" size="small" :loading="saving" @click="onSave">保存</n-button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { NInput, NInputNumber, NButton, useMessage } from 'naive-ui'
import api from '@/shared/api.js'

const message = useMessage()

// 与主进程 configManager.js 的边界保持一致
const INTERVAL_MIN = 1
const INTERVAL_MAX = 1440

// 展示顺序与标签（值与 service.js RATE_PROVIDERS 对应）
const providerDefs = [
  { id: 'exchangerate', label: 'ExchangeRate-API' },
  { id: 'allratestoday', label: 'AllRatesToday' }
]

const loading = ref(true)
const saving = ref(false)

const form = reactive({
  providers: {
    exchangerate: { baseUrl: '', key: '' },
    allratestoday: { baseUrl: '', key: '' }
  },
  refreshIntervalMin: 30
})

onMounted(async () => {
  try {
    const cfg = await api.erc.configGet()
    for (const p of providerDefs) {
      form.providers[p.id].baseUrl = cfg.providers[p.id].baseUrl
      form.providers[p.id].key = cfg.providers[p.id].key
    }
    form.refreshIntervalMin = cfg.refreshIntervalMin
  } catch {
    message.error('配置读取失败')
  } finally {
    loading.value = false
  }
})

// 渲染层预校验（与主进程 validate 规则一致，提前拦截、少一次 IPC 往返）
function validateForm() {
  for (const p of providerDefs) {
    const baseUrl = form.providers[p.id].baseUrl.trim()
    if (!/^https?:\/\/.+/.test(baseUrl)) {
      return `${p.label} 的地址必须以 http:// 或 https:// 开头`
    }
    if (!form.providers[p.id].key.trim()) {
      return `${p.label} 的 Key 不能为空`
    }
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
        allratestoday: {
          baseUrl: form.providers.allratestoday.baseUrl.trim(),
          key: form.providers.allratestoday.key.trim()
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
