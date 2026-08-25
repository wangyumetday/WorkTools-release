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
<style scoped>
.task-monitor {
  width: 100%;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  gap: 12px;

  >div {
    width: 100%;
    border: 1px solid #e5e5e5;
  }

  .tm-top {
    .tmt-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      border-bottom: 1px solid #e5e5e5;
    }

    >div {
      display: flex;
      flex-flow: row nowrap;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
    }

    .tmt-count {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #e5e5e5;

      .tmtc-i {
        font-size: 14px;
        color: #333333;
        font-weight: 500;
      }
    }

    .tmt-btn {
      justify-content: flex-end;
      align-items: center;
      gap: 12px;
    }

  }

  .tm-bottom {
    border-radius: 6px;
    flex: 1;
    border: none;
    display: flex;
    flex-flow: column nowrap;

    .tmb-h {
      border: none;
    }

    .tmb-c {
      flex: 1;
      border: 1px solid #e5e5e5;
      display: flex;
      flex-flow: column nowrap;

      .tab-header {
        display: flex;
        justify-content: space-between;
        padding: 8px 16px;
        border-bottom: 1px solid #e5e5e5;

        /* 内部项横排，并平分宽度 */
        .tab-header-item {
          flex: 1;
          text-align: center;
        }
      }

      .tab-list {
        width: 100%;
        height: 100%;
        overflow: auto;

        .tab-list__scrollbar {
          width: 100%;
          height: 100%;

        }

        /* 让 n-virtual-list 充满容器 */
        /* :deep(.n-virtual-list) {
          height: 100%;
        } */
      }

      /* ============ 任务行样式 ============ */
      .tl-row {
        position: relative;
        display: flex;
        flex-flow: row nowrap;
        height: 42px;
        line-height: 42px;
        overflow: hidden;
        border-bottom: 1px solid #f0f0f0;

        .tl-row-bg {
          position: absolute;
          top: 0;
          left: 0;
          bottom: 0;
          transition: width 0.3s ease;
          z-index: 0;
        }

        .tl-row-content {
          position: relative;
          z-index: 1;
          display: flex;
          flex-flow: row nowrap;
          width: 100%;
          height: 100%;

          .tab-header-item {
            flex: 1;
            text-align: center;
            font-size: 13px;
            color: #333;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
        }
      }

      /* 进度条背景颜色（半透明，作为行底色） */
      .pg-wait {
        background-color: rgba(160, 160, 160, 0.12);
      }

      .pg-run {
        background-color: rgba(24, 144, 255, 0.18);
      }

      .pg-done {
        background-color: rgba(82, 196, 26, 0.18);
      }

      .pg-fail {
        background-color: rgba(255, 77, 79, 0.18);
      }

      .pg-pause {
        background-color: rgba(250, 173, 20, 0.18);
      }

      .pg-abort {
        background-color: rgba(247, 127, 86, 0.16);
      }

      /* 百分比数字颜色 */
      .p-wait {
        color: #999;
      }

      .p-run {
        color: #1890ff;
        font-weight: 600;
      }

      .p-done {
        color: #52c41a;
        font-weight: 600;
      }

      .p-fail {
        color: #ff4d4f;
        font-weight: 600;
      }

      .p-abort {
        color: #e76f51;
      }

      /* 状态文字颜色 */
      .st-wait {
        color: #999;
      }

      .st-run {
        color: #1890ff;
        font-weight: 500;
      }

      .st-done {
        color: #52c41a;
        font-weight: 500;
      }

      .st-fail {
        color: #ff4d4f;
        font-weight: 500;
      }

      .st-pause {
        color: #faad14;
        font-weight: 500;
      }

      .st-abort {
        color: #e76f51;
        font-weight: 500;
      }
    }
  }

}
</style>

