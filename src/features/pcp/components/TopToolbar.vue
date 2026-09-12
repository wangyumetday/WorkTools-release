<!-- ============================================================
     PCP TopToolbar.vue - 顶部工具栏组件（按截图三栏布局重实现）
     职责：
       左栏「必填信息」：航司输入 / 航线选择文件 / 舱位输入
         新格式：上传文件只有 出发机场/到达机场 两列，
         航司/舱位在此输入，选文件时注入所有 a1 行；
         已解析后修改 → blur 时重应用到 a1
       中栏「任务总进度」：任务进度条 + 开始/终止
       右栏：设置下载目录 / 打开下载目录 / 下载文件
     数据流：全部来自 useTaskStore
     ============================================================ -->
<style scoped>
.top-toolbar {
  width: 100%;
  display: flex;
  flex-flow: row nowrap;
  justify-content: space-between;
  align-items: stretch;
  gap: 16px;

  .tt-box {
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .tt-left {
    flex: 0 0 auto;

    .ttb-title {
      font-size: 14px;
      font-weight: 600;
    }

    .ttb-row {
      display: flex;
      flex-flow: row nowrap;
      align-items: center;
      gap: 8px;
    }

    .ttb-label {
      width: 42px;
      font-size: 14px;
      text-align: right;
      white-space: nowrap;
    }

    .ttb-input {
      width: 160px;
    }
  }

  .tt-mid {
    flex: 1 1 auto;
    min-width: 220px;

    .ttb-title {
      font-size: 14px;
      font-weight: 600;
    }

    .ttb-actions {
      display: flex;
      flex-flow: row nowrap;
      gap: 12px;
      margin-top: auto;
    }

    .ttb-btn {
      flex: 1;
    }
  }

  .tt-right {
    flex: 0 0 auto;
    justify-content: center;

    .ttb-btn {
      width: 170px;
    }
  }
}

/* 下载按钮进度填充：fill 绝对定位铺左侧，label 相对定位浮在上层 */
.download-progress-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: rgba(24, 160, 88, 0.35);
  pointer-events: none;
}

.download-progress-label {
  position: relative;
  white-space: nowrap;
}

/* 门禁失败闪烁抖动引导动画：收到 pcp:pipeline:gateFail 时按 blinkTarget 匹配触发 */
@keyframes pcp-blink-shake-anim {

  0%,
  100% {
    transform: translateX(0);
    box-shadow: 0 0 0 0 rgba(255, 80, 80, 0);
  }

  10%,
  30%,
  50%,
  70%,
  90% {
    transform: translateX(-3px);
    box-shadow: 0 0 8px 2px rgba(255, 80, 80, 0.85);
  }

  20%,
  40%,
  60%,
  80% {
    transform: translateX(3px);
    box-shadow: 0 0 8px 2px rgba(255, 80, 80, 0.85);
  }
}

