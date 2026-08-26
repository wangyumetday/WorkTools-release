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

    .tab-list {
      min-height: 0;
      flex: 1;
      width: 100%;
      /* height: 100%; */
      overflow: auto;
      border: 1px solid #e5e5e5;
      border-top: none;

      .tab-list__scrollbar {
        width: 100%;
        /* height: 100%; */
      }

      /* 让 n-virtual-list 充满容器 */
      :deep(.n-virtual-list) {
        height: 100%;
      }
    }

    /* ============ 任务行样式 ============ */
    .tl-row-wrap {
      border-bottom: 1px solid #f0f0f0;
    }

    .tl-row {
      position: relative;
      display: flex;
      flex-flow: row nowrap;
      height: 36px;
      line-height: 36px;
      overflow: hidden;
      cursor: pointer;   /* 点击展开/收起 */
      user-select: none;

      &:hover {
        filter: brightness(0.98);
      }

      .tl-row-bg {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        border-top: 1px solid #ffffff;
        border-bottom: 1px solid #ffffff;
        /* 宽度用 100%，实际缩放用 transform scaleX（走 GPU 合成，不触发重排） */
        width: 100%;
        transition: transform 0.3s ease;
        will-change: transform;
        z-index: 0;
      }

      .tl-row-content {
        position: relative;
        z-index: 1;
        display: flex;
        flex-flow: row nowrap;
        align-items: center;
        width: 100%;
        height: 100%;

        .tl-row-expand {
          width: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          color: #999;
          flex-shrink: 0;
          transition: transform 0.2s ease;
        }
        .tl-row-expand.open { transform: rotate(90deg); }

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

    /* ============ 展开详情面板（紧凑版） ============ */
    .tl-detail {
      padding: 6px 12px 8px 36px;
      background: #fafbfc;
      border-top: 1px dashed #e5e5e5;
      font-size: 12px;
      color: #333;
      line-height: 1.5;

      .tld-section { margin-bottom: 6px; }
      .tld-section:last-child { margin-bottom: 0; }

      /* ===== 顶部 meta 条：核心信息一行横排 chip ===== */
      .tld-meta {
        display: flex;
        flex-flow: row wrap;
        align-items: center;
        gap: 10px 16px;
        font-size: 12px;
        line-height: 1.7;
      }
      .tld-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .tld-chip__label {
        color: #999;
      }
      .tld-chip__value {
        color: #333;
        font-weight: 500;
      }
      .tld-chip__value--fail { color: #cf1322; font-weight: 600; }
      .tld-chip__value--ok { color: #389e0d; font-weight: 600; }
      .tld-chip__value--warn { color: #d48806; font-weight: 600; }
      .tld-chip__value--run { color: #1890ff; font-weight: 600; }
      .tld-chip__sep {
        width: 1px;
        height: 12px;
        background: #e5e5e5;
        align-self: center;
      }

      /* ===== 核心结果块：失败/跳过/成功 一屏可见 ===== */
      .tld-result {
        border-radius: 3px;
        padding: 5px 8px;
        font-family: Consolas, 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .tld-result--fail {
        background: #fff1f0;
        border-left: 3px solid #ff7875;
        color: #cf1322;
      }
      .tld-result--skip {
        background: #fffbe6;
        border-left: 3px solid #ffc53d;
        color: #d48806;
      }
      .tld-result--ok {
        background: #f6ffed;
        border-left: 3px solid #73d13d;
        color: #389e0d;
      }

      /* ===== 次要信息折叠：默认收起，不占视觉 ===== */
      .tld-collapse-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11.5px;
        color: #888;
        cursor: pointer;
        user-select: none;
        &:hover { color: #1890ff; }
      }
      .tld-collapse-toggle .caret {
        transition: transform 0.15s ease;
        display: inline-block;
      }
      .tld-collapse-toggle.open .caret { transform: rotate(90deg); }

      /* data 对象预览：折叠后才展开 */
      .tld-data-json {
        margin-top: 4px;
        background: #fff;
        border: 1px solid #eee;
        border-radius: 3px;
        padding: 4px 6px;
        font-family: Consolas, 'Courier New', monospace;
        font-size: 11px;
        color: #555;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 100px;
        overflow-y: auto;
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
      <!-- <div class="tmb-c"> -->
      <div class="tmb-h">
        <span>任务列表</span>
        <!-- 并发控制：当前并发 / 设定并发 + 输入框（限制60%最大并发=6） + 加减按钮 -->
        <div class="tmb-concurrency">
          <span class="tmbc-label">并发：</span>
          <span class="tmbc-active">{{ store.activeCount }}</span>
          <span class="tmbc-slash">/</span>
          <span class="tmbc-active">{{ store.concurrency }}</span>
          <!-- 
          <n-input-number class="tmbc-input" size="small" :value="store.concurrency" :min="1" :max="8" :step="1"
            :show-button="false" @update:value="(v) => v != null && store.handleSetConcurrency(v)" /> -->
          <n-button size="small" text @click="decConcurrency" style="margin-left: 4px;"
            :disabled="store.concurrency <= 1">－</n-button>
          <n-button size="small" text @click="incConcurrency" :disabled="store.concurrency >= 8">＋</n-button>
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
      <div class="tab-list">
        <n-virtual-list ref="virtualListInst" class="tab-list__scrollbar" :item-size="42" :items="store.tasks">
          <template #default="{ item }">
            <div :key="item.id" class="tl-row-wrap">
              <div class="tl-row" @click="toggleExpand(item.id)">
                <!-- ★ 纯 CSS 背景进度条：transform scaleX 走 GPU，不触发重排 -->
                <div class="tl-row-bg" :class="progressClass(item)" :style="{
                  transform: `scaleX(${Math.max(0, Math.min(1, (progressWidth(item) || 0) / 100))})`,
                  transformOrigin: 'left center'
                }"></div>

                <div class="tl-row-content">
                  <div class="tl-row-expand" :class="{ open: expandedTaskId === item.id }">▶</div>
                  <div class="tab-header-item">{{ shortId(item.id) }}</div>
                  <div class="tab-header-item">{{ typeMap[item.type] || item.type }}</div>
                  <!-- 百分比按状态着色 -->
                  <div class="tab-header-item" :class="pctClass(item)">{{ Math.round(item.progress || 0) }}%</div>
                  <!-- 状态文字按状态着色 -->
                  <div class="tab-header-item" :class="statusClass(item.status)">
                    {{ statusMap[item.status]?.text || item.status }}
                  </div>
                  <div class="tab-header-item">{{ formatDuration(getDuration(item)) }}</div>
                </div>
              </div>

              <!-- ★ 展开详情面板（紧凑版）：核心信息一目了然，次要信息折叠 -->
              <div v-if="expandedTaskId === item.id" class="tl-detail">
                <!-- ===== 顶部 meta 条：一行 chip 横排，替换原来 7 行竖排网格 ===== -->
                <!--   删除：创建/开始/结束时间戳（对排查失败无用，用户只关心耗时） -->
                <!--   删除：任务ID（行里已显示 shortId，想看 full ID 点展开输入数据里也有） -->
                <div class="tld-section tld-meta">
                  <span class="tld-chip">
                    <span class="tld-chip__label">状态</span>
                    <span class="tld-chip__value"
                      :class="{
                        'tld-chip__value--fail': item.status === 'failed',
                        'tld-chip__value--ok': item.status === 'completed',
                        'tld-chip__value--warn': item.status === 'skipped' || item.status === 'paused',
                        'tld-chip__value--run': item.status === 'running'
                      }">{{ statusMap[item.status]?.text || item.status }}</span>
                  </span>
                  <span class="tld-chip__sep"></span>
                  <span class="tld-chip">
                    <span class="tld-chip__label">平台</span>
                    <span class="tld-chip__value">{{ typeMap[item.type] || item.type }}</span>
                  </span>
                  <span class="tld-chip__sep"></span>
                  <span class="tld-chip">
                    <span class="tld-chip__label">耗时</span>
                    <span class="tld-chip__value">{{ formatDuration(getDuration(item)) }}s</span>
                  </span>

                  <template v-if="item.result?._usedCredential">
                    <span class="tld-chip__sep"></span>
                    <span class="tld-chip" :title="`账号：${item.result._usedCredential.name || '-'} / 用户：${item.result._usedCredential.username || '-'}`">
                      <span class="tld-chip__label">账号</span>
                      <span class="tld-chip__value">{{ item.result._usedCredential.name || '-' }}</span>
                    </span>
                  </template>

                  <!-- 致命错误徽章 inline，不再独立 section -->
                  <span v-if="item.result?.isFatal" class="tld-chip__sep"></span>
                  <n-tag v-if="item.result?.isFatal" type="error" size="small" round>已停止剩余任务</n-tag>
                </div>

                <!-- ===== 核心结果：失败原因 / 跳过原因 / 处理结果 ===== -->
                <!--   不再额外包 section + 标题标签，色块本身即语义 + 压缩为左边框样式 -->
                <div v-if="item.status === 'failed' && item.result?.error"
                     class="tld-section tld-result tld-result--fail">{{ item.result.error }}</div>

                <div v-else-if="item.status === 'skipped' && item.result?.error"
                     class="tld-section tld-result tld-result--skip">{{ item.result.error }}</div>

                <div v-else-if="item.status === 'completed' && item.result"
                     class="tld-section tld-result tld-result--ok">{{ summarizeResult(item.result) }}</div>

                <!-- ===== 输入数据：默认折叠，需要才展开 ===== -->
                <!--   失败排查时可能有用，但大部分失败看上面错误文本就够了，不占高度 -->
                <div v-if="item.data || item.result?._usedCredential" class="tld-section">
                  <span class="tld-collapse-toggle"
                        :class="{ open: inputDataExpandedId === item.id }"
                        @click.stop="toggleInputData(item.id)">
                    <span class="caret">▶</span>
                    <span>{{ inputDataExpandedId === item.id ? '收起详情' : '展开输入数据' }}</span>
                  </span>

                  <div v-if="inputDataExpandedId === item.id">
                    <div v-if="item.result?._usedCredential" style="margin-top:4px; font-size:11.5px; color:#777;">
                      使用账号：{{ item.result._usedCredential.name }} / {{ item.result._usedCredential.username }}
                      <span v-if="item.result._usedCredential.platform">· 平台：{{ item.result._usedCredential.platform }}</span>
                    </div>
                    <div v-if="item.data" class="tld-data-json">{{ prettyJson(item.data, 30) }}</div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </n-virtual-list>
      </div>
      <!-- </div> -->
    </div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, nextTick, computed } from 'vue'
import {
  NCard, NButton, NVirtualList, NTag, NInputNumber, NEmpty, NSpace, NScrollbar, NText
} from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// ===== 任务行展开详情 =====
//   - 点击行切换展开/收起（同一行再点关闭）
//   - 只展开一行（简单，数据不会太挤）
const expandedTaskId = ref(null)
function toggleExpand(id) {
  expandedTaskId.value = expandedTaskId.value === id ? null : id
  // 收起行时同步收起该任务的输入数据折叠（避免下次展开残留）
  if (expandedTaskId.value === null && inputDataExpandedId.value === id) {
    inputDataExpandedId.value = null
  }
}

// ===== 输入数据折叠（详情里的二级折叠，每任务独立）=====
const inputDataExpandedId = ref(null)
function toggleInputData(id) {
  inputDataExpandedId.value = inputDataExpandedId.value === id ? null : id
}

// 汇总成功任务的结果（提取 processedCount / summary / reason 等字段）
function summarizeResult(result) {
  if (!result || typeof result !== 'object') return '无详情'
  const parts = []
  // 处理条数
  if (typeof result.processedCount === 'number') parts.push(`处理条数：${result.processedCount}`)
  if (typeof result.processed === 'number') parts.push(`processed=${result.processed}`)
  // 摘要
  if (result.summary && typeof result.summary === 'object') {
    if (typeof result.summary.flightCount === 'number') parts.push(`航班数=${result.summary.flightCount}`)
    if (typeof result.summary.lowPriceCount === 'number') parts.push(`底价条数=${result.summary.lowPriceCount}`)
  }
  // 0 结果原因（BUG-4 记录的 reason）
  if (result.reason) parts.push(`备注：${result.reason}`)
  // 致命标记
  if (result.isFatal) parts.push('（致命错误）')
  return parts.length > 0 ? parts.join('  |  ') : '请求完成'
}

// 格式化输入数据为可读 JSON（限制字符数，避免太长）
function prettyJson(obj, maxLines = 40) {
  try {
    const text = JSON.stringify(obj, null, 2)
    const lines = text.split('\n')
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (共 ${lines.length} 行，已截断)`
    }
    return text
  } catch {
    return String(obj ?? '')
  }
}

// ===== 顶部状态指示灯 + 文字（真实状态，非硬编码"运行中"）=====
//   灯色：未运行灰(稳) / 运行中蓝(闪) / 已暂停黄(闪) / 有失败红(闪) / 已完成绿(稳)
const overallStatus = computed(() => {
  if (store.isPaused) return { text: '已暂停', dot: 'yellow', cls: 'st-pause', blink: true }
  if (store.isRunning) return { text: '运行中', dot: 'blue', cls: 'st-run', blink: true }
  if (store.failedCount > 0) return { text: '有失败', dot: 'red', cls: 'st-fail', blink: true }
  if (store.completedCount > 0 && store.pendingCount === 0) return { text: '已完成', dot: 'green', cls: 'st-done', blink: false }
  return { text: '未运行', dot: 'gray', cls: 'st-wait', blink: false }
})

// ===== 运行时时钟（耗时列每秒刷新） =====
// 2000ms 精度足够看 MM:SS，比 1000ms 少一半重绘次数（virtual list 可视区内约 20-30 行）
const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 2000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

// ===== 并发控制辅助 =====
function decConcurrency() {
  if (store.concurrency > 1) store.handleSetConcurrency(store.concurrency - 1)
}
function incConcurrency() {
  // 输入框上限 6（用户要求 60% 最大并发数；最大支持并发 10 → 6）
  if (store.concurrency < 6) store.handleSetConcurrency(store.concurrency + 1)
}

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
  paused: { text: '暂停' }
}

// ===== Helpers =====
function shortId(id) {
  if (typeof id !== 'string') return String(id ?? '').slice(-4)
  if (id.startsWith('task_') || id.startsWith('row_')) return id.slice(-4)
  return id.slice(-4)
}

// ============== 背景进度条（核心） ==============
// 进度宽度：pending/paused=0；running=progress%；completed/failed=100%
// 实际 CSS 用 transform scaleX(x/100)，这里返回 0~100，模板里再除以 100
function progressWidth(row) {
  if (row.status === 'completed' || row.status === 'failed') return 100
  if (row.status === 'running') return Math.min(100, Math.max(0, row.progress || 0))
  return 0
}
// 进度填充颜色（按状态，半透明色阶，复用你原本已写好的 pg-* 类）
function progressClass(row) {
  return ({
    pending: 'pg-wait',
    running: 'pg-run',
    completed: 'pg-done',
    failed: 'pg-fail',
    paused: 'pg-pause'
  })[row.status] || 'pg-wait'
}

// ============== 百分比数字着色 ==============
function pctClass(row) {
  if (row.status === 'completed') return 'p-done'
  if (row.status === 'failed') return 'p-fail'
  if (row.status === 'running') return 'p-run'
  return 'p-wait'
}

// ============== 状态文字着色 ==============
function statusClass(s) {
  return ({
    pending: 'st-wait',
    running: 'st-run',
    completed: 'st-done',
    failed: 'st-fail',
    paused: 'st-pause'
  })[s] || 'st-wait'
}

// ============== 耗时计算（以 startedAt 为基准，排除排队等待时间） ==============
// 基准：任务真正"开始被执行"的 startedAt（主进程 worker 认领时打戳，不是创建时间 createdAt）
//   - pending：未开始 → 0（显示 --:--）
//   - paused：已暂停但之前跑过 → 用 startedAt 到 pausedAt 或 now（暂缺 pausedAt，用 now 做近似兜底也OK；当前先显示 0 更直观）
//   - running：startedAt → now（实时跑秒）
//   - completed/failed：startedAt → finishedAt（准确的真实耗时）
function getDuration(row) {
  if (!row || !row.startedAt) return 0
  // pending：没开始过（理论 startedAt 也是 null，上面已经兜住了），或 paused 未提供 pausedAt 时先给 0 避免把暂停后的等待也算进去
  if (row.status === 'pending' || row.status === 'paused') return 0
  let end
  if (row.status === 'completed' || row.status === 'failed') {
    end = typeof row.finishedAt === 'number' ? row.finishedAt : row.startedAt
  } else {
    // running：用前端时钟
    end = now.value
  }
  return Math.max(0, end - row.startedAt)
}
// 格式：MM:SS / H:MM:SS（未开始显示 --:--）
function formatDuration(ms) {
  // 取一位小数
  return (ms / 1000).toFixed(1)
  // if (!ms || ms < 1000) return '--:--'
  // const total = Math.floor(ms / 1000)
  // const h = Math.floor(total / 3600)
  // const m = Math.floor((total % 3600) / 60)
  // const s = total % 60
  // const pad = (n) => n.toString().padStart(2, '0')
  // if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  // return `${pad(m)}:${pad(s)}`
}

// ============== 自动滚动：预留（不做 deep watch，避免 2000 条深度 diff 开销） ==============
// 之前的 watch tasks deep=true 已删除，理由：
//   deep 监听会让 Vue 递归遍历整个 tasks 数组所有对象属性建立依赖 + 每次变化全量深度 diff
//   2000 条 × 每秒约 2 次合批推送 = 每秒数万次属性访问，完全没必要
// 如果以后要恢复"滚动到运行中任务"：改为监听 store.tasks.map(t => t.status) 这种浅数组就行
// const virtualListInst = ref(null)

onMounted(async () => {
  await store.init()
})
</script>