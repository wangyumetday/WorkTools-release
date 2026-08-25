<!-- ============================================================
     PCP StageFlow.vue - 细粒度阶段状态流（横向版本）
     7 个阶段（stage.key 顺序与 Pipeline.STAGE_DEFS 保持一致）：
       upload → jxgj → trip → o2 → o3 → a3_merge → export

     关键设计：
       1. 阶段状态的单一事实来源 = store.pipelineState.stages[i]
          不再通过「粗 step 索引 + a1/a2/a3 计数」反推，彻底修掉
          "a3 0 条就误以为阶段没完成"的老 bug。
       2. 只在 3 处可点击（其余阶段纯展示）：
          · upload (阶段 0)   → handleUploadXlsx
          · jxgj   (阶段 1)   → dev 模式 + jxgj idle → pipeline.triggerStep('jxgj')
          · trip   (阶段 2)   → dev 模式 + O 组全部 idle → pipeline.triggerStep('o_combo')
            （trip/o2/o3/a3 仍作为一组整体触发，符合当前 task scheduler 实现）
          · export (阶段 6)   → _exportGate.can → handleDownloadResult
       3. 老 StepFlow.vue 文件保留不删、不在 Home.vue 中 import 即可。
       4. pipelineState 仍带老字段 status/step 兼容；但本组件完全用 stages。
       5. 横向布局：徽章 + 简短标题可见；完整状态（任务计数/失败原因等）
          通过 hover Tooltip 显示；步骤间用直线相连；超出宽度时横向滚动。
     ============================================================ -->

<template>
  <div class="stage-flow">
    <n-tooltip
      v-for="(stage, i) in stages"
      :key="stage.key"
      trigger="hover"
      placement="bottom"
      :delay="200"
      :duration="0"
    >
      <template #trigger>
        <div
          class="stage-row"
          :class="rowClass(stage, i)"
          @click="handleStageClick(stage, i)"
        >
          <!-- 徽章：序号 / 状态图标 -->
          <div class="stage-row__badge" :class="badgeClass(stage)">
            <template v-if="stage.status === 'completed'">✓</template>
            <template v-else-if="stage.status === 'skipped'">⊘</template>
            <template v-else-if="stage.status === 'failed'">!</template>
            <template v-else-if="stage.status === 'running' && ps.status === 'paused'">‖</template>
            <template v-else-if="stage.status === 'running'">↻</template>
            <template v-else>{{ i + 1 }}</template>
          </div>

          <!-- 简短标题（单行截断） -->
          <div class="stage-row__title">{{ stage.title }}</div>
        </div>
      </template>

      <!-- Tooltip：完整状态信息 -->
      <div class="stage-tip">
        <div class="stage-tip__title">{{ stage.title }}</div>
        <div class="stage-tip__desc">
          <!-- completed -->
          <template v-if="stage.status === 'completed'">
            <span class="t-ok">已完成</span>
            <span class="t-meta">
              <template v-if="hasTaskCount(stage)">
                · {{ stage.completedTasks }}/{{ stage.totalTasks }}
                <template v-if="stage.failedTasks > 0">
                  · <span class="t-warn">失败 {{ stage.failedTasks }}</span>
                </template>
                ·
              </template>
              <template v-if="stage.outputCount != null">
                <template v-if="stage.outputCount === 0" class="t-mute">0 条结果</template>
                <template v-else>{{ stage.outputCount }} 条</template>
              </template>
              <template v-if="stage.error" class="t-warn">· {{ stage.error }}</template>
            </span>
          </template>

          <!-- running -->
          <template v-else-if="stage.status === 'running'">
            <span class="t-run">执行中</span>
            <span class="t-meta">
              <template v-if="hasTaskProgress(stage)">
                {{ stage.completedTasks || 0 }}/{{ stage.totalTasks || '?' }}
                <template v-if="stage.failedTasks > 0">
                  · <span class="t-warn">失败 {{ stage.failedTasks }}</span>
                </template>
              </template>
              <template v-else>等待调度…</template>
              <template v-if="ps.status === 'paused'"> · 已暂停</template>
            </span>
          </template>

          <!-- skipped -->
          <template v-else-if="stage.status === 'skipped'">
            <span class="t-skip">跳过</span>
            <span class="t-mute">· {{ stage.skipReason || '不适用' }}</span>
          </template>

          <!-- failed -->
          <template v-else-if="stage.status === 'failed'">
            <span class="t-err">失败</span>
            <span class="t-meta">
              <template v-if="hasTaskCount(stage)">
                失败 {{ stage.failedTasks }}/{{ stage.totalTasks }} ·
              </template>
              <span class="t-err-msg">{{ stage.error || '未知错误' }}</span>
            </span>
          </template>

          <!-- clickable (idle 但允许触发) -->
          <template v-else-if="isClickable(stage, i)">
            <span class="t-click">可点击</span>
            <span class="t-meta">
              <template v-if="stage.key === 'upload'">· 点击选择 Excel 文件</template>
              <template v-else-if="stage.key === 'jxgj'">· dev 模式：点击执行锦绣国际</template>
              <template v-else-if="stage.key === 'trip'">· dev 模式：点击执行 O 平台组合</template>
              <template v-else-if="stage.key === 'export'">· {{ exportClickHint }}</template>
            </span>
          </template>

          <!-- idle -->
          <template v-else>
            <span class="t-idle">等待</span>
          </template>
        </div>
      </div>
    </n-tooltip>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// 细粒度阶段数组：来自 pipelineState.stages（pipeline.getState() 推送）
// 回退：如果 stages 字段还没推送（pipeline 旧版 / 初始化前），用 7 个空壳占位，避免白屏
const stages = computed(() => {
  const ps = store.pipelineState
  if (Array.isArray(ps.stages) && ps.stages.length > 0) return ps.stages
  return [
    { key: 'upload',   title: '导入 Excel 原始数据',   status: 'idle' },
    { key: 'jxgj',     title: '锦绣国际获取官网票价',   status: 'idle' },
    { key: 'trip',     title: '携程获取底价',           status: 'idle' },
    { key: 'o2',       title: 'O2 平台比价',            status: 'idle' },
    { key: 'o3',       title: 'O3 平台比价',            status: 'idle' },
    { key: 'a3_merge', title: '交叉合并生成政策',       status: 'idle' },
    { key: 'export',   title: '导出结果 Excel',         status: 'idle' }
  ]
})

// 粗状态 & 导出门控
const ps = computed(() => store.pipelineState)
const exportGate = computed(() => ps.value._exportGate || { can: false })
const isDev = computed(() => ps.value.mode === 'dev')

// 工具：这个阶段有没有任务统计
function hasTaskCount(s) {
  return Number.isFinite(s.totalTasks) && s.totalTasks > 0
}
function hasTaskProgress(s) {
  return Number.isFinite(s.totalTasks)
}

// ========== 可点击判断（只有 upload/jxgj/trip/export 四个"入口"能点）==========
function isClickable(stage, i) {
  // export 阶段：只要 _exportGate.can === true（无论 dev/auto；完成后用户都该点下载）
  if (stage.key === 'export') return exportGate.value.can === true

  // running/paused 中不能点（避免重入）
  if (ps.value.status === 'running' || ps.value.status === 'paused') return false

  if (stage.key === 'upload') {
    // upload 一直可以点（允许用户重新上传文件覆盖 a1）
    return true
  }

  if (stage.key === 'jxgj') {
    if (!isDev.value) return false
    // jxgj 没跑过 (idle) 且 已上传文件可开启 → 可点
    return stage.status === 'idle' && stages.value[0].status === 'completed'
  }

  if (stage.key === 'trip') {
    if (!isDev.value) return false
    // O 组入口：trip 显示"点击执行 O 组合"
    // 前置：jxgj completed + O 组 4 个阶段 (trip/o2/o3/a3_merge) 都还没开始
    const jxgj = stages.value[1]
    const oGroup = ['trip','o2','o3','a3_merge'].map(k => stages.value.find(s => s.key === k))
    const allIdle = oGroup.every(s => !s || s.status === 'idle')
    return jxgj.status === 'completed' && allIdle
  }

  return false
}

// 导出门控的文字提示
const exportClickHint = computed(() => {
  if (!exportGate.value.can) return ''
  const a3 = stages.value.find(s => s.key === 'a3_merge')
  if (!a3) return '点击下载'
  if ((a3.outputCount || 0) === 0) return '点击下载（0 条数据 / 仅表头文件）'
  return `点击下载（${a3.outputCount} 条政策）`
})

// ========== 样式 class ==========
function badgeClass(stage) {
  switch (stage.status) {
    case 'completed': return 'badge--ok'
    case 'running':   return ps.value.status === 'paused' ? 'badge--pause' : 'badge--run'
    case 'skipped':   return 'badge--skip'
    case 'failed':    return 'badge--err'
    default:
      return isClickable(stage, stages.value.indexOf(stage)) ? 'badge--click' : 'badge--idle'
  }
}
function rowClass(stage, i) {
  return {
    'row--ok':     stage.status === 'completed',
    'row--run':    stage.status === 'running' && ps.value.status !== 'paused',
    'row--pause':  stage.status === 'running' && ps.value.status === 'paused',
    'row--skip':   stage.status === 'skipped',
    'row--err':    stage.status === 'failed',
    'row--click':  isClickable(stage, i)
  }
}

// ========== 点击处理 ==========
function handleStageClick(stage, i) {
  if (!isClickable(stage, i)) return
  if (stage.key === 'upload') { store.handleUploadXlsx(); return }
  if (stage.key === 'jxgj')   { store.pipelineTriggerStep('jxgj'); return }
  if (stage.key === 'trip')   { store.pipelineTriggerStep('o_combo'); return }
  if (stage.key === 'export') { store.handleDownloadResult(); return }
}
</script>

<style scoped>
/* ========= 横向容器 ========= */
.stage-flow {
  display: flex;
  flex-direction: row;
  gap: 12px;                       /* 步骤间空隙，由 connector 跨越 */
  align-items: flex-start;
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  padding: 10px 8px;
  overflow-x: auto;                /* 超宽时横向滚动 */
  min-height: 56px;
}

/* ========= 单个步骤（紧凑卡片） ========= */
.stage-row {
  position: relative;
  flex: 0 0 auto;
  min-width: 64px;
  max-width: 96px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 4px;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: all 0.18s ease;
  cursor: default;
}

/* ========= 步骤间连接线 ========= */
/* 由当前 row 的 ::after 向右伸出，跨越 .stage-flow 的 gap，连到下一个 row 的左缘 */
.stage-row:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 14px;          /* badge 顶部 4(padding) + 10(badge 22/2) = 14 → 圆心 */
  right: -12px;       /* 伸入 gap（gap=12） */
  width: 12px;
  height: 2px;
  background: #d8d8d8;
  z-index: 0;
}

/* ========= 徽章 ========= */
.stage-row__badge {
  position: relative;
  z-index: 1;          /* 压住连接线 */
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  background: #f0f0f0;
  color: #999;
}

/* ========= 简短标题 ========= */
.stage-row__title {
  font-size: 11px;
  font-weight: 600;
  color: #555;
  text-align: center;
  max-width: 88px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

/* ========= Tooltip 内容 ========= */
.stage-tip {
  font-size: 12px;
  line-height: 1.55;
  max-width: 260px;
}
.stage-tip__title {
  font-weight: 600;
  color: #333;
  margin-bottom: 2px;
}
.stage-tip__desc {
  color: #777;
}

/* ——— 状态色彩 ——— */

/* 已完成：绿色 */
.row--ok .badge--ok       { background: #18a058; color: #fff; }
.row--ok .stage-row__title { color: #18a058; }
.t-ok                    { color: #18a058; font-weight: 600; }

/* 运行中：蓝色 */
.row--run                 { background: #f0f7ff; border-color: #b8d6ff; }
.row--run .badge--run     { background: #2080f0; color: #fff; }
.row--run .stage-row__title { color: #2080f0; }
.t-run                   { color: #2080f0; font-weight: 600; }

/* 暂停：黄色 */
.row--pause               { background: #fff8e6; border-color: #f3d99e; }
.row--pause .badge--pause { background: #f0a020; color: #fff; }

/* 跳过：灰蓝 */
.row--skip                { background: #fafafa; border-color: #e5e7eb; }
.row--skip .badge--skip   { background: #9ca3af; color: #fff; }
.t-skip                  { color: #6b7280; font-weight: 600; }

/* 失败：红色 */
.row--err                 { background: #fff1f0; border-color: #ffccc7; }
.row--err .badge--err     { background: #d03050; color: #fff; }
.row--err .stage-row__title { color: #d03050; }
.t-err                   { color: #d03050; font-weight: 600; }
.t-err-msg               { color: #d03050; }

/* 可点击：橙色虚线 */
.row--click {
  border: 1px dashed #f0a020;
  cursor: pointer;
  background: #fffaf0;
}
.row--click:hover {
  border-style: solid;
  background: #fff4de;
}
.row--click .badge--click { background: #f0a020; color: #fff; }
.t-click                { color: #f0a020; font-weight: 600; }

/* idle */
.badge--idle            { background: #f0f0f0; color: #999; }
.t-idle                 { color: #aaa; }

/* 文字通用辅助类（tooltip 内） */
.t-meta                 { color: #777; margin-left: 4px; }
.t-mute                 { color: #aaa; }
.t-warn                 { color: #c97c00; font-weight: 600; }
</style>
