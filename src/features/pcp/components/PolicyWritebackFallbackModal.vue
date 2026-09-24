<!-- ============================================================
     PCP 政策回写文件读取失败 → 处置选项框
     场景：下载时惰性读取用户政策文件失败（被删除/移动/格式不符等）
     选项：① 重新选择一个正确的政策文件后重试下载
           ② 跳过回写直接输出（ID / CreateTime 为空的新增类型政策导入文件）
     数据流：状态与动作全部来自 useTaskStore（store.policyWritebackIssue）
     ============================================================ -->
<template>
  <n-modal
    :show="visible"
    preset="card"
    title="政策回写文件读取失败"
    style="width: 560px"
    :mask-closable="false"
    @update:show="onUpdateShow"
  >
    <div class="pwf-body">
      <div class="pwf-tip">
        本轮无法把携程政策的 <b>ID</b> / <b>CreateTime</b> 回写到你的政策文件。
      </div>
      <div class="pwf-reason">{{ issue.reason }}</div>
      <div v-if="issue.path" class="pwf-path">文件路径：{{ issue.path }}</div>

      <div class="pwf-ask">请选择处理方式：</div>

      <div class="pwf-option" @click="store.handlePolicyIssueRepick">
        <div class="pwf-option-title">① 重新选择政策文件</div>
        <div class="pwf-option-desc">选一个正确的政策文件，选中后自动重新下载并回写。</div>
      </div>

      <div class="pwf-option" @click="store.handlePolicyIssueSkip">
        <div class="pwf-option-title">② 直接输出（不含回写）</div>
        <div class="pwf-option-desc">跳过回写生成导入文件：ID / CreateTime 为空，等同于新增类型政策。</div>
      </div>
    </div>

    <template #footer>
      <div class="pwf-footer">
        <n-button @click="store.handlePolicyIssueCancel">取消</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.pwf-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  line-height: 1.6;
}

.pwf-tip {
  color: #333;
}

.pwf-reason {
  padding: 8px 10px;
  border: 1px solid #ffccc7;
  border-radius: 4px;
  background: #fff2f0;
  color: #cf1322;
  word-break: break-all;
}

.pwf-path {
  color: #888;
  font-size: 12px;
  word-break: break-all;
}

.pwf-ask {
  margin-top: 4px;
  font-weight: 600;
  color: #333;
}

.pwf-option {
  padding: 10px 12px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.pwf-option:hover {
  border-color: #2080f0;
  background: #f0f7ff;
}

.pwf-option-title {
  font-size: 14px;
  font-weight: 600;
  color: #2080f0;
}

.pwf-option-desc {
  margin-top: 2px;
  color: #666;
  font-size: 12px;
}

.pwf-footer {
  display: flex;
  justify-content: flex-end;
}
</style>

<script setup>
import { computed } from 'vue'
import { NModal, NButton } from 'naive-ui'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// 显示条件：store 里存在失败信息即弹出
const visible = computed(() => !!store.policyWritebackIssue)
const issue = computed(() => store.policyWritebackIssue || {})

// 点右上角关闭 / 蒙层外 → 等同「取消」（不下载，用户可稍后重新点下载）
function onUpdateShow(v) {
  if (!v) store.handlePolicyIssueCancel()
}
</script>
