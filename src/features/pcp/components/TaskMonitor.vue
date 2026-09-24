<!-- ============================================================
     PCP TaskMonitor.vue - 任务监控器(外壳)
     职责:
       - 顶部:标题行(队列标题+状态灯) + 统计行(总数/完成/失败/等待) + 开始/暂停按钮
       - 中部:任务列表头(并发控制 + 列标题) + <TaskList>(真实列表)
     任务列表实现为 TaskList.vue,共用 composables/useTaskList.js(逻辑) + taskList.css(样式)
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

        .dot-gray {
          background: #c0c0c0;
        }

        .dot-blue {
          background: #1890ff;
        }

        .dot-green {
          background: #52c41a;
        }

        .dot-yellow {
          background: #faad14;
        }

        .dot-red {
          background: #ff4d4f;
        }

        .dot-blink {
          animation: pcp-dot-blink 1s ease-in-out infinite;
        }

        /* 顶部状态文字颜色(与任务行 statusClass 同命名,各自 scoped) */
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

      /* 携程限流额度徽章：平时蓝（与"运行中"呼应），冷却期红高亮倒计时 */
      .tmtc-i.rate-limit {
        color: #1890ff;
      }

      .tmtc-i.rate-limit.rate-cooldown {
        color: #ff4d4f;
        font-weight: 600;
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

    /* 数据统计折叠块：任务列表上方，头部点击展开/收起，内容每条一行 */
    .tm-stats-wrap {
      flex: 0 0 auto;
      border: 1px solid #e5e5e5;
      border-radius: 4px;
      background: #fff;
      overflow: hidden;

      .tmb-panel-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        cursor: pointer;
        user-select: none;
        border-bottom: 1px solid #e5e5e5;

        .tmbp-arrow {
          color: #666;
          font-size: 10px;
          line-height: 1;
        }

        .tmbp-title {
          font-size: 13px;
          font-weight: 500;
          color: #333;
        }
      }

      .tm-stats {
        padding: 4px 0;

        .tm-stat-chip {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 4px 12px;
          line-height: 20px;

          .tmsc-label {
            font-size: 12px;
            color: #666;
          }

          .tmsc-value {
            font-size: 13px;
            font-weight: 600;
            color: #333;
          }
        }
      }
    }

    /* 任务列表块：始终展开，自动占满剩余高度 */
    .tm-queue {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-flow: column nowrap;
    }


    .tmb-h {
      border: none;
      display: flex;
      flex-flow: row nowrap;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;

      .tmb-h-left {
        display: inline-flex;
        align-items: center;
        gap: 12px;
      }

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

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.25;
  }
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
      <!--  -->



      <div class="tmt-count" style="padding: 0 16px;">
        <!-- 携程限流额度徽章：仅在 trip 阶段运行期显示（主进程 1s 变化推送） -->
        <div v-if="rateLimit.active" class="tmtc-i rate-limit"
          :class="{ 'rate-cooldown': rateLimit.cooldownRemainingMs > 0 }">
          针对trip限流：{{ rateLimit.limit > 0 ? `${rateLimit.used}/${rateLimit.limit}` : '不限流' }}<span
            v-if="rateLimit.cooldownRemainingMs > 0"> · 冷却 {{ cooldownSec }}s</span>
        </div>
      </div>



      <!--  -->
      <!-- 开始/暂停（2026-09-23 仅隐藏界面，实现保留；需要时去掉 v-if="false" 即恢复） -->
      <div class="tmt-btn" v-if="false">
        <n-button type="primary" @click="store.handleStartExecution"
          :disabled="store.isRunning || store.tasks.length === 0">开始</n-button>
        <n-button type="primary" @click="store.handlePause" :disabled="!store.isRunning">暂停</n-button>
      </div>









    </div>
    <div class="tm-bottom">
      <!-- 数据统计折叠块：任务列表上方，独立可折叠 -->
      <div class="tm-stats-wrap">
        <div class="tmb-panel-head" @click="statsCollapsed = !statsCollapsed">
          <span class="tmbp-arrow">{{ statsCollapsed ? '▶' : '▼' }}</span>
          <span class="tmbp-title">数据统计</span>
        </div>
        <!-- 统计 chips：跨任务聚合计数（来自各任务 result.summary），hover 看含义 -->
        <div v-show="!statsCollapsed" class="tm-stats">
          <div v-for="s in statsItems" :key="s.key" class="tm-stat-chip" :title="s.tip">
            <span class="tmsc-label">{{ s.label }}</span>
            <span class="tmsc-value">{{ s.value }}</span>
          </div>
        </div>
      </div>

      <!-- 任务列表块：始终展开，自动占满剩余高度 -->
      <div class="tm-queue">
        <div class="tmb-h">
          <div class="tmb-h-left">
            <span>任务列表</span>
            <!-- 并发控制：当前并发 / 设定并发 + 加减按钮（上限 16，默认 6），紧跟标题后 -->
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
          <!-- 清空按钮：仅清已结束的任务（completed/failed/aborted），运行中保留 -->
          <n-button size="small" type="default" @click="store.handleClearTasks"
            :disabled="store.isRunning && store.tasks.every(t => ['pending', 'paused', 'running'].includes(t.status))">
            清空
          </n-button>
        </div>
        <!-- 任务列表(手风琴式进度可视化：舱位航线组配/锦绣请求/携程请求) -->
        <TaskList />
      </div>

    </div>
  </div>
</template>

<script setup>
import { onMounted, computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'
import TaskList from './TaskList.vue'

const store = useTaskStore()

// ===== 携程限流额度徽章 =====
//   active 由主进程推送控制：仅在 trip 阶段 running 期间为 true（徽章随阶段结束自动隐藏）
//   数据 1s 变化推送（滑动窗口自然回落/冷却倒计时都会实时刷新）
const rateLimit = ref({ active: false, limit: 0, used: 0, cooldownRemainingMs: 0 })
const cooldownSec = computed(() => Math.ceil((rateLimit.value.cooldownRemainingMs || 0) / 1000))

// ===== 顶部状态指示灯 + 文字（真实状态，非硬编码"运行中"）=====
//   灯色：未运行灰(稳) / 运行中蓝(闪) / 已暂停黄(闪) / 有失败红(闪) / 已完成绿(稳)
const overallStatus = computed(() => {
  if (store.isPaused) return { text: '已暂停', dot: 'yellow', cls: 'st-pause', blink: true }
  if (store.isRunning) return { text: '运行中', dot: 'blue', cls: 'st-run', blink: true }
  if (store.failedCount > 0) return { text: '有失败', dot: 'red', cls: 'st-fail', blink: true }
  if (store.completedCount > 0 && store.pendingCount === 0) return { text: '已完成', dot: 'green', cls: 'st-done', blink: false }
  return { text: '未运行', dot: 'gray', cls: 'st-wait', blink: false }
})

// ===== 可折叠数据统计面板（2026-09-23 起）=====
//   统计口径：跨任务聚合各 task.result.summary（summary 只在任务 merge 完成时变化，天然低频刷新；
//   不做轮询/定时器，不拖累任务执行效率）；每项 hover 提示含义
const statsCollapsed = ref(false)
const statsItems = computed(() => {
  const agg = { total: 0, own: 0, ownShown: 0, wonHidden: 0, unmatched: 0, policyRows: 0 }
  for (const t of store.tasks) {
    const s = t?.result?.summary
    if (!s) continue
    agg.total += Number(s.quoteTotal) || 0
    agg.own += Number(s.quoteOwn) || 0
    agg.ownShown += Number(s.quoteOwnShown) || 0
    agg.wonHidden += Number(s.quoteWonHidden) || 0
    agg.unmatched += Number(s.quoteUnmatched) || 0
    agg.policyRows += Number(s.policyRowCount) || 0
  }
  return [
    { key: 'total', label: '投放总数', value: agg.total, tip: '携程返回的全部报价条目数（含我方与其它投放）' },
    { key: 'own', label: '我方投放数', value: agg.own, tip: '携程查到的属于我方投放的报价条目数' },
    { key: 'ownShown', label: '展示的报价数', value: agg.ownShown, tip: '我方投放且已在携程外显（isOwn=true 且 showState=1）的报价条目数' },
    { key: 'wonHidden', label: '我方胜出却未显示数', value: agg.wonHidden, tip: '我方投放却未外显（isOwn=true 且 showState≠1）的报价中「理应外显却未外显」的条数：①所在对比组内无任何他人报价（无人竞价）；②所在对比组内有他人报价价格更高却已外显' },
    { key: 'unmatched', label: '独占数量', value: agg.unmatched, tip: '我们锦绣数据存在、但携程无人投放（未匹配）的官网数据单元数' },
    { key: 'policyRows', label: '写入政策条数', value: agg.policyRows, tip: '我方比赢（含未匹配出政策的原价政策）且航程类型=单程、本次将写入政策导入文件的数据条数' }
  ]
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
  // 限流额度：先拉一次初值（运行中重挂载也能同步），再订阅 1s 变化推送
  const api = window.api?.pcp
  if (api?.ratelimitGetState) {
    const init = await api.ratelimitGetState()
    if (init) rateLimit.value = { ...rateLimit.value, ...init }
  }
  api?.onRateLimitState?.((d) => {
    rateLimit.value = { ...rateLimit.value, ...d }
  })
})
</script>
