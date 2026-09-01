<template>
  <div class="ass-home">
    <!-- ============ 左列：查询参数 + 汇总结果（除日志外的全部内容）============ -->
    <div class="ass-left">
      <n-card title="统计代理" :bordered="false" content-style="padding: 0;" size="large">
        <template #header-extra>
          <n-space align="center" size="medium">
            <!-- ========== 右上角：携程账号区（登录/显示/注销）========== -->
            <template v-if="!sessionStatus.loggedIn">
              <n-button size="medium" type="default" dashed :disabled="running" @click="onLoginClick">
                <n-icon style="vertical-align:-2px;margin-right:4px;">
                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                    <path d="M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z"
                      fill="currentColor" />
                  </svg>
                </n-icon>
                登录携程
              </n-button>
              <n-tag type="error" round size="medium" :bordered="false">未登录</n-tag>
            </template>
            <template v-else>
              <n-tooltip trigger="hover" placement="bottom-end">
                <template #trigger>
                  <n-tag type="success" round size="large" :bordered="false">
                    <n-icon style="vertical-align:-2px;margin-right:4px;">
                      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
                        <path d="M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z"
                          fill="currentColor" />
                      </svg>
                    </n-icon>
                    {{ sessionStatus.accountDisplay || '携程账号' }}
                  </n-tag>
                </template>
                <div style="line-height:1.7;">
                  <div><n-text strong>登录时间：</n-text>{{ sessionStatus.loginAtText || '未知' }}</div>
                  <div><n-text strong>Cookies 数：</n-text>{{ sessionStatus.cookieCount ?? 0 }}</div>
                  <div v-if="sessionStatus.accountName"><n-text strong>账号名：</n-text>{{ sessionStatus.accountName }}
                  </div>
                </div>
              </n-tooltip>
              <n-button size="small" type="default" quaternary :disabled="running" @click="onLogoutClick">注销</n-button>
            </template>

            <!-- 原有的运行状态标签 -->
            <n-tag v-if="running" type="warning" round size="large">运行中</n-tag>
            <n-tag v-else type="success" round size="large">空闲</n-tag>
          </n-space>
        </template>

        <!-- ============ 查询参数输入区（组件） ============ -->
        <AssQueryForm
          v-model:file-path="filePath"
          v-model:airline="airline"
          v-model:date-range="dateRange"
          :running="running"
          :can-start="canStart"
          :output-dir="outputDir"
          @pick-file="onPickFile"
          @start="onStart"
          @open-output-dir="openOutputDir"
          @clear-stats="onClearStats"
        />

        <n-divider />

        <!-- ============ 汇总 / 结果 ============ -->
        <n-space vertical style="width:100%;">
          <n-alert v-if="!running && lastResult" type="success" title="任务完成" :show-icon="true">
            <div style="line-height:1.8;">
              <div><n-text strong>航线数：</n-text>{{ lastResult.parseInfo.pairsCount }}（跳过 {{
                lastResult.parseInfo.skippedRows }} 行
                / 去重 {{ lastResult.parseInfo.duplicateCount }} 条）</div>
              <div><n-text strong>日期数：</n-text>{{ lastResult.dateCount }} 天，总查询参数 {{ lastResult.queryParamTotal }} 条
              </div>
              <div><n-text strong>P1 分布：</n-text>
                有航班 {{ lastResult.counts.p1.true }} / 无航班 {{ lastResult.counts.p1.false }} / UNKNOWN {{
                  lastResult.counts.p1.null }}
              </div>
              <div><n-text strong>P2 分布：</n-text>
                OK {{ lastResult.counts.p2.OK }} / SKIP {{ lastResult.counts.p2.SKIP }} / ERROR {{
                  lastResult.counts.p2.ERROR }}
                <n-tag v-if="lastResult.counts.userHookErrors" type="error" size="small" style="margin-left:8px;">
                  用户处理函数异常 {{ lastResult.counts.userHookErrors }} 次（已自动降级写入默认行）
                </n-tag>
              </div>
              <div style="margin-top:8px;">
                <n-text strong>P1 文件：</n-text>
                <n-code>{{ lastResult.p1FilePath }}</n-code>
              </div>
              <div>
                <n-text strong>P2 文件：</n-text>
                <n-code>{{ lastResult.p2FilePath }}</n-code>
              </div>
            </div>
          </n-alert>

          <n-alert v-if="lastError && !running" type="error" title="任务失败" :show-icon="true">
            {{ lastError.message }}（{{ lastError.name }}）
          </n-alert>

          <n-alert v-if="outputDir" type="info" :show-icon="false">
            输出目录：<n-text code>{{ outputDir }}</n-text>
            （优先桌面，找不到则回落至 userData）
          </n-alert>
        </n-space>
      </n-card>
    </div>

    <!-- ============ 右列：日志区（组件，独立滚动） ============ -->
    <div class="ass-right">
      <n-card :bordered="false" content-style="padding: 0;height: 100%;min-height: 0;" size="large">
        <AssLogPanel :logs="logs" :stats="stats" />
      </n-card>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  NCard, NButton, NSpace, NDivider, NAlert, NText, NTag, NCode, NTooltip, NIcon
} from 'naive-ui'
import AssQueryForm from './components/AssQueryForm.vue'
import AssLogPanel from './components/AssLogPanel.vue'

