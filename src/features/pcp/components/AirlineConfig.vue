<!-- ============================================================
     PCP AirlineConfig.vue - 航司私有配置组件（航司私有化重构）
     职责：
       - 左栏：竖排航司列表（二字码）+「＋ 添加」按钮
       - 右栏：当前选中航司的「平台配置 + 政策字段配置」竖向表单（可滚动）
       - 右下角：固定「保存」按钮；「删除航司」在右栏底部（点击弹框确认）
     数据流：
       - onMounted 调 configListAirlines() 拉全部航司 + schema + vars
       - 选中航司 → 本地 form 副本编辑 → 保存 configSaveAirline(code, {platform, policyFields})
       - 上传航线文件后（store.routesInfo.hangsi）自动物化并选中该航司
     ============================================================ -->

<template>
  <div class="airline-config">
    <n-alert
      v-if="disabled"
      type="warning"
      show-icon
      class="ac-lock"
      title="步骤流进行中，航司配置已锁定"
    >
      完成或终止锦绣国际 / OTA / 合并阶段后才可修改。
    </n-alert>

    <div class="ac-body">
      <!-- 左栏：航司列表 + 添加 -->
      <div class="ac-side">
        <div class="ac-side-title">航司</div>
        <div class="ac-side-list">
          <div
            v-for="a in airlines"
            :key="a.code"
            class="ac-side-item"
            :class="{ 'ac-side-item--active': a.code === activeCode }"
            @click="select(a.code)"
          >{{ a.code }}</div>
          <n-empty v-if="airlines.length === 0" description="暂无航司" class="ac-side-empty" />
        </div>
        <n-button class="ac-add" size="small" dashed :disabled="disabled" @click="openAdd">＋ 添加</n-button>
      </div>

      <!-- 右栏：表单 + 操作 -->
      <div class="ac-main">
        <n-empty v-if="!activeCode" description="请在左侧选择航司，或点击「＋ 添加」" style="margin: auto" />

        <template v-else>
          <div class="ac-scroll">
            <!-- 平台配置（按平台分组） -->
            <div class="ac-section-title">平台配置</div>
            <div v-for="pk in platformKeys" :key="pk" class="ac-group">
              <div class="ac-group-title">{{ platformLabel(pk) }}</div>
              <div v-for="f in fieldsOf(pk)" :key="f.key" class="ac-row">
                <label class="ac-label" :title="f.key">{{ f.label }}</label>
                <n-switch
                  v-if="f.type === 'boolean'"
                  v-model:value="form.platform[pk][f.key]"
                  :disabled="disabled"
                  class="ac-switch"
                />
                <n-input-number
                  v-else-if="f.type === 'number'"
                  v-model:value="form.platform[pk][f.key]"
                  :disabled="disabled"
                  class="ac-input"
                />
                <n-select
                  v-else-if="f.type === 'select'"
                  v-model:value="form.platform[pk][f.key]"
                  :options="selectOptions(f)"
                  :disabled="disabled"
                  class="ac-input"
                />
                <RangePricing
                  v-else-if="f.type === 'PriceRange'"
                  v-model="form.platform[pk][f.key]"
                  :disabled="disabled"
                />
                <n-input
                  v-else
                  v-model:value="form.platform[pk][f.key]"
                  :placeholder="f.help ? f.help : ''"
                  :disabled="disabled"
                  class="ac-input"
                />
                <span v-if="f.help && f.type !== 'string' && f.type !== 'formula'" class="ac-help">{{ f.help }}</span>
              </div>
            </div>

            <!-- 政策字段配置 -->
            <div class="ac-section-title">政策字段配置</div>
            <div v-for="f in policyFieldsSchema" :key="f.key" class="ac-row">
              <label class="ac-label" :title="f.key">{{ f.label }}</label>
              <n-switch
                v-if="f.type === 'switch'"
                v-model:value="form.policyFields[f.key]"
                :disabled="disabled"
                class="ac-switch"
              />
              <n-input
                v-else
                v-model:value="form.policyFields[f.key]"
                :placeholder="`默认：${f.default ?? ''}`"
                :disabled="disabled"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 3 }"
                class="ac-input"
              />
            </div>

            <!-- 可用变量参考 -->
            <template v-if="vars.length">
              <div class="ac-section-title">可用变量（点击复制）</div>
              <div class="ac-vars">
                <div
                  v-for="v in vars"
                  :key="v.name"
                  class="ac-var"
                  :title="`点击复制 \${${v.name}}`"
                  @click="copyVar(v.name)"
                >
                  <code class="ac-var-name">{{ '${' + v.name + '}' }}</code>
                  <span class="ac-var-desc">{{ v.desc }}</span>
                </div>
              </div>
            </template>
          </div>

          <!-- 底部操作：删除居左、保存居右（右下角固定） -->
          <div class="ac-actions">
            <n-button size="small" type="error" quaternary :disabled="disabled || saving" @click="handleDelete">
              删除航司
            </n-button>
            <div class="ac-actions-spacer"></div>
            <n-button type="primary" :disabled="disabled || saving" :loading="saving" @click="handleSave">保存</n-button>
          </div>
        </template>
      </div>
    </div>

    <!-- 添加航司弹窗 -->
    <n-modal v-model:show="showAdd" preset="card" title="添加航司" style="width: 420px">
      <n-form label-placement="left" label-width="72" :show-required-mark="false" @keyup.enter="confirmAdd">
        <n-form-item label="二字码">
          <n-input
            v-model:value="newCode"
            placeholder="航司二字码，如 FA / XQ"
            :disabled="disabled"
          />
        </n-form-item>
      </n-form>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="showAdd = false">取消</n-button>
          <n-button type="primary" :disabled="disabled || saving" @click="confirmAdd">确定</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { NAlert, NButton, NInput, NInputNumber, NSwitch, NSelect, NEmpty, NModal, NForm, NFormItem } from 'naive-ui'