.pcp-blink-shake {
  animation: pcp-blink-shake-anim 0.8s ease-in-out infinite;
  outline: 2px solid rgba(255, 80, 80, 0.85);
}
</style>
<template>
  <div class="top-toolbar">
    <!-- 左栏：必填信息（航司/航线/舱位） -->
    <div class="tt-box tt-left">
      <div class="ttb-title">必填信息</div>
      <div class="ttb-row">
        <span class="ttb-label">航司:</span>
        <n-input v-model:value="store.hangsi" class="ttb-input" :class="{ 'pcp-blink-shake': store.blinkTarget === 'hangsi' }"
          placeholder="如 FA" :disabled="store.pipelineInProgress" @blur="store.applyRouteFields()" />
      </div>
      <div class="ttb-row">
        <span class="ttb-label">航线:</span>
        <n-button type="default" class="ttb-input" :class="{ 'pcp-blink-shake': store.blinkTarget === 'file' }"
          :disabled="routeSelectDisabled" @click="store.handleUploadXlsx">
          选择文件
        </n-button>
      </div>
      <div class="ttb-row">
        <span class="ttb-label">舱位:</span>
        <n-input v-model:value="store.cangwei" class="ttb-input" :class="{ 'pcp-blink-shake': store.blinkTarget === 'cangwei' }"
          placeholder="如 Y,B（逗号分隔）" :disabled="store.pipelineInProgress" @blur="store.applyRouteFields()" />
      </div>
    </div>

    <!-- 中栏：任务总进度（进度条 + 开始/终止） -->
    <div class="tt-box tt-mid">
      <div class="ttb-title">任务总进度:</div>
      <n-progress type="line" :percentage="overallProgress" :show-indicator="true" />
      <div class="ttb-actions">
        <n-button type="success" class="ttb-btn" @click="store.handleStartExecution" :disabled="!canStart">
          开始
        </n-button>
        <n-button type="error" class="ttb-btn" @click="store.handleAbort" :disabled="!canAbort">
          终止
        </n-button>
      </div>
    </div>

    <!-- 右栏：下载目录操作 + 下载结果文件 -->
    <div class="tt-box tt-right">
      <n-button type="default" class="ttb-btn" @click="store.handleSelectDownloadDir">
        设置下载目录
      </n-button>
      <n-button type="default" class="ttb-btn" @click="store.handleOpenDownloadDir">
        打开下载目录
      </n-button>
      <!-- 下载按钮：进度填充动画，与 Stepper 步骤4 相同逻辑 -->
      <n-button :type="downloadButtonType" class="ttb-btn" :disabled="downloadButtonDisabled"
        :style="{ position: 'relative', overflow: 'hidden' }" @click="store.handleDownloadResult">
        <div class="download-progress-fill" :style="{ width: downloadProgressWidth + '%' }"></div>
        <span class="download-progress-label">{{ downloadButtonText }}</span>
      </n-button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { NButton, NInput, NProgress } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// ==================== 左栏：必填信息 ====================
// 选择文件前置：航司/舱位已填（新格式文件不含这两列）+ 流程不在进行中
const routeSelectDisabled = computed(() =>
  store.pipelineInProgress || !store.hangsi.trim() || !store.cangwei.trim()
)

// ==================== 中栏：任务总进度 ====================
// 总进度 = 已完成任务数 / 总任务数（无任务时 0）
const overallProgress = computed(() => {
  const total = store.tasks.length
  if (total === 0) return 0
  return Math.round((store.completedCount / total) * 100)
})

// 开始前置：a1 有数据 + 航司/舱位已填 + 真实步骤流不在进行中
//   （只有 idle/done 可点；running/waiting_next/paused 必须先完成或终止）
const canStart = computed(() =>
  store.a1Count > 0 && !!store.hangsi.trim() && !!store.cangwei.trim() && !store.pipelineInProgress
)

// 终止按钮：真实步骤流进行中都可点（running/waiting_next/paused）；idle/done 禁用
const canAbort = computed(() => !!store.pipelineInProgress)

// ==================== 右栏：下载按钮（与 Stepper 步骤4 一致） ====================
const downloadButtonType = computed(() => {
  const p = store.downloadProgress
  if (p === -1) return 'error'
  if (p === 100) return 'success'
  if (p !== null) return 'info'
  return store.a3Count > 0 ? 'success' : 'default'
})

// 按钮 disabled：下载中（0~99）才禁用；完成/出错停留态（100 / -1）不禁用（可再次点击重试/再导一份）
const downloadButtonDisabled = computed(() => {
  const p = store.downloadProgress
  // a3 没数据 → 始终禁用
  if (store.a3Count === 0) return true
  // 正在下载中（0 ≤ progress < 100 且非 -1 且非 100 且非 null）→ 禁用
  if (p === null) return false
  if (p === 100 || p === -1) return false
  return true
})

const downloadButtonText = computed(() => {
  const p = store.downloadProgress
  if (p === -1) return '失败'
  if (p === 100) return '已下载'
  if (p !== null) return `${Math.round(p)}%`
  return '下载文件，共两个'
})

const downloadProgressWidth = computed(() => {
  const p = store.downloadProgress
  if (p === null) return 0
  if (p === -1) return 100
  return p
})
</script>