// ============== 表单数据 ==============
const filePath = ref('')
const airline = ref('')
const dateRange = ref(null) // [startStr, endStr]

// ============== 运行状态 ==============
const running    = ref(false)
const lastResult = ref(null)
const lastError  = ref(null)
const outputDir  = ref('')
const logs       = ref([])
/** 航班统计排行榜（主进程 tjarr 快照，随 STATS 进度事件实时刷新）*/
const stats      = ref([])

// ============== 会话状态（携程登录）==============
// 单一事实源：从 ass:session:getStatus 拉一次，之后靠 onSessionChanged 更新
const sessionStatus = reactive({
  loggedIn: false,
  loginAt: null,
  loginAtText: null,
  cookieCount: 0,
  accountName: null,
  accountDisplay: null,
})

async function refreshSessionStatus() {
  try {
    const s = await window.api.ass.sessionGetStatus()
    if (!s) return
    sessionStatus.loggedIn = !!s.loggedIn
    sessionStatus.loginAt = s.loginAt ?? null
    sessionStatus.loginAtText = s.loginAtText ?? null
    sessionStatus.cookieCount = s.cookieCount ?? 0
    sessionStatus.accountName = s.accountName ?? null
    sessionStatus.accountDisplay = s.accountDisplay ?? null
  } catch (e) {
    console.warn('[ass] 刷新 session 状态失败:', e)
  }
}

async function onLoginClick() {
  try {
    const res = await window.api.ass.loginOpen()
    if (res && res.ok && res.message) {
      // 用日志提示一下（登录完成后 onSessionChanged 会自动更新 UI）
      pushLog({ type: 'LOGIN_OPEN', message: res.message })
    }
  } catch (e) {
    pushLog({ type: 'LOGIN_ERR', message: `打开登录窗口失败：${e?.message || e}` })
  }
}

async function onLogoutClick() {
  try {
    const res = await window.api.ass.sessionLogout()
    if (!res || !res.ok) {
      lastError.value = { name: 'LogoutError', message: (res && res.error) || '注销失败' }
      return
    }
    // 注销成功 → 强制刷新（注销 handler 内部也会 fire ass:session:changed，这里作双保险）
    await refreshSessionStatus()
  } catch (e) {
    lastError.value = { name: 'LogoutError', message: e?.message || String(e) }
  }
}

const canStart = computed(() => {
  if (!filePath.value) return false
  if (!Array.isArray(dateRange.value) || dateRange.value.length !== 2) return false
  if (!dateRange.value[0] || !dateRange.value[1]) return false
  return true
})

// ============== 辅助：日期值归一化 ============
// n-date-picker type=daterange 实际返回 timestamp(number)，即使写了 value-format 在某些版本也不生效；
// 此外要兼容 string 与 Date。统一输出 'YYYY-MM-DD'。
function normalizeDate(v) {
  if (v == null || v === '') return ''
  let d
  if (typeof v === 'number') d = new Date(v)
  else if (v instanceof Date) d = v
  else {
    const s = String(v).trim()
    // 已经是 YYYY-MM-DD？直接返回，避免时区偏移
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return s
    d = new Date(s)
  }
  if (isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ============================================================
// 日志核心：pushLog（新日志 unshift 到最顶端；结构化行与信息行统一入口）
// ============================================================
const MAX_LOGS = 500

/**
 * YYYY-MM-DD → YYYY/M/D（展示格式，去掉月份/日期前导零，斜杠分隔）
 */
function formatDateSlash(s) {
  if (!s) return ''
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s))
  if (m) return `${Number(m[1])}/${Number(m[2])}/${Number(m[3])}`
  return String(s)
}

function pushLog(payload) {
  if (!payload) return
  const now = new Date()
  const ts =
    now.toTimeString().slice(0, 8) +
    '.' +
    String(now.getMilliseconds()).padStart(3, '0')

  // ---------- P1 / P2 每次单请求：结构化行 ----------
  if (payload.type === 'P1_ITEM' || payload.type === 'P2_ITEM') {
    const qp = payload.qp || {}
    const dep = (qp.dep || '?').toUpperCase()
    const arr = (qp.arr || '?').toUpperCase()
    const route = `${dep}-${arr}`
    const dateDisplay = formatDateSlash(qp.date || payload.date)
    const row = {
      _ts: ts,
      _isItem: true,
      _phase: payload.type,
      _idx: payload.index ?? '?',
      _tot: payload.total ?? '?',
      _errorMsg: (payload.error && payload.error.message) ? payload.error.message : '',
      route,
      airline: qp.airline || '',
      dateDisplay,
      result: payload.result || '-',
      count: typeof payload.count === 'number' ? payload.count : 0,
    }
    logs.value.unshift(row)
    if (logs.value.length > MAX_LOGS) logs.value.length = MAX_LOGS
    return
  }

  // ---------- 其他：信息类行（START/DONE/FATAL/LOGIN_*）----------
  let kind = payload.phase || payload.type || 'INFO'
  let msg = ''
  if (payload.type === 'START') {
    kind = 'INIT'
    msg = `任务开始 → 日期 ${payload.options.startDate} ~ ${payload.options.endDate}，航司=${payload.options.airline || '(未指定)'}，输出=${payload.outputDir}`
  } else if (payload.type === 'DONE') {
    kind = 'DONE'
    const r = payload.result
    msg = `全部完成：P1 有${r.counts.p1.true} / 无${r.counts.p1.false} / ?${r.counts.p1.null}；P2 OK=${r.counts.p2.OK} / SKIP=${r.counts.p2.SKIP} / ERR=${r.counts.p2.ERROR}（TS=${r.ts}）`
  } else if (payload.type === 'FATAL') {
    kind = 'FATAL'
    msg = `${payload.error?.name || 'Error'}：${payload.error?.message || ''}`
  } else if (payload.type === 'LOGIN_REQUIRED') {
    kind = 'LOGIN'
    msg = payload.message || '检测到未登录，正在打开携程登录窗口…'
  } else if (payload.type === 'LOGIN_OK') {
    kind = 'LOGIN'
    const st = payload.status || {}
    msg = `登录成功 → ${st.accountDisplay || '账号已识别'}（Cookies=${st.cookieCount ?? 0}）`
  } else if (payload.type === 'LOGIN_CANCELLED') {
    kind = 'LOGIN'
    msg = payload.message || '登录被取消，任务将不再继续。'
  } else if (payload.type === 'LOGIN_OPEN') {
    kind = 'LOGIN'
    msg = payload.message || '已打开携程登录窗口'
  } else if (payload.type === 'LOGIN_ERR') {
    kind = 'ERROR'
    msg = payload.message || '登录相关异常'
  } else {
    // 兼容老事件（未带 type 的 payload，直接显示消息字符串）
    msg = payload._msg || payload.message || String(payload)
  }

  logs.value.unshift({ _ts: ts, _isItem: false, _kind: kind, _msg: msg })
  if (logs.value.length > MAX_LOGS) logs.value.length = MAX_LOGS
}

// ============== 操作 ==============
async function onPickFile() {
  const res = await window.api.ass.batchPickFile()
  if (res && res.ok) filePath.value = res.filePath
}

