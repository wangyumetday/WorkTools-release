<!-- ============================================================
     PCP Stepper.vue - 4 步骤工作流
     职责：展示 4 个步骤卡片（上传Excel → 锦绣国际 → O平台组合 → 下载结果）
     数据流：
       - 全部状态来自 useTaskStore（store 内部调 IPC 维护）
       - 点击按钮触发 store action（handleUploadXlsx/handleAddJxgjTasks/...）
     说明：纯展示组件，不直接调 IPC
     ============================================================ -->

<template>
  <div style="padding: 16px 0">
    <n-space vertical size="large" style="width: 100%">
      <!-- 步骤1：上传Excel -->
      <n-card title="步骤1：上传Excel文件" :bordered="true">
        <n-space vertical size="medium">
          <n-space>
            <n-button type="primary" @click="store.handleUploadXlsx">选择Excel文件</n-button>
            <n-tag v-if="store.a1Count > 0" type="success">
              已解析 {{ store.a1Count }} 条数据
            </n-tag>
          </n-space>
          <n-data-table
            v-if="store.a1Data.length > 0"
            :columns="store.a1Columns"
            :data="store.a1Data.slice(0, 10)"
            :bordered="false"
            size="small"
          />
        </n-space>
      </n-card>

      <!-- 步骤2：获取锦绣国际数据 -->
      <n-card title="步骤2：获取锦绣国际数据" :bordered="true">
        <n-space vertical size="medium">
          <n-space>
            <n-button
              type="primary"
              @click="store.handleAddJxgjTasks"
              :disabled="buttonDisableJxgj"
            >
              生成锦绣国际任务（{{ store.a1Count }}条）
            </n-button>
            <n-tag v-if="store.a2Count > 0" type="success">
              a2数据：{{ store.a2Count }} 条
            </n-tag>
            <n-text v-if="store.currentStage === 'jxgj'" type="info">正在执行锦绣国际阶段...</n-text>
            <n-text v-else-if="store.autoChain && store.currentStage === null && store.a2Count === 0" type="info" depth="3">
              自动链路进行中，请等待
            </n-text>
          </n-space>
        </n-space>
      </n-card>

      <!-- 步骤3：获取O平台数据 -->
      <n-card title="步骤3：获取O平台数据（携程OTA+O2+O3）" :bordered="true">
        <n-space vertical size="medium">
          <n-space>
            <n-button
              type="primary"
              @click="store.handleAddOTasks"
              :disabled="buttonDisableO"
            >
              生成O平台组合任务（{{ store.a2Count }}条）
            </n-button>
            <n-tag v-if="store.a3Count > 0" type="success">
              a3数据：{{ store.a3Count }} 条
            </n-tag>
            <n-text v-if="store.currentStage === 'o_combo'" type="info">正在执行O平台阶段...</n-text>
            <n-text v-else-if="store.autoChain && store.currentStage === 'jxgj'" type="info" depth="3">
              自动链路进行中，请等待锦绣国际完成
            </n-text>
          </n-space>
        </n-space>
      </n-card>

      <!-- 步骤4：下载结果 -->
      <n-card title="步骤4：下载结果文件" :bordered="true">
        <n-space vertical>
          <!-- 下载目录行：显示当前目录 + 选择/打开按钮 -->
          <n-space align="center">
            <n-text depth="3">下载目录：</n-text>
            <n-text :type="store.downloadDir ? 'default' : 'warning'">
              {{ store.downloadDir || '未设置（首次默认桌面）' }}
            </n-text>
            <n-button size="small" @click="store.handleSelectDownloadDir">选择下载目录</n-button>
            <n-button
              size="small"
              :disabled="!store.downloadDir"
              @click="store.handleOpenDownloadDir"
            >打开下载目录</n-button>
          </n-space>

          <!-- 下载按钮 + 状态提示 -->
          <n-space align="center">
            <!--
              下载按钮交互（业内成熟做法）：
                - 点击后 disabled，避免连点
                - 内部 .download-progress-fill 是半透明白色叠层，width 跟随进度填充
                - 完成停留 1.5s 显示「已下载」→ 恢复空闲；出错停留显示「失败」
            -->
            <n-button
              :type="downloadButtonType"
              :disabled="downloadButtonDisabled"
              :style="{ position: 'relative', overflow: 'hidden', minWidth: '140px' }"
              @click="store.handleDownloadResult"
            >
              <div class="download-progress-fill" :style="{ width: downloadProgressWidth + '%' }"></div>
              <span class="download-progress-label">{{ downloadButtonText }}</span>
            </n-button>
            <n-text v-if="store.a3Count === 0" type="warning">请先完成O平台阶段</n-text>
            <n-text v-if="store.lastDownloadFilename" type="success" depth="2">
              最近保存：{{ store.lastDownloadFilename }}
            </n-text>
          </n-space>
        </n-space>
      </n-card>
    </n-space>
  </div>
</template>

<script setup>
import { onMounted, computed } from 'vue'
import {
  NCard, NSpace, NButton, NTag, NDataTable, NText
} from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

// 拿到 task store 实例（state + actions 都来自 store）
const store = useTaskStore()

// 组件挂载时初始化 store（注册监听器 + 拉取最新状态）
onMounted(async () => {
  await store.init()
})

// ==================== 步骤 2 / 3 按钮禁用逻辑 ====================
// 说明：原来手动流程下只禁用 a1/a2 为空和 isRunning；
//     现在加了「自动链路」模式（startAutoChain），autoChain=true 时步骤 2/3 由系统调度自动跑，
//     按钮保持禁用避免重复添加任务；用户需要中途改，只能点 TaskMonitor 的"暂停/清空"（会关闭 autoChain）。

const buttonDisableJxgj = computed(() => (
  // 无数据、运行中、自动链路中 任一成立都禁用
  store.a1Count === 0 || store.isRunning || store.autoChain
))

const buttonDisableO = computed(() => (
  // 无 a2 数据、运行中、自动链路中（哪怕 JXGJ 还在跑，O 按钮也禁用，等自动链路触发）
  store.a2Count === 0 || store.isRunning || store.autoChain
))

// ==================== 下载按钮状态计算 ====================
//   downloadProgress 取值：null（空闲）/ 0~99（下载中）/ 100（完成停留）/ -1（出错停留）
//   按"业内成熟做法"：下载中按钮 disabled + 半透明白色叠层从左到右填充表示进度
//   完成停留 1.5s 显示"已下载"（满填充）→ 恢复空闲；出错同理显示"失败"

// 按钮颜色：空闲绿、下载中蓝、完成绿、出错红、无数据灰
const downloadButtonType = computed(() => {
  const p = store.downloadProgress
  if (p === -1) return 'error'
  if (p === 100) return 'success'
  if (p !== null) return 'info'          // 0~99 下载中
  return store.a3Count > 0 ? 'success' : 'default'
})

// 按钮 disabled：下载中（0~99）才禁用；完成/出错停留态（100 / -1）不禁用（可再次导出）
const downloadButtonDisabled = computed(() => {
  const p = store.downloadProgress
  if (store.a3Count === 0) return true
  if (p === null || p === 100 || p === -1) return false
  return true
})

// 按钮文案：空闲/百分比/已下载/失败
//   下载中只显示百分比（如 "50%"），文案短、宽度稳定
//   按钮整体宽度由 min-width 固定（见 template :style），文案变化不会撑抖
const downloadButtonText = computed(() => {
  const p = store.downloadProgress
  if (p === -1) return '失败'
  if (p === 100) return '已下载'
  if (p !== null) return `${Math.round(p)}%`
  return '下载结果Excel'
})

// 进度填充宽度：下载中按百分比；完成/出错时填满；空闲时为 0
const downloadProgressWidth = computed(() => {
  const p = store.downloadProgress
  if (p === null) return 0
  if (p === -1) return 100   // 出错也填满（红色叠层）
  return p                  // 0~100
})
</script>

<style scoped>
/* 下载按钮进度填充：半透明白色叠层从左到右铺，宽度跟随进度 */
.download-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.35);
  transition: width 0.3s ease;
  z-index: 0;
  pointer-events: none;          /* 不挡按钮点击 */
}
/* 按钮文案放在叠层之上 */
.download-progress-label {
  position: relative;
  z-index: 1;
}
</style>