<template>
  <div class="task-monitor">
    <div class="tm-top">
      <header class="tmt-header">
        <div class="tmth-l">任务队列</div>
        <div class="tmth-r">运行中</div>
      </header>
      <div class="tmt-count">
        <div class="tmtc-i">
          总数：{{ store.tasks.length }}
        </div>
        <div class="tmtc-i">
          完成：{{ store.completedCount }}
        </div>
        <div class="tmtc-i">
          失败：{{ store.failedCount }}
        </div>
        <div class="tmtc-i">
          等待：{{ store.pendingCount }}
        </div>
      </div>

      <div class="tmt-btn">
        <n-button type="primary" @click="store.handleStart"
          :disabled="store.isRunning || store.tasks.length === 0">开始</n-button>
        <n-button type="primary" @click="store.handlePause" :disabled="!store.isRunning">暂停</n-button>
        <n-button type="primary" @click="store.handleClearTasks" :disabled="store.isRunning">清空</n-button>
      </div>
    </div>
    <div class="tm-bottom">
      <div class="tmb-h">任务列表</div>
      <div class="tmb-c">
        <div class="tab-header">
          <div class="tab-header-item">ID</div>
          <div class="tab-header-item">类型</div>
          <div class="tab-header-item">进度</div>
          <div class="tab-header-item">状态</div>
          <div class="tab-header-item">耗时</div>
        </div>
        <div class="tab-list">
          <n-virtual-list ref="virtualListInst" class="tab-list__scrollbar" :item-size="42" :items="store.tasks">
            <template #default="{ item }">
              <div :key="item.id" class="tl-row">
                <div class="tl-row-bg" :class="progressClass(item)" :style="{ width: progressWidth(item) + '%' }"></div>
                <div class="tl-row-content">
                  <div class="tab-header-item">{{ shortId(item.id) }}</div>
                  <div class="tab-header-item">{{ typeMap[item.type] || item.type }}</div>
                  <div class="tab-header-item" :class="pctClass(item)">{{ Math.round(item.progress || 0) }}%</div>
                  <div class="tab-header-item" :class="statusClass(item.status)">{{ statusMap[item.status]?.text ||
                    item.status }}</div>
                  <div class="tab-header-item">{{ formatDuration(getDuration(item)) }}</div>
                </div>
              </div>
            </template>
          </n-virtual-list>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import {
  NCard, NButton, NVirtualList, NTag, NInputNumber, NEmpty, NSpace, NScrollbar, NText
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
  pending: { text: '等待' },
  running: { text: '运行' },
  completed: { text: '完成' },
  failed: { text: '失败' },
  paused: { text: '暂停' },
  aborted: { text: '终止' }
}

// ===== Helpers =====
function shortId(id) {
  if (typeof id !== 'string') return String(id ?? '').slice(-4)
  if (id.startsWith('task_') || id.startsWith('row_')) return id.slice(-4)
  return id.slice(-4)
}

// ============== 背景进度条（核心） ==============
// 进度宽度：pending/paused=0；running/aborted=progress%；completed/failed=100%
function progressWidth(row) {
  if (row.status === 'completed' || row.status === 'failed') return 100
  if (row.status === 'running' || row.status === 'aborted') return Math.min(100, Math.max(0, row.progress || 0))
  return 0
}
// 进度填充颜色（按状态，半透明）
function progressClass(row) {
  return ({
    pending: 'pg-wait',
    running: 'pg-run',
    completed: 'pg-done',
    failed: 'pg-fail',
    paused: 'pg-pause',
    aborted: 'pg-abort'
  })[row.status] || 'pg-wait'
}

// ============== 百分比数字着色 ==============
function pctClass(row) {
  if (row.status === 'completed') return 'p-done'
  if (row.status === 'failed') return 'p-fail'
  if (row.status === 'running') return 'p-run'
  if (row.status === 'aborted') return 'p-abort'
  return 'p-wait'
}

// ============== 状态文字着色 ==============
function statusClass(s) {
  return ({
    pending: 'st-wait',
    running: 'st-run',
    completed: 'st-done',
    failed: 'st-fail',
    paused: 'st-pause',
    aborted: 'st-abort'
  })[s] || 'st-wait'
}

// ============== 耗时计算 ==============
function getDuration(row) {
  if (!row || !row.createdAt) return 0
  if (row.status === 'pending' || row.status === 'paused') return 0
  const end = (typeof row.finishedAt === 'number' && row.finishedAt)
           || (typeof row.startedAt === 'number' && row.status === 'aborted' && row.startedAt)
           || now.value
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

// ============== 自动滚动：让正在进行的任务始终可见 ==============
// 任务列表自动上滚，使运行中的任务出现在可视区域；
// 上方自然会露出已完成的几条作为视觉上下文，但不改变任务的实际排序。
const virtualListInst = ref(null)

function scrollToRunningTask() {
  const tasks = store.tasks
  if (!tasks || tasks.length === 0) return
  // 找到第一个正在运行的任务索引
  const firstRunningIdx = tasks.findIndex(t => t.status === 'running')
  // 如果有正在运行的任务，滚动到它的位置；否则滚动到最后一条（最新完成的）
  let targetIdx
  if (firstRunningIdx !== -1) {
    // 让运行中的任务出现在视图上部（偏移 -2 使得上方能看到 2 条已完成任务作为视觉上下文）
    targetIdx = Math.max(0, firstRunningIdx - 2)
  } else {
    // 没有运行中任务时，滚动到最新一条
    targetIdx = tasks.length - 1
  }
  nextTick(() => {
    if (virtualListInst.value && typeof virtualListInst.value.scrollTo === 'function') {
      virtualListInst.value.scrollTo({ index: targetIdx, behavior: 'smooth' })
    }
  })
}

// 监听任务列表变化（新增、进度更新、状态变更），自动滚动到运行中任务
watch(
  () => store.tasks,
  () => { scrollToRunningTask() },
  { deep: true, flush: 'post' }
)

onMounted(async () => {
  await store.init()
  // 初始化完成后立即滚动到运行中任务
  nextTick(() => { scrollToRunningTask() })
})
</script>