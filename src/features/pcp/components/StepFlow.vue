<!-- ============================================================
     PCP StepFlow.vue - 步骤流组件（阶段3 全权重构）
     职责：
       - 横向展示 4 步骤状态（upload/jxgj/o_combo/export）
       - auto 模式：只读展示当前运行到哪一步
       - dev 模式：步骤可点击触发（jxgj/o_combo 走 pipeline.triggerStep；
                   upload 选文件、export 下载仍调 store action）
     数据流：全部来自 useTaskStore（pipelineState + a1/a2/a3 计数）
     闪烁引导：不在本组件，闪烁目标分布在 TopToolbar(选文件按钮) 和
               PlatformConfig(平台配置块)，由 store.blinkTarget 驱动
     ============================================================ -->

<template>
  <div class="step-flow">
    <div
      v-for="(step, i) in steps"
      :key="step.key"
      class="sf-step"
      :class="stepClass(i)"
      @click="handleStepClick(i)"
    >
      <div class="sf-step__index">
        <span v-if="stepStatus(i) === 'finish'" class="sf-check">✓</span>
        <span v-else>{{ i + 1 }}</span>
      </div>
      <div class="sf-step__body">
        <div class="sf-step__title">{{ step.title }}</div>
        <div class="sf-step__desc">{{ statusText(i) }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// 步骤定义：key 与 Pipeline.step 对齐
const steps = [
  { key: 'upload', title: '上传Excel' },
  { key: 'jxgj', title: '锦绣国际' },
  { key: 'o_combo', title: 'O平台组合' },
  { key: 'export', title: '下载结果' }
]

const isDev = computed(() => store.pipelineState.mode === 'dev')

// 步骤顺序（与 Pipeline.step 对齐）
//   用于比较「当前流程推进到第几步」，i < 当前索引 = 已完成
const STEP_ORDER = ['upload', 'jxgj', 'o_combo', 'export']

// 每步状态：'finish' | 'process' | 'wait' | 'clickable'
//   全部依据 pipelineState（状态机），不再查 a1/a2/a3 计数
function stepStatus(i) {
  const ps = store.pipelineState
  const currentIdx = STEP_ORDER.indexOf(ps.step)

  // 之前的步骤 → 已完成（流程已推进到后面，这是唯一可靠的完成证据）
  if (i < currentIdx) return 'finish'

  // 当前步骤
  if (i === currentIdx) {
    // 正在运行
    if (ps.status === 'running') return 'process'

    // 步骤④ export 特殊：done 表示流程跑完，但用户可能还没下载
    if (i === 3) {
      if (store.downloadProgress === 100) return 'finish'
      return 'clickable' // 可下载（auto 和 dev 两种模式都可点）
    }

    // 步骤①-③：status='done' 表示真正完成
    if (ps.status === 'done') return 'finish'

    // dev 模式 + 空闲/等待下一步 → 可手动点击触发
    if (isDev.value && (ps.status === 'idle' || ps.status === 'waiting_next')) {
      return 'clickable'
    }

    // auto 模式空闲 → 等待（不再是 process）
    return 'wait'
  }

  // 之后的步骤 → 等待
  return 'wait'
}

function stepClass(i) {
  const s = stepStatus(i)
  return {
    'sf-step--finish': s === 'finish',
    'sf-step--process': s === 'process',
    'sf-step--clickable': s === 'clickable',
    'sf-step--wait': s === 'wait'
  }
}

function statusText(i) {
  const s = stepStatus(i)
  if (s === 'finish') return '已完成'
  if (s === 'process') return '执行中…'
  if (s === 'clickable') {
    if (i === 0) return '点击上传'
    if (i === 3) return '可下载'
    return '点击执行'
  }
  return '等待'
}

function handleStepClick(i) {
  const s = stepStatus(i)
  if (s !== 'clickable') return
  // 「硬锁定」running/paused：任何真实入口都禁（避免重入/换文件混结果）
  // waiting_next（dev 模式停在中间等用户点下一步）→ 允许 jxgj/o_combo；
  //              但 upload（i=0）仍然禁（流程过半后不能换文件/重传覆盖 a1）
  const status = store.pipelineState.status || 'idle'
  const hardLock = status === 'running' || status === 'paused'
  if (hardLock && i !== 3) return
  if (status === 'waiting_next' && i === 0) return
  if (i === 0) { store.handleUploadXlsx(); return }
  if (i === 1) { store.pipelineTriggerStep('jxgj'); return }
  if (i === 2) { store.pipelineTriggerStep('o_combo'); return }
  if (i === 3) { store.handleDownloadResult(); return }
}
</script>

<style scoped>
.step-flow {
  display: flex;
  gap: 8px;
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  padding: 8px 12px;
}

.sf-step {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: default;
  transition: all 0.2s ease;
  min-width: 0;
}

.sf-step__index {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: #f0f0f0;
  color: #999;
}

.sf-step__body {
  flex: 1;
  min-width: 0;
}

.sf-step__title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sf-step__desc {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
  white-space: nowrap;
}

/* 完成：绿色 */
.sf-step--finish .sf-step__index {
  background: #18a058;
  color: #fff;
}
.sf-step--finish .sf-step__title { color: #18a058; }

/* 进行中：蓝色边框 + 蓝色序号 */
.sf-step--process {
  border-color: #2080f0;
  background: #f0f7ff;
}
.sf-step--process .sf-step__index {
  background: #2080f0;
  color: #fff;
}
.sf-step--process .sf-step__title { color: #2080f0; }
.sf-step--process .sf-step__desc { color: #2080f0; }

/* 可点击（dev 模式）：橙色虚线边框 + pointer */
.sf-step--clickable {
  border: 1px dashed #f0a020;
  cursor: pointer;
}
.sf-step--clickable:hover {
  background: #fff8e6;
  border-style: solid;
}
.sf-step--clickable .sf-step__index {
  background: #f0a020;
  color: #fff;
}
.sf-step--clickable .sf-step__desc { color: #f0a020; }

/* 等待：灰色 */
.sf-step--wait { opacity: 0.55; }

.sf-check { font-size: 14px; line-height: 1; }
</style>