import RangePricing from './RangePricing.vue'
import message from '@/shared/message.js'
import dialog from '@/shared/dialog.js'
import api from '@/shared/api.js'
import { useTaskStore } from '../stores/task.js'

const props = defineProps({
  // 父组件(ConfigPanel)按 pipelineInProgress 透传：进行中 true=禁用
  disabled: { type: Boolean, default: false }
})

const store = useTaskStore()

const PLATFORM_LABELS = { jxgj: '锦绣国际', trip: '携程OTA', reserved: '预留拓展位' }

const airlines = ref([])
const platformSchema = ref({})
const policyFieldsSchema = ref([])
const vars = ref([])
const activeCode = ref('')
const form = ref({ platform: {}, policyFields: {} })
const saving = ref(false)
const showAdd = ref(false)
const newCode = ref('')

const platformKeys = computed(() => Object.keys(platformSchema.value))

function deepClone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o))
}

function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase()
}

function platformLabel(pk) {
  return PLATFORM_LABELS[pk] || pk
}

function fieldsOf(pk) {
  const s = platformSchema.value[pk] || {}
  return Object.keys(s).map(key => ({ key, ...s[key] }))
}

function selectOptions(f) {
  const opts = Array.isArray(f.options) ? f.options : []
  return opts.map(o => (typeof o === 'object' && o !== null ? { ...o } : { label: String(o), value: o }))
}

async function load() {
  const res = await api.pcp.configListAirlines()
  airlines.value = res?.airlines || []
  platformSchema.value = res?.schema?.platform || {}
  policyFieldsSchema.value = res?.schema?.policyFields || []
  vars.value = res?.vars || []

  // 选中优先级：当前上传文件的航司 > 保持上次选中 > 第一个
  const fileCode = normalizeCode(store.routesInfo?.hangsi)
  if (fileCode && airlines.value.some(a => a.code === fileCode)) {
    select(fileCode)
  } else if (activeCode.value && airlines.value.some(a => a.code === activeCode.value)) {
    select(activeCode.value)
  } else if (airlines.value.length) {
    select(airlines.value[0].code)
  } else {
    activeCode.value = ''
    form.value = { platform: {}, policyFields: {} }
  }
}

function select(code) {
  activeCode.value = code
  const a = airlines.value.find(x => x.code === code)
  form.value = {
    platform: a ? deepClone(a.platform || {}) : {},
    policyFields: a ? deepClone(a.policyFields || {}) : {}
  }
}

function openAdd() {
  if (props.disabled) {
    message.warning('步骤流进行中，航司配置已锁定；请完成或终止后再添加')
    return
  }
  newCode.value = ''
  showAdd.value = true
}

async function confirmAdd() {
  if (props.disabled) return
  const code = normalizeCode(newCode.value)
  if (!code) {
    message.warning('请输入航司二字码')
    return
  }
  const res = await api.pcp.configAddAirline(code)
  if (res && res.code) {
    showAdd.value = false
    await load()
    select(res.code)
    message.success(res.created ? `已新增航司 ${res.code}` : `航司 ${res.code} 已存在`)
  }
}

async function handleSave() {
  if (props.disabled) {
    message.warning('步骤流进行中，禁止保存航司配置')
    return
  }
  if (!activeCode.value) {
    message.warning('请先选择航司')
    return
  }
  saving.value = true
  try {
    // ★ 深拷贝净化：form.value.platform/policyFields 是 Vue 响应式 Proxy，
    //   ipcRenderer.invoke 的结构化克隆会拒绝 Proxy → 报「An object could not be cloned」。
    //   JSON 往返一次得到纯对象，且配置本身只有基础类型/数组/Plain Object，可安全序列化。
    const res = await api.pcp.configSaveAirline(activeCode.value, {
      platform: deepClone(form.value.platform),
      policyFields: deepClone(form.value.policyFields)
    })
    await load()
    if (res?.code) select(res.code)
    message.success(`航司 ${res?.code || activeCode.value} 配置已保存`)
  } catch (e) {
    message.error('保存失败：' + (e?.message || e))
  } finally {
    saving.value = false
  }
}

async function handleDelete() {
  if (props.disabled) {
    message.warning('步骤流进行中，禁止删除航司配置')
    return
  }
  if (!activeCode.value) return
  const ok = await dialog.confirm({
    title: '删除航司配置',
    content: `确定删除航司「${activeCode.value}」的私有配置吗？删除后不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    type: 'warning'
  })
  if (!ok) return
  const res = await api.pcp.configDeleteAirline(activeCode.value)
  if (res && res.success) {
    message.success(`已删除航司 ${activeCode.value}`)
    await load()
  } else {
    message.error((res && res.error) || '删除失败')
  }
}

async function copyVar(name) {
  const text = '${' + name + '}'
  try {
    await navigator.clipboard.writeText(text)
    message.success(`已复制 ${text}`)
  } catch (e) {
    message.error('复制失败：' + (e?.message || e))
  }
}

onMounted(load)

// 上传航线文件后（store.routesInfo.hangsi 变化）→ 重载列表并选中该航司（即使本 tab 已激活也生效）
watch(() => store.routesInfo?.hangsi, (nv, ov) => {
  if (nv && nv !== ov) load()
})
</script>

<style scoped>
.airline-config {
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ac-lock { flex-shrink: 0; }
.ac-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

/* 左栏：航司列表 */
.ac-side {
  flex: 0 0 150px;
  display: flex;
  flex-direction: column;
  border: 1px solid #e5e5e5;
  border-radius: 4px;
  background: #fafafa;
  padding: 8px;
}
.ac-side-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin-bottom: 8px;
  padding-left: 2px;
}
.ac-side-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ac-side-empty { margin: auto; }
.ac-side-item {
  padding: 6px 10px;
  font-size: 13px;
  color: #333;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.ac-side-item:hover { background: #f0f0f0; }
.ac-side-item--active {
  background: #e8f3ff;
  color: #2080f0;
  font-weight: 600;
}
.ac-add { margin-top: 8px; }

/* 右栏：表单区 + 底部操作 */
.ac-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #e5e5e5;
  border-radius: 4px;
  overflow: hidden;
}
.ac-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ac-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin: 8px 0 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid #eee;
}
.ac-group { display: flex; flex-direction: column; gap: 8px; }
.ac-group-title {
  font-size: 12.5px;
  color: #666;
  font-weight: 600;
  margin-left: 2px;
}
.ac-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}
.ac-label {
  width: 170px;
  flex-shrink: 0;
  font-size: 13px;
  color: #333;
  line-height: 32px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac-input { flex: 1; min-width: 200px; }
.ac-switch { margin-top: 6px; }
.ac-help {
  flex-basis: 100%;
  font-size: 12px;
  color: #999;
  line-height: 1.5;
  padding-left: 178px;
}

/* 变量参考 */
.ac-vars { display: flex; flex-direction: column; gap: 4px; }
.ac-var {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  cursor: pointer;
  border-bottom: 1px dashed #eee;
}
.ac-var:last-child { border-bottom: none; }
.ac-var:hover { background: #f6f8fa; }
.ac-var-name {
  font-size: 12px;
  color: #0a7;
  background: #eef7f3;
  padding: 1px 4px;
  border-radius: 2px;
  flex-shrink: 0;
}
.ac-var-desc { font-size: 12px; color: #888; }

/* 底部操作：删除居左、保存居右 */
.ac-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid #eee;
  background: #fff;
}
.ac-actions-spacer { flex: 1; }
</style>