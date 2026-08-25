<!-- ============================================================
     PCP StepFlow.vue - 步骤流程显示组件
     职责：横向展示 4 个步骤名称，只读（不可点击操作），显示当前进度状态
     布局：横向 n-steps，步骤名+状态图标，底部固定在左栏
     ============================================================ -->

<template>
  <div class="step-flow">
    <n-steps
      :current="currentStepIndex"
      :status="stepStatus"
      size="small"
    >
      <n-step
        v-for="(step, i) in steps"
        :key="i"
        :title="step.title"
        :status="getStepStatus(i)"
      />
    </n-steps>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { NSteps, NStep } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// 步骤定义：标题 + 描述
const steps = [
  { title: '步骤1', desc: '上传Excel' },
  { title: '步骤2', desc: '锦绣国际数据' },
  { title: '步骤3', desc: 'O平台组合' },
  { title: '步骤4', desc: '下载结果' }
]

// 根据当前状态推导每个步骤的 status：'finish' | 'process' | 'wait' | 'error'
// 逻辑：
//   - 步骤1：a1 有数据 → finish，否则 process（未就绪等待上传）
//   - 步骤2：a2 有数据 → finish；currentStage==='jxgj' → process；a1 有数据 → process（可开始）；否则 wait
//   - 步骤3：a3 有数据 → finish；currentStage==='o_combo' → process；a2 有数据 → process（可开始）；否则 wait
//   - 步骤4：a3 有数据 → process（可下载）；否则 wait
const stepStatus = computed(() => {
  const a1Ok = store.a1Count > 0
  const a2Ok = store.a2Count > 0
  const a3Ok = store.a3Count > 0
  const stage = store.currentStage

  return [
    a1Ok ? 'finish' : 'process',
    a3Ok ? 'finish'                                      // 步骤2：a3 有数据说明 JXGJ+O 都完成了
      : (stage === 'jxgj' ? 'process' : (a1Ok ? 'process' : 'wait')),
    a3Ok ? 'finish'
      : (stage === 'o_combo' ? 'process' : (a2Ok ? 'process' : 'wait')),
    a3Ok ? 'process' : 'wait'
  ]
})

// n-steps 的 current 属性：指向"正在进行"的步骤 index
// 如果所有步骤都 wait，current 指向第一个可执行的步骤
const currentStepIndex = computed(() => {
  const statuses = stepStatus.value
  // 找到第一个非 finish 的步骤
  const firstNonFinish = statuses.findIndex(s => s !== 'finish')
  return firstNonFinish === -1 ? steps.length : firstNonFinish
})

// 给每个 n-step 单独设置 status（覆盖 n-steps 的 :status 默认值）
function getStepStatus(i) {
  return stepStatus.value[i]
}
</script>

<style scoped>
.step-flow {
  padding: 8px 16px;
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
}
</style>