async function onStart() {
  // 清空前一轮结果
  lastResult.value = null
  lastError.value = null
  logs.value = []
  running.value = true

  try {
    const sd = normalizeDate(dateRange.value?.[0])
    const ed = normalizeDate(dateRange.value?.[1])
    if (!sd || !ed) {
      throw new Error(`日期格式不正确，请重新选择（起始=${sd || '空'}, 结束=${ed || '空'}）`)
    }
    const res = await window.api.ass.batchStart({
      filePath: filePath.value,
      airline: airline.value,
      startDate: sd,
      endDate: ed,
    })
    if (res && res.ok) {
      lastResult.value = res.result
    } else {
      lastError.value = { name: 'StartError', message: (res && res.error) || '未知失败原因' }
    }
  } catch (e) {
    lastError.value = { name: e?.name || 'Error', message: e?.message || String(e) }
  } finally {
    running.value = false
  }
}

function openOutputDir() {
  // 优先定位「最终文件」（本轮任务生成的 tjarr 统计报告 md）并在资源管理器中选中；
  // 没有则直接打开输出目录
  const tjPath = lastResult.value?.tjFilePath ?? null
  const target = tjPath || outputDir.value
  if (!target) return
  try {
    if (typeof window.api.ass?.outputOpen === 'function') {
      window.api.ass.outputOpen(outputDir.value || '', tjPath)
    }
  } catch {}
}

/** 清空航班统计（tjarr）——主进程处理并回推 STATS 事件刷新排行榜 */
async function onClearStats() {
  try {
    await window.api.ass.statsClear()
  } catch (e) {
    console.warn('[ass] 清空统计失败:', e)
  }
}

// ============== 事件订阅 ==============
// ⚠️ preload.js 的订阅型回调都是单参数：callback(data)，不能写成 (event, data)！
// 否则 data 会落到第一个参数位、data 形参变成 undefined → 被 if (!data) return 全吞。
let _progressOff = null
function onProgress(data) {
  // 统计快照 → 排行榜（不入日志）
  if (data && data.type === 'STATS') {
    stats.value = Array.isArray(data.entries) ? data.entries : []
    return
  }
  // 除了写日志，顺手处理几个带 session 的事件作为"事件丢了时的二次保险"
  if (data && data.type === 'LOGIN_OK') refreshSessionStatus()
  if (data && data.type === 'LOGIN_REQUIRED') refreshSessionStatus()
  if (data && data.type === 'LOGIN_CANCELLED') refreshSessionStatus()
  pushLog(data)
}
function onSessionChanged(data) {
  // session 变化时（登录成功 / 关闭登录窗 / 注销）同步刷新 reactive 对象
  if (!data) return
  sessionStatus.loggedIn = !!data.loggedIn
  sessionStatus.loginAt = data.loginAt ?? null
  sessionStatus.loginAtText = data.loginAtText ?? null
  sessionStatus.cookieCount = data.cookieCount ?? 0
  sessionStatus.accountName = data.accountName ?? null
  sessionStatus.accountDisplay = data.accountDisplay ?? null
}

onMounted(async () => {
  window.api.ass.onBatchProgress(onProgress)
  window.api.ass.onSessionChanged(onSessionChanged)
  _progressOff = () => {
    // Naive no-off: ipcRenderer.on 每次监听永久存在，页面切换不会泄漏太多（本页面常驻）
  }

  // 拉初始状态
  await Promise.all([refreshSessionStatus(), (async () => {
    try {
      const s = await window.api.ass.batchGetState()
      running.value    = !!s.running
      lastResult.value = s.lastResult
      lastError.value  = s.lastError
      outputDir.value  = s.outputDir || ''
      if (Array.isArray(s.stats)) stats.value = s.stats
    } catch {}
  })()])
})

onBeforeUnmount(() => {
  if (_progressOff) _progressOff()
})
</script>

<style scoped>
/* ============================================================
   左右布局：整页固定视口高度，两列各自独立滚动
   - 左列：查询参数 + 汇总结果（除日志外的全部内容）
   - 右列：日志区
   ============================================================ */
.ass-home {
  display: flex;
  flex-flow: row nowrap;
  height: 100vh;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
}

.ass-left,
.ass-right {
  height: 100%;
  min-height: 0;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 16px;
}

.ass-left {
  flex: 0.9;
  min-width: 0;
}

.ass-right {
  flex: 1;
  min-width: 0;
  padding-left: 8px;
}
</style>