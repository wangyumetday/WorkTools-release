<!-- ============================================================
     PCP TaskMonitor.vue - 任务监控器(外壳)
     职责:
       - 顶部:标题行(队列标题+状态灯) + 统计行(总数/完成/失败/等待) + 开始/暂停按钮
       - 中部:任务列表头(并发控制 + 列标题) + <TaskList>(真实列表,当前使用)
     任务列表实现已抽离为独立组件:
       - TaskList.vue       真实列表(当前使用,几百~千任务无压力)
       - TaskListVirtual.vue 虚拟列表(保留,任务量超大时切换)
       共享 composables/useTaskList.js(逻辑) + taskList.css(样式)
     数据流:全部状态来自 useTaskStore,操作按钮触发 store action
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

      .tmth-r {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        font-weight: 500;

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
          background: #c0c0c0;
        }
        .dot-gray { background: #c0c0c0; }
        .dot-blue { background: #1890ff; }
        .dot-green { background: #52c41a; }
        .dot-yellow { background: #faad14; }
        .dot-red { background: #ff4d4f; }
        .dot-blink {
          animation: pcp-dot-blink 1s ease-in-out infinite;
        }

        /* 顶部状态文字颜色(与任务行 statusClass 同命名,各自 scoped) */
        .st-wait { color: #999; }
        .st-run { color: #1890ff; font-weight: 500; }
        .st-done { color: #52c41a; font-weight: 500; }
        .st-fail { color: #ff4d4f; font-weight: 500; }
        .st-pause { color: #faad14; font-weight: 500; }
      }
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
    min-height: 0;
    border: none;
    display: flex;
    flex-flow: column nowrap;

    .tmb-h {
      border: none;
      display: flex;
      flex-flow: row nowrap;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;

      >span {
        align-items: center;
        font-size: 14px;
        color: #333333;
        font-weight: 500;
      }
    }

    /* 并发控制区域布局：标签 + active/输入框 + 加减按钮，整行紧凑对齐 */
    .tmb-concurrency {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      color: #333;

      .tmbc-label {
        color: #666;
        margin-right: 2px;
      }

      .tmbc-active {
        font-weight: 600;
        color: #1890ff;
        /* min-width: 12px; */
        text-align: right;
      }

      .tmbc-slash {
        color: #999;
        margin: 0 2px;
      }

      .tmbc-input {
        width: 60px;
      }
    }

    .tab-header {
      display: flex;
      justify-content: space-between;
      padding: 8px 0px;
      border: 1px solid #e5e5e5;

      /* 内部项横排，并平分宽度 */
      .tab-header-item {
        flex: 1;
        text-align: center;
      }
    }
  }
}
@keyframes pcp-dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
</style>

<template>
  <div class="task-monitor">
    <div class="tm-top">
      <header class="tmt-header">
        <div class="tmth-l">任务队列</div>
        <div class="tmth-r">
          <span class="status-dot" :class="[`dot-${overallStatus.dot}`, { 'dot-blink': overallStatus.blink }]"></span>
          <span :class="overallStatus.cls">{{ overallStatus.text }}</span>
        </div>
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
        <n-button type="primary" @click="store.handleStartExecution"
          :disabled="store.isRunning || store.tasks.length === 0">开始</n-button>
        <n-button type="primary" @click="store.handlePause" :disabled="!store.isRunning">暂停</n-button>
      </div>
    </div>
    <div class="tm-bottom">
      <div class="tmb-h">
        <span>任务列表</span>
        <!-- 并发控制：当前并发 / 设定并发 + 加减按钮（上限 16，默认 6） -->
        <div class="tmb-concurrency">
          <span class="tmbc-label">并发：</span>
          <span class="tmbc-active">{{ store.activeCount }}</span>
          <span class="tmbc-slash">/</span>
          <span class="tmbc-active">{{ store.concurrency }}</span>
          <n-button size="small" text @click="decConcurrency" style="margin-left: 4px;"
            :disabled="store.concurrency <= 1">－</n-button>
          <n-button size="small" text @click="incConcurrency" :disabled="store.concurrency >= 16">＋</n-button>
        </div>
      </div>
      <div class="tab-header">
        <div class="tab-header-item" style="max-width:20px;"></div>
        <div class="tab-header-item">ID</div>
        <div class="tab-header-item">类型</div>
        <div class="tab-header-item">进度</div>
        <div class="tab-header-item">状态</div>
        <div class="tab-header-item">耗时/s</div>
      </div>
      <!-- 任务列表(真实列表,当前使用;如需切虚拟列表换 TaskListVirtual) -->
      <TaskList />
    </div>
  </div>
</template>

<script setup>
import { onMounted, computed } from 'vue'
import { NButton } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'
import TaskList from './TaskList.vue'

const store = useTaskStore()

// ===== 顶部状态指示灯 + 文字（真实状态，非硬编码"运行中"）=====
//   灯色：未运行灰(稳) / 运行中蓝(闪) / 已暂停黄(闪) / 有失败红(闪) / 已完成绿(稳)
const overallStatus = computed(() => {
  if (store.isPaused) return { text: '已暂停', dot: 'yellow', cls: 'st-pause', blink: true }
  if (store.isRunning) return { text: '运行中', dot: 'blue', cls: 'st-run', blink: true }
  if (store.failedCount > 0) return { text: '有失败', dot: 'red', cls: 'st-fail', blink: true }
  if (store.completedCount > 0 && store.pendingCount === 0) return { text: '已完成', dot: 'green', cls: 'st-done', blink: false }
  return { text: '未运行', dot: 'gray', cls: 'st-wait', blink: false }
})

// ===== 并发控制辅助 =====
function decConcurrency() {
  if (store.concurrency > 1) store.handleSetConcurrency(store.concurrency - 1)
}
function incConcurrency() {
  // 上限 16（与后端 taskScheduler.setConcurrency 的限制同步）
  if (store.concurrency < 16) store.handleSetConcurrency(store.concurrency + 1)
}

onMounted(async () => {
  await store.init()
})
</script>
