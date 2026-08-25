<!-- ============================================================
     PCP TaskMonitor.vue - 任务监控器组件
     设计：
       顶部：标题行（左：任务队列标题+状态标签；右：并发设置）
             统计行（4 个小格：总数/完成/失败/等待 + 开始/暂停/清空按钮）
       中部（剩余高度，n-scrollbar 滚动）：
             表头（sticky）+ 任务行列表
             每行：背景进度条 + 内容层（ID · 类型 · % · 状态 · 耗时）
     数据流：
       - 全部状态来自 useTaskStore
       - 操作按钮触发 store action
     ============================================================ -->

<template>
  <div class="task-monitor">
    <n-card :bordered="false" size="small" style="height: 100%; border-radius: 0;">
      <!-- ============ header ============ -->
      <template #header>
        <div class="tm-top">
          <!-- 第 1 行：标题 + 并发 -->
          <div class="tm-top__row1">
            <div class="tm-row1-left">
              <span class="tm-title">任务队列</span>
              <n-tag
                :type="store.isRunning ? 'success' : 'default'"
                size="small"
                round
                :bordered="false"
                style="margin-left: 8px;"
              >
                {{ store.isRunning ? '运行中' : '已停止' }}
              </n-tag>
              <n-tag v-if="store.isPaused" type="warning" size="small" round :bordered="false">
                暂停
              </n-tag>
              <n-tag v-if="store.isRunning" size="small" round :bordered="false" type="info" style="margin-left: 4px;">
                {{ store.activeCount }}/{{ store.concurrency }}
              </n-tag>
            </div>
            <div class="tm-row1-right">
              <n-text depth="3" style="font-size: 12px; margin-right: 6px;">并发</n-text>
              <n-input-number
                v-model:value="store.concurrency"
                :min="1" :max="10" :step="1"
                size="small"
                style="width: 80px;"
                @update:value="store.handleSetConcurrency"
              />
            </div>
          </div>

          <!-- 第 2 行：统计 + 操作按钮（工整对齐） -->
          <div class="tm-top__row2">
            <!-- 4 个统计块：等宽平分 -->
            <div class="tm-stats">
              <div class="tm-stat tm-stat--total">
                <div class="tm-stat__val">{{ store.tasks.length }}</div>
                <div class="tm-stat__lbl">总数</div>
              </div>
              <div class="tm-stat tm-stat--done">
                <div class="tm-stat__val">{{ store.completedCount }}</div>
                <div class="tm-stat__lbl">完成</div>
              </div>
              <div class="tm-stat tm-stat--fail">
                <div class="tm-stat__val">{{ store.failedCount }}</div>
                <div class="tm-stat__lbl">失败</div>
              </div>
              <div class="tm-stat tm-stat--wait">
                <div class="tm-stat__val">{{ store.pendingCount }}</div>
                <div class="tm-stat__lbl">等待</div>
              </div>
            </div>

            <!-- 3 个操作按钮：右对齐 -->
            <n-space :size="6" align="center" class="tm-actions">
              <n-button
                type="primary" size="small" round
                @click="store.handleStart"
                :disabled="store.isRunning || store.tasks.length === 0"
              >开始</n-button>
              <n-button
                type="warning" size="small" round
                @click="store.handlePause"
                :disabled="!store.isRunning"
              >暂停</n-button>
              <n-button
                size="small" round
                @click="store.handleClearTasks"
                :disabled="store.isRunning"
              >清空</n-button>
            </n-space>
          </div>
        </div>
      </template>

      <!-- ============ 内容：占满剩余高度，内部 n-scrollbar 滚动 ============ -->
      <div class="tm-body">
        <div v-if="store.tasks.length === 0" class="tm-empty">
          <n-empty description="暂无任务" size="small" />
        </div>

        <template v-else>
          <n-scrollbar style="height: 100%;">
            <div class="tm-scroll-inner">
              <!-- 表头（sticky top:0 吸顶） -->
              <div class="tm-grid tm-grid--head">
                <div class="tm-col tm-col--id">ID</div>
                <div class="tm-col tm-col--type">类型</div>
                <div class="tm-col tm-col--pct">%</div>
                <div class="tm-col tm-col--status">状态</div>
                <div class="tm-col tm-col--dur">耗时</div>
              </div>

              <!-- 任务数据行 -->
              <div
                v-for="(row, idx) in store.tasks"
                :key="row.id"
                class="tm-grid tm-grid--row"
              >
                <!-- 背景进度条：绝对定位，颜色按状态，宽度按百分比（完成/失败=100%） -->
                <div
                  class="tm-progress-fill"
                  :class="progressClass(row)"
                  :style="{ width: progressWidth(row) + '%' }"
                ></div>

                <!-- 内容层（浮在进度条上方） -->
                <div class="tm-col tm-col--id">
                  <span class="cell-id">T-{{ shortId(row.id) }}</span>
                </div>
                <div class="tm-col tm-col--type">
                  <span class="cell-type">{{ typeMap[row.type] || row.type }}</span>
                </div>
                <div class="tm-col tm-col--pct">
                  <span class="cell-pct" :class="pctClass(row)">{{ Math.round(row.progress) }}</span>
                </div>
                <div class="tm-col tm-col--status">
                  <span class="cell-status" :class="statusClass(row.status)">
                    {{ statusMap[row.status]?.text || row.status }}
                  </span>
                </div>
                <div class="tm-col tm-col--dur">
                  <span class="cell-dur">{{ formatDuration(getDuration(row)) }}</span>
                </div>
              </div>
            </div>
          </n-scrollbar>
        </template>
      </div>
    </n-card>






  
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import {
  NCard, NButton, NTag, NInputNumber, NEmpty, NSpace, NScrollbar, NText
} from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// ===== 运行时时钟（耗时列每秒刷新） =====
const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

// ===== 类型映射（与后端 task.type 对齐） =====
const typeMap = {
  jxgj: '锦绣国际',
  trip: '携程OTA',
  o2: 'O2',
  o3: 'O3',
  o_combo: 'O组合',
  process: '处理'
}

// ===== 状态映射：文字 =====
const statusMap = {
  pending:   { text: '等待' },
  running:   { text: '运行' },
  completed: { text: '完成' },
  failed:    { text: '失败' },
  paused:    { text: '暂停' }
}

// ===== Helpers =====
function shortId(id) {
  if (typeof id !== 'string') return String(id ?? '').slice(-4)
  if (id.startsWith('task_') || id.startsWith('row_')) return id.slice(-4)
  return id.slice(-4)
}

// ============== 背景进度条（核心） ==============
// 进度宽度：pending/paused=0；running=progress%；completed/failed=100%
function progressWidth(row) {
  if (row.status === 'completed' || row.status === 'failed') return 100
  if (row.status === 'running') return Math.min(100, Math.max(0, row.progress || 0))
  return 0
}
// 进度填充颜色（按状态，半透明）
function progressClass(row) {
  return ({
    pending:   'pg-wait',
    running:   'pg-run',
    completed: 'pg-done',
    failed:    'pg-fail',
    paused:    'pg-pause'
  })[row.status] || 'pg-wait'
}

// ============== 百分比数字着色 ==============
function pctClass(row) {
  if (row.status === 'completed') return 'p-done'
  if (row.status === 'failed')    return 'p-fail'
  if (row.status === 'running')   return 'p-run'
  return 'p-wait'
}

// ============== 状态文字着色 ==============
function statusClass(s) {
  return ({
    pending:   'st-wait',
    running:   'st-run',
    completed: 'st-done',
    failed:    'st-fail',
    paused:    'st-pause'
  })[s] || 'st-wait'
}

// ============== 耗时计算 ==============
function getDuration(row) {
  if (!row || !row.createdAt) return 0
  if (row.status === 'pending' || row.status === 'paused') return 0
  const end = typeof row.finishedAt === 'number' ? row.finishedAt : now.value
  return Math.max(0, end - row.createdAt)
}
// 格式：MM:SS / H:MM:SS（未开始显示 --:--）
function formatDuration(ms) {
  if (!ms || ms < 1000) return '--:--'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

onMounted(async () => {
  await store.init()
})
</script>

<style scoped>
/* ============ 根容器：全高 flex 列 ============ */
.task-monitor {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  min-height: 0;
}
.task-monitor :deep(.n-card) {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
}
.task-monitor :deep(.n-card-header) {
  padding: 14px 16px 12px;
  border-bottom: 1px solid #efeff2;
  flex-shrink: 0;
  background: #fff;
}
.task-monitor :deep(.n-card__content) {
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

/* ============ 顶部（header-extra 内）：两行结构 ============ */
.tm-top {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 第 1 行：标题 + 并发（space-between） */
.tm-top__row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tm-row1-left {
  display: flex;
  align-items: center;
}
.tm-row1-right {
  display: flex;
  align-items: center;
}
.tm-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
  letter-spacing: 0.02em;
}

/* 第 2 行：统计块 + 操作按钮 */
.tm-top__row2 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

/* 4 个统计块：等宽平分，左侧小色块 + 数字 + 标签 紧凑内联 */
.tm-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  flex: 1;
  max-width: 420px;
}
.tm-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: #f8f9fb;
  border-left: 3px solid transparent;
}
.tm-stat--total { border-left-color: #8c8c8c; }
.tm-stat--done  { border-left-color: #18a058; }
.tm-stat--fail  { border-left-color: #d03050; }
.tm-stat--wait  { border-left-color: #2080f0; }

.tm-stat__val {
  font-size: 16px;
  font-weight: 700;
  color: #1f2937;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.tm-stat__lbl {
  font-size: 12px;
  color: #8c8c8c;
  line-height: 1;
  padding-top: 2px;
}

/* 操作按钮：右对齐 */
.tm-actions { flex-shrink: 0; }

/* ============ 主体：占满剩余高度（flex:1 + min-height:0），n-scrollbar 内部滚动 ============ */
.tm-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.tm-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* scrollbar：外层显式 flex:1 + min-height:0 保证撑满且可触发自身滚动，不挤破父容器 */
.tm-body :deep(.n-scrollbar) {
  flex: 1;
  min-height: 0;
}
.tm-body :deep(.n-scrollbar-rail) { z-index: 5; }

/* scrollbar 内部包裹层：padding 留出内容边距 */
.tm-scroll-inner {
  padding: 0 12px 12px;
}

/* ============ 表格 grid（严格对齐） ============
   列分布：
     ID      72px   等宽字
     类型    80px   粗体
     %       48px   右对齐/等宽字
     状态    1fr    自适应（左色点 + 文字）
     耗时    64px   右对齐/等宽字
============================================== */
.tm-grid {
  display: grid;
  grid-template-columns: 72px 80px 48px 1fr 64px;
  align-items: center;
  column-gap: 10px;
}

/* 表头：sticky 吸顶 + 细线分割 */
.tm-grid--head {
  position: sticky;
  top: 0;
  background: #fff;
  z-index: 2;
  padding: 8px 4px;
  border-bottom: 1px solid #eef0f3;
  font-size: 12px;
  font-weight: 600;
  color: #909399;
  letter-spacing: 0.04em;
}

/* 数据行：相对定位（承载背景进度条绝对定位） */
.tm-grid--row {
  position: relative;
  overflow: hidden;
  padding: 10px 4px;
  border-bottom: 1px dashed #f1f2f4;
  transition: background-color 0.15s ease;
}
.tm-grid--row:hover {
  background: rgba(0, 0, 0, 0.015);
}

/* 背景进度条填充（核心视觉） */
.tm-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 0;
  transition: width 0.3s ease;
  pointer-events: none;
}
/* 按状态着色（半透明低饱和，保证前景可读性） */
.pg-wait  { background: rgba(160, 160, 160, 0.06); }
.pg-run   { background: rgba(24, 128, 240, 0.12); }
.pg-done  { background: rgba(24, 160, 88, 0.14); }
.pg-fail  { background: rgba(208, 48, 80, 0.14); }
.pg-pause { background: rgba(240, 160, 32, 0.12); }

/* 各列：相对定位 z-index>0 覆盖在进度条上 */
.tm-col {
  position: relative;
  z-index: 1;
  min-width: 0;
}
.tm-col--pct  { text-align: right; }
.tm-col--dur  { text-align: right; }

/* ============ 单元格样式 ============ */
.cell-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
.cell-type {
  font-size: 12px;
  font-weight: 600;
  color: #1f2937;
}
.cell-pct {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.p-run  { color: #2080f0; }
.p-done { color: #18a058; }
.p-fail { color: #d03050; }
.p-wait { color: #9ca3af; }

/* 状态（色块 + 文字，紧凑） */
.cell-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
}
.cell-status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.st-wait  { color: #6b7280; } .st-wait::before  { background: #9ca3af; }
.st-run   { color: #2080f0; } .st-run::before   { background: #2080f0; }
.st-done  { color: #18a058; } .st-done::before  { background: #18a058; }
.st-fail  { color: #d03050; } .st-fail::before  { background: #d03050; }
.st-pause { color: #f0a020; } .st-pause::before { background: #f0a020; }

/* 耗时 */
.cell-dur {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}
</style>
