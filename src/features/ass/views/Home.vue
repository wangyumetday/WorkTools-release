<!-- ============================================================
ASS Home.vue - 统计代理（携程低价政策推荐批量查询）
布局：顶部登录区 + 文件/控制卡片 + 进度卡片
流程：选择文件 →（userHooks.extractQueries 拆成多条请求）→ 代码自动持续请求
      →（userHooks.processQueryResult 处理返回数据）
数据流：window.api.ass.* 走主进程 AssSessionManager / AssBatchRunner
============================================================ -->
<template>
  <n-config-provider>
    <n-message-provider>
      <div class="ass-layout">
        <!-- 顶部：登录状态区 -->
        <n-card class="ass-card" :bordered="false" size="small">
          <div class="ass-login-bar">
            <div class="ass-login-info">
              <span class="ass-title">低价政策推荐 · 批量查询</span>
              <n-tag :type="sessionStatus.loggedIn ? 'success' : 'warning'" size="small" round>
                {{ sessionStatus.loggedIn ? '已登录' : '未登录' }}
              </n-tag>
              <span v-if="sessionStatus.loggedIn && sessionStatus.loginAt" class="ass-login-at">
                登录时间：{{ formatTime(sessionStatus.loginAt) }}
              </span>
            </div>
            <div class="ass-login-actions">
              <n-button v-if="!sessionStatus.loggedIn" type="primary" size="small" @click="openLogin">
                打开登录页
              </n-button>
              <n-button v-else size="small" @click="logout">
                退出登录
              </n-button>
            </div>
          </div>
        </n-card>

        <!-- 文件与控制区 -->
        <n-card class="ass-card" :bordered="false" size="small" title="数据文件">
          <div class="ass-file-row">
            <n-button size="small" type="primary" ghost @click="pickFile">选择文件</n-button>
            <span class="ass-file-name">{{ batch.fileName || '未选择文件' }}</span>
            <n-tag v-if="batch.total > 0" type="info" size="small" round>
              提取到 {{ batch.total }} 条查询请求
            </n-tag>
          </div>
          <n-divider style="margin: 12px 0" />
          <div class="ass-ctl-row">
            <n-form inline label-placement="left" label-width="auto" size="small">
              <n-form-item label="并发数(1-3)">
                <n-input-number v-model:value="ctl.concurrency" :min="1" :max="3" style="width: 72px" />
              </n-form-item>
              <n-form-item label="请求间隔(ms)">
                <n-input-number v-model:value="ctl.intervalMs" :min="300" :step="100" style="width: 100px" />
              </n-form-item>
              <n-form-item>
                <n-space>
                  <n-button type="primary" size="small" :loading="isRunning" :disabled="!canStart" @click="start">
                    {{ batch.status === 'paused' ? '继续' : '开始' }}
                  </n-button>
                  <n-button size="small" :disabled="batch.status !== 'running'" @click="pause">暂停</n-button>
                  <n-button size="small" :disabled="batch.status !== 'running' && batch.status !== 'paused'" @click="stop">
                    停止
                  </n-button>
                </n-space>
              </n-form-item>
            </n-form>
          </div>
          <div class="ass-hint">
            文件解析与请求拆分：electron/features/ass/userHooks.js 的 extractQueries
            ｜ 返回数据处理：同文件 processQueryResult（改后重启应用生效）
          </div>
        </n-card>

        <!-- 进度区 -->
        <n-card class="ass-card" :bordered="false" size="small" title="批处理进度">
          <div class="ass-progress-row">
            <n-progress type="line" :percentage="percent" :indicator-placement="'inside'" :height="18" />
            <n-tag size="small" :type="statusTagType">{{ statusText }}</n-tag>
          </div>
          <div class="ass-stats">
            <n-statistic label="总请求数" :value="batch.total" />
            <n-statistic label="已完成" :value="batch.done" />
            <n-statistic label="成功" :value="batch.success">
              <template #suffix>
                <span class="ass-stat-suffix ass-stat-ok"> </span>
              </template>
            </n-statistic>
            <n-statistic label="请求失败" :value="batch.requestFailed">
              <template #suffix>
                <span class="ass-stat-suffix ass-stat-bad"> </span>
              </template>
            </n-statistic>
            <n-statistic label="处理失败" :value="batch.processFailed" />
            <n-statistic label="跳过" :value="batch.skipped" />
          </div>
          <n-alert v-if="batch.error" type="error" size="small" style="margin-top: 10px" :show-icon="false">
            {{ batch.error }}
          </n-alert>
        </n-card>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
// ============================================================
// 逻辑区：会话状态 + 批处理控制 + 进度订阅
// ============================================================
import { computed, onMounted, reactive } from 'vue'
import {
  NAlert, NButton, NCard, NDivider, NForm, NFormItem, NInputNumber,
  NProgress, NSpace, NStatistic, NTag
} from 'naive-ui'
import message from '@/shared/message.js'

// ---------- 会话状态 ----------
const sessionStatus = reactive({ loggedIn: false, loginAt: null, cookieCount: 0 })

function applySessionStatus(status) {
  sessionStatus.loggedIn = !!status?.loggedIn
  sessionStatus.loginAt = status?.loginAt ?? null
  sessionStatus.cookieCount = status?.cookieCount ?? 0
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function openLogin() {
  await window.api.ass.loginOpen()
}

async function logout() {
  await window.api.ass.sessionLogout()
  message.success('已退出登录')
}

// ---------- 批处理状态 ----------
const batch = reactive({
  status: 'idle', // idle | running | paused | finished | stopped
  fileName: '',
  total: 0,
  done: 0,
  success: 0,
  requestFailed: 0,
  processFailed: 0,
  skipped: 0,
  error: null
})

const ctl = reactive({ concurrency: 1, intervalMs: 500 })

function applyBatchState(state) {
  if (!state) return
  Object.assign(batch, state)
}

const isRunning = computed(() => batch.status === 'running')
const hasFile = computed(() => batch.total > 0)
const canStart = computed(
  () => sessionStatus.loggedIn && hasFile.value && batch.status !== 'running'
)

const percent = computed(() => {
  const totalDone = batch.done + batch.skipped
  if (!batch.total) return 0
  return Math.min(100, Math.round((totalDone / batch.total) * 100))
})

const statusText = computed(() => {
  const map = {
    idle: '待启动',
    running: '运行中',
    paused: '已暂停',
    finished: '已完成',
    stopped: '已停止'
  }
  return map[batch.status] ?? batch.status
})

const statusTagType = computed(() => {
  const map = {
    idle: 'default',
    running: 'info',
    paused: 'warning',
    finished: 'success',
    stopped: 'error'
  }
  return map[batch.status] ?? 'default'
})

// ---------- 控制动作 ----------
async function pickFile() {
  const result = await window.api.ass.batchPickFile()
  if (result?.canceled) return
  if (!result?.ok) {
    message.error(result?.error || '选择文件失败')
    return
  }
  applyBatchState({
    status: 'idle',
    fileName: result.fileName,
    total: result.count,
    done: 0, success: 0, requestFailed: 0, processFailed: 0, skipped: 0, error: null
  })
  message.success(`已读取文件，提取到 ${result.count} 条查询请求`)
}

async function start() {
  if (!sessionStatus.loggedIn) {
    message.warning('请先打开登录页完成登录')
    return
  }
  const result = await window.api.ass.batchStart({ ...ctl })
  if (!result?.ok) {
    message.error(result?.error || '启动失败')
  }
}

async function pause() {
  await window.api.ass.batchPause()
}

async function stop() {
  await window.api.ass.batchStop()
  message.info('已发送停止指令，剩余任务将跳过')
}

// ---------- 生命周期 ----------
onMounted(async () => {
  applySessionStatus(await window.api.ass.sessionGetStatus())
  applyBatchState(await window.api.ass.batchGetState())
  window.api.ass.onSessionChanged(applySessionStatus)
  window.api.ass.onBatchProgress(applyBatchState)
})
</script>

<style scoped>
.ass-layout {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100vh;
  padding: 16px;
  box-sizing: border-box;
  overflow: hidden;
}

.ass-login-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.ass-login-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ass-title {
  font-weight: 600;
  font-size: 15px;
}

.ass-login-at {
  color: #888;
  font-size: 12px;
}

.ass-file-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ass-file-name {
  color: #555;
  font-size: 13px;
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ass-ctl-row {
  display: flex;
  align-items: center;
}

.ass-hint {
  margin-top: 8px;
  color: #999;
  font-size: 12px;
}

.ass-progress-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.ass-progress-row .n-progress {
  flex: 1;
}

.ass-stats {
  display: flex;
  gap: 40px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.ass-stat-suffix {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 4px;
  vertical-align: middle;
}

.ass-stat-ok {
  background: #18a058;
}

.ass-stat-bad {
  background: #d03050;
}
</style>