<!-- ============================================================
     PCP CredentialManager.vue - 账号管理组件
     职责：4 平台账号的增删查选（每平台独立的"当前选中账号"）
     数据流：
       - onMounted 调 api.pcp.credentialList() 拉取全部账密 + 选中关系
       - 添加/选中/清空/删除 → 调 api.pcp.credentialXxx() → 重新 loadCredentials
     ============================================================ -->

<template>
  <div class="credential-manager">
    <!-- 按平台分成 4 组，每组独立选择 -->
    <n-space vertical size="medium" style="width: 100%">
      <n-card
        v-for="group in platformGroups"
        :key="group.platform"
        :bordered="true"
        size="small"
        :class="{ 'pcp-blink-shake': shouldBlinkPlatform(group.platform) }"
      >
        <template #header>
          <n-space align="center">
            <span style="font-weight: 600">{{ group.label }}</span>
            <n-tag v-if="group.currentSelected" type="success" :bordered="false" disabled size="small">
              使用中：{{ group.currentSelected.name }}
              （{{ group.currentSelected.username }}）
            </n-tag>
            <n-tag v-else type="warning" size="small">未选择账号</n-tag>
          </n-space>
        </template>

        <template #header-extra>
          <n-button size="small" :disabled="!group.currentSelected" @click="handleClearSelect(group.platform)">
            清空选择
          </n-button>
        </template>

        <n-empty v-if="group.credentials.length === 0" description="此平台暂无账号" style="padding: 24px 0" />

        <n-data-table
          v-else
          :columns="columns"
          :data="group.credentials"
          :bordered="true"
          size="small"
          :row-props="(row) => ({
            // 选中行浅绿高亮，一眼看出该平台正在用哪条
            style: row.id === group.selectedId ? 'background-color: #eaf5ea' : ''
          })"
        />
      </n-card>
    </n-space>

    <!-- 添加账号弹窗：全部用 Naive UI 原生组件属性实现对齐/冒号/星号
         - colon：label 末尾自动加中文冒号「名称:」
         - show-required-mark=false：去掉必填项左侧红色星号（*）
         - label-placement=left + label-align=left：label 左对齐、与控件同行
         - label-width=72：给「账号」三个字 + 冒号预留稳定宽度，所有 label 左侧对齐 -->
    <n-modal
      v-model:show="showAddModal"
      preset="card"
      title="添加账号"
      style="width: 500px"
      class="credential-add-modal"
    >
      <n-form
        ref="formRef"
        :model="formData"
        :rules="rules"
        label-placement="left"
        label-align="right"
        label-width="auto"
        colon
        :show-required-mark="false"
        style="max-width: 420px; margin: 0 auto"
        @keyup.enter="handleSave"
      >
      <!-- 空格代码是&nbsp; -->
        <n-form-item label="名  &nbsp;称" path="name">
          <n-input v-model:value="formData.name" placeholder="请输入账号名称" />
        </n-form-item>
        <n-form-item label="平  &nbsp;台" path="platform">
          <n-select v-model:value="formData.platform" :options="platformOptions" />
        </n-form-item>
        <n-form-item label="账  &nbsp;号" path="username">
          <n-input v-model:value="formData.username" placeholder="请输入账号" />
        </n-form-item>
        <n-form-item label="密  &nbsp;码" path="password">
          <n-input v-model:value="formData.password" type="password" show-password-on="click" placeholder="请输入密码" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div style="max-width: 420px; margin: 0 auto; display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="showAddModal = false">取消</n-button>
          <n-button type="primary" @click="handleSave">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue'
import {
  NCard, NSpace, NButton, NDataTable, NTag, NEmpty,
  NModal, NForm, NFormItem, NInput, NSelect
} from 'naive-ui'
import message from '@/shared/message.js'
import api from '@/shared/api.js'
import { useTaskStore } from '../stores/task.js'

const store = useTaskStore()

// 阶段3：门禁失败闪烁引导
//   jxgj_credential → 抖动 jxgj 卡片
//   o_credential    → 抖动第一个"未选中账号"的 O 平台卡片（trip→o2→o3 顺序）
//   逻辑：o_credential 表示已启用 O 但都没选中账号，第一个无 selection 的 O 就是用户该去选的
function shouldBlinkPlatform(platform) {
  const t = store.blinkTarget
  if (!t) return false
  if (t === `${platform}_credential`) return true
  if (t === 'o_credential') {
    // 仅 O 平台参与；找到第一个未选中的 O，与当前 platform 匹配
    if (!['trip', 'o2', 'o3'].includes(platform)) return false
    const firstMissingO = ['trip', 'o2', 'o3'].find(p => {
      const g = platformGroups.value.find(x => x.platform === p)
      return g && !g.currentSelected
    })
    return firstMissingO === platform
  }
  return false
}

// ============================================================
// 基础配置：4 个平台（代码 key 用简称，UI 显示用中文名）
//   锦绣国际 JXGJ  /  携程OTA TRIP  /  O2  /  O3
// ============================================================
const PLATFORM_LIST = [
  { platform: 'jxgj', label: '锦绣国际' },
  { platform: 'trip', label: '携程OTA' },
  { platform: 'o2',   label: 'O2 平台' },
  { platform: 'o3',   label: 'O3 平台' }
]

const platformOptions = PLATFORM_LIST.map(p => ({ label: p.label, value: p.platform }))

function platformLabel(platform) {
  return PLATFORM_LIST.find(p => p.platform === platform)?.label || platform
}

// ============================================================
// 状态变量
// ============================================================
const credentials = ref([])
// 各平台选中关系：{ jxgj: id|null, trip: id|null, o2: id|null, o3: id|null }
const selectedMap = ref({})

// 添加账号弹窗
const showAddModal = ref(false)
const formRef = ref(null)
const formData = ref({
  name: '',
  platform: 'jxgj',
  username: '',
  password: '',
  remark: ''
})
const rules = {
  name: { required: true, message: '请输入名称', trigger: 'blur' },
  platform: { required: true, message: '请选择平台', trigger: 'change' },
  username: { required: true, message: '请输入账号', trigger: 'blur' },
  password: { required: true, message: '请输入密码', trigger: 'blur' }
}

// ============================================================
// 对外暴露：让父组件能打开添加弹窗
// ============================================================
function openAddModal() {
  resetForm()
  showAddModal.value = true
}
defineExpose({ openAddModal })

// ============================================================
// 派生数据：按平台分组
// ============================================================
const platformGroups = computed(() => {
  return PLATFORM_LIST.map(({ platform, label }) => {
    const list = credentials.value.filter(c => c.platform === platform)
    const selectedId = selectedMap.value[platform] ?? null
    const currentSelected = selectedId
      ? (credentials.value.find(c => c.id === selectedId) || null)
      : null
    return { platform, label, credentials: list, selectedId, currentSelected }
  })
})

const platformSummary = computed(() => {
  return PLATFORM_LIST.map(({ platform, label }) => {
    const id = selectedMap.value[platform] ?? null
    const c = id ? credentials.value.find(x => x.id === id) : null
    return { platform, label, selectedName: c ? `${c.name}（${c.username}）` : null }
  })
})

// ============================================================
// 表格列定义：名称 / 账号 / 备注 / 状态（可点击切换） / 操作（删除）
// ============================================================
const columns = [
  { title: '名称', key: 'name', width: 150 },
  { title: '账号', key: 'username', width: 150 },
  { title: '备注', key: 'remark', ellipsis: true },
  {
    title: '状态', key: 'selected', width: 120,
    render: (row) => {
      const isSelected = selectedMap.value[row.platform] === row.id
      // 点击状态按钮即对选中状态取反：
      //   未选中 → 调用 handleSelect(row, false) 去选中这条
      //   使用中 → 调用 handleSelect(row, true)  取消选中
      return h(
        NButton,
        {
          size: 'small',
          type: isSelected ? 'success' : 'default',
          dashed: !isSelected,
          onClick: () => handleSelect(row, isSelected)
        },
        { default: () => (isSelected ? '使用中' : '未选中') }
      )
    }
  },
  {
    title: '操作', key: 'actions', width: 80,
    render: (row) => {
      return h(
        NButton,
        {
          size: 'small',
          type: 'error',
          onClick: () => handleDelete(row.id, row.platform)
        },
        { default: () => '删除' }
      )
    }
  }
]

// ============================================================
// 事件：加载 / 添加 / 保存弹窗 / 选中切换 / 删除 / 清空选中
// ============================================================
async function loadCredentials() {
  const result = await api.pcp.credentialList()
  credentials.value = Array.isArray(result.credentials) ? result.credentials : []

  if (result.selectedMap && typeof result.selectedMap === 'object') {
    const normalized = {}
    for (const { platform } of PLATFORM_LIST) {
      normalized[platform] = result.selectedMap[platform] ?? null
    }
    selectedMap.value = normalized
  } else {
    selectedMap.value = PLATFORM_LIST.reduce((acc, p) => ({ ...acc, [p.platform]: null }), {})
  }
}

function resetForm() {
  formData.value = { name: '', platform: 'jxgj', username: '', password: '', remark: '' }
  if (formRef.value) {
    try { formRef.value.restoreValidation && formRef.value.restoreValidation() } catch {}
  }
}

async function handleSave() {
  if (!formData.value.name || !formData.value.username || !formData.value.password) {
    message.warning('请填写必填项')
    return
  }
  // 账密验证：trip 平台会在主进程验证账密，失败返回 { success: false, message }
  //   验证失败不关闭弹窗，让用户修改后重试
  const res = await api.pcp.credentialAdd({ ...formData.value })
  if (res && res.success === false) {
    message.error(res.message || '账号验证失败')
    return
  }
  message.success('添加成功（若该平台此前未选账号，会自动选中这条）')
  showAddModal.value = false
  resetForm()
  await loadCredentials()
}

/**
 * 选中状态取反切换（按平台）：
 *   - isSelected=true  → 取消选中（传 id: null）
 *   - isSelected=false → 选中这条（传 row.id）
 */
async function handleSelect(row, isSelected) {
  const payload = isSelected ? { id: null, platform: row.platform } : { id: row.id, platform: row.platform }
  const res = await api.pcp.credentialSelect(payload)
  if (!res || res.success === false) {
    message.error(res?.message || '操作失败')
    return
  }
  message.success(
    isSelected
      ? `【${platformLabel(row.platform)}】已取消选中`
      : `【${platformLabel(row.platform)}】已切换使用的账号`
  )
  await loadCredentials()
}

async function handleClearSelect(platform) {
  const res = await api.pcp.credentialSelect({ id: null, platform })
  if (!res || res.success === false) {
    message.error(res?.message || '清空失败')
    return
  }
  message.success(`【${platformLabel(platform)}】已清空选中状态`)
  await loadCredentials()
}

async function handleDelete(id, platform) {
  await api.pcp.credentialDelete(id)
  message.success(`【${platformLabel(platform)}】删除成功`)
  await loadCredentials()
}

onMounted(() => {
  loadCredentials()
})
</script>

<style scoped>
.credential-manager {
  width: 100%;
}
</style>
