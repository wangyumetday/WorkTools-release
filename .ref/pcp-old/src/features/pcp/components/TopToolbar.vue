<!-- ============================================================
     PCP TopToolbar.vue - 顶部工具栏组件
     职责：快捷操作入口，2 行布局，按图片样式自动两侧对齐
     第1行：选择Excel文件 | 就绪状态 | 开始执行
     第2行：下载目录路径 | 选择下载目录 | 最近保存文件名 | 下载结果Excel
     数据流：全部来自 useTaskStore
     ============================================================ -->
<style scoped>
.top-toolbar {
  width: 100%;
  display: flex;
  flex-flow: row nowrap;
  justify-content: space-between;
  gap: 16px;
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  padding: 16px 20px;

  .tt-box {
    display: flex;
    flex-direction: column;
    gap: 14px;

    .ttb-item {
      display: flex;
      flex-flow: row nowrap;
      gap: 4px;
      justify-content: flex-start;

      * {
        font-size: 16px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ttb-btn {
        width: 120px;
      }

      .ttb-msm {
        font-size: 14px;
        font-weight: 400;
        max-width: 140px;
        min-width: 40px;
      }
    }

    .ttb-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .ttb-bottom {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  }

  .tt-left {
    .ttb-item {}
  }

  .tt-right {
    .ttb-item {
      justify-content: flex-end;
    }
  }


}
</style>
<template>
  <div class="top-toolbar">
    <!-- 第1行：选择文件 + 就绪状态 + 开始执行 -->
    <div class="tt-left tt-box">
      <div class="ttb-item ttb-top">
        <n-button type="error" class="ttb-btn" @click="store.handleUploadXlsx">
          选择Excel文件
        </n-button>
        <n-text v-if="readyStatus" :type="readyStatus.type" depth="3" class="ttb-msm">
          {{ readyStatus.text }}
        </n-text>
      </div>
      <div class="ttb-item ttb-bottom">
        <n-button type="success" class="ttb-btn" @click="handleStartExecution" :disabled="!canStart">
          开始
        </n-button>
      </div>
    </div>
    <div class="tt-right tt-box">
      <div class="ttb-item ttb-top">
        <n-text v-if="store.downloadDir" class="ttb-msm" :tooltip="store.downloadDir">
          {{ store.downloadDir }}
        </n-text>
        <n-text v-else depth="3" class="ttb-msm">
          未设置下载目录
        </n-text>
        <n-button type="default" class="ttb-btn" @click="store.handleSelectDownloadDir">
          选择下载目录
        </n-button>
      </div>
      <div class="ttb-item ttb-bottom">
        <n-text v-if="store.lastDownloadFilename" depth="3" @click="store.打开目录" style="cursor: pointer" class="ttb-msm">
          最近保存：{{ store.lastDownloadFilename }}
        </n-text>
        <!-- 下载按钮：进度填充动画，与 Stepper 步骤4 相同逻辑 -->
        <n-button :type="downloadButtonType" class="ttb-btn" :disabled="downloadButtonDisabled"
          :style="{ position: 'relative', overflow: 'hidden', minWidth: '120px' }" @click="store.handleDownloadResult">
          <div class="download-progress-fill" :style="{ width: downloadProgressWidth + '%' }"></div>
          <span class="download-progress-label">{{ downloadButtonText }}</span>
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { NButton, NTag, NEllipsis, NText, NSpace } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'
import api from '@/shared/api.js'
import message from '@/shared/message.js'

const store = useTaskStore()
// ==================== 就绪状态 ====================
// a1 有数据 → 绿色「就绪·文件名」；无数据 → 灰色「未就绪」
const readyStatus = computed(() => {
  if (store.a1Count > 0) {
    // 从 a1Data 第一行取文件名（如果有的话），否则只显示数据条数
    const firstRow = store.a1Data[0]
    const fileName = store.selectedFile || firstRow?.文件名 || ''
    console.log(store)
    if (fileName) {
      return { type: 'success', text: `已选·${fileName}` }
    }
    return { type: 'success', text: `已选·${store.a1Count}条数据` }
  }
  return { type: 'default', text: '未就绪' }
})

// ==================== 开始执行按钮 ====================
// 前置条件：a1 有数据 + 非运行中 + 非 autoChain 自动链路中
const canStart = computed(() =>
  store.a1Count > 0 && !store.isRunning && !store.autoChain
)

/**
 * 一键执行：锦绣国际阶段 → O平台组合阶段，结束后停在「等待用户点下载」
 *   核心逻辑抽在 store.startAutoChain，这里只做门面调用 + 按钮禁用前置校验
 *   下载政策文件（步骤4）始终需要用户手动点「下载政策文件」
 */
async function handleStartExecution() {
  await store.startAutoChain()
}

// ==================== 下载按钮状态（与 Stepper 步骤4 一致） ====================
const downloadButtonType = computed(() => {
  const p = store.downloadProgress
  if (p === -1) return 'error'
  if (p === 100) return 'success'
  if (p !== null) return 'info'
  return store.a3Count > 0 ? 'success' : 'default'
})

// 按钮 disabled：下载中（0~99）才禁用；完成/出错停留态（100 / -1）不禁用（用户可以再次点击重试/再导一份）
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
  return '下载政策文件'
})

const downloadProgressWidth = computed(() => {
  const p = store.downloadProgress
  if (p === null) return 0
  if (p === -1) return 100
  return p
})
</script>
