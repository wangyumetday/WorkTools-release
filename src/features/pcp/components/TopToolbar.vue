<!-- ============================================================
     PCP TopToolbar.vue - 顶部工具栏组件
     职责：
       左栏「必填信息」：选择航线文件
         新格式：文件内含航司(R1)/舱位(R2)/航线(R4+)，无需 UI 输入
       中栏「任务总进度」：任务进度条 + 开始/终止
       右栏：设置下载目录 / 打开下载目录 / 下载文件
     数据流：全部来自 useTaskStore
     ============================================================ -->
<style scoped>
.top-toolbar {
  width: 100%;
  max-height: 400px;
  overflow: auto;
  display: flex;
  /* ★ wrap：窗口较窄（右栏加宽后左栏被压缩）时三组按钮自动换行，
     避免溢出浮到右栏下方造成重叠；宽屏下仍是同一行三栏 */
  flex-flow: row wrap;
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
    /* ★ 固定宽度：航司/舱位/航线内容再长也只在框内换行，不得反推撑宽左栏破坏布局
       宽度 = label 42 + gap 8 + 按钮 160 + 左右内边距 32 + 余量 */
    flex: 0 0 248px;
    width: 248px;
    min-width: 0;
    box-sizing: border-box;
    justify-content: center;

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

    .ttb-btn {
      width: 160px;
    }

    /* 文件解析信息（航司/舱位/航线）：虚线与按钮行分隔，常驻三行 */
    .ttb-fileinfo {
      display: flex;
      flex-flow: column nowrap;
      gap: 6px;
      width: 100%;
      padding-top: 8px;
      border-top: 1px dashed #e0e0e0;
    }

    .ttb-fi-row {
      display: flex;
      flex-flow: row nowrap;
      align-items: flex-start;
      gap: 8px;
      font-size: 12.5px;
      line-height: 1.5;
    }

    .ttb-fi-value {
      flex: 1 1 auto;
      min-width: 0;
      color: #333;
      word-break: break-all;
    }

    /* 航线多条逗号连接，等宽字体便于辨识机场码 */
    .ttb-fi-routes {
      font-family: 'Consolas', 'Menlo', monospace;
      font-size: 12px;
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
    <!-- 左栏：必填信息（选择航线文件） -->
    <div class="tt-box tt-left">
      <div class="ttb-title">必填信息</div>
      <div class="ttb-row">
        <span class="ttb-label">航线:</span>
        <n-button type="default" class="ttb-btn" :class="{ 'pcp-blink-shake': store.blinkTarget === 'file' }"
          :disabled="store.pipelineInProgress" @click="store.handleUploadXlsx">
          选择文件
        </n-button>
      </div>
      <!-- 文件解析信息：航司 / 舱位 / 航线（原右栏「舱位航线组配」折叠面板移入，常驻不折叠） -->
      <div v-if="store.routesInfo.hangsi" class="ttb-fileinfo">
        <div class="ttb-fi-row">
          <span class="ttb-label">航司</span>
          <span class="ttb-fi-value">{{ store.routesInfo.hangsi }}</span>
        </div>
        <div class="ttb-fi-row">
          <span class="ttb-label">舱位</span>
          <span class="ttb-fi-value">{{ store.routesInfo.cangwei }}</span>
        </div>
        <div class="ttb-fi-row">
          <span class="ttb-label">航线</span>
          <span class="ttb-fi-value ttb-fi-routes">{{ store.routesInfo.routes.join('，') }}</span>
        </div>
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
import { NButton, NProgress } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// ==================== 中栏：任务总进度 ====================
// 总进度 = 已完成任务数 / 总任务数（无任务时 0）
const overallProgress = computed(() => {
  const total = store.tasks.length
  if (total === 0) return 0
  return Math.round((store.completedCount / total) * 100)
})

// 开始前置：a1 有数据 + 真实步骤流不在进行中
//   （只有 idle/done 可点；running/waiting_next/paused 必须先完成或终止）
const canStart = computed(() => store.a1Count > 0 && !store.pipelineInProgress)

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
