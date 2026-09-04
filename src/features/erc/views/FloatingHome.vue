<!-- ============================================================
     FloatingHome.vue - 悬浮窗专用紧凑首页
     职责：
       - "换算成人民币"：两个币种行上下排列
           上行 = 源币种输入（"数值+币种代码"如 500krw，自动解析）
           下行 = CNY 结果（可反向输入）
       - "同步换算"：主动/被动币种行竖排，最多 5 行滚动
           输入某行即切主动 + syncPassiveValues 联动其他被动
       - "加币种"：内联展开 addCurrency 网格选择
     复用：useDataStore 数据/逻辑（syncPassiveValues/activeCurrency 等）
     不复用：ToCNY/SingleCurrency 组件（主窗布局，改会影响主窗）
     布局：币种行 = 左币种名 + 右对齐金额 + 三字码（单行紧凑）
     主题：原生 input + 暗色自定义样式，不依赖 naive-ui theme provider
     ============================================================ -->

<template>
  <div class="fh">
    <!-- ============ 换算成人民币 ============ -->
    <section class="fh-sec any-to-cny">
      <div class="fh-sec-title">任意币种转人民币</div>
      <div class="fh-rows">
        <!-- 上行：源币种输入（500krw 自动解析） -->
        <div class="crow">
          <span class="crow-name">{{ srcName }}</span>
          <input class="crow-input" :class="{ 'is-flash': activeFlash === 'src' }" :value="srcRaw" @input="onSrcInput"
            @keydown="onSrcKeydown" @focus="markFlash('src', $event)" placeholder="例：500krw" spellcheck="false" />
          <span v-if="srcPreview" class="crow-preview" :class="{ 'is-error': !srcPreview.valid }">{{ srcPreview.text
            }}</span>
          <span class="crow-code">{{ srcCode }}</span>
        </div>
        <!-- 下行：CNY 结果（可反向输入） -->
        <div class="crow">
          <span class="crow-name">人民币</span>
          <input class="crow-input" :class="{ 'is-flash': activeFlash === 'cny' }" :value="cnyVal" @input="onCnyInput"
            @keydown="onCnyKeydown" @focus="markFlash('cny', $event)" placeholder="0.00" spellcheck="false" />
          <span v-if="cnyPreview" class="crow-preview" :class="{ 'is-error': !cnyPreview.valid }">{{ cnyPreview.text
            }}</span>
          <span class="crow-code">CNY</span>
        </div>
      </div>
    </section>
    <!-- ============ 同步换算 ============ -->
    <section class="fh-sec sync-to">
      <div class="fh-sec-title">
        <span>多币种同步换算</span>
        <button class="fh-add" @click="showPicker = !showPicker">
          {{ showPicker ? '收起' : '加币种' }}
        </button>
      </div>

      <!-- 加币种：内联展开 addCurrency 网格（竖向滚动） -->
      <div v-if="showPicker" class="fh-picker">
        <addCurrency />
      </div>

      <!-- 币种行竖排，最多 5 行滚动 -->
      <div v-else class="fh-sync-list">
        <div v-for="cur in store.activeCurrency" :key="cur.currencies.code" class="crow"
          :class="{ 'is-init': cur.currencies.initiative }">
          <button class="crow-del" title="移除币种" @click="store.removeCurrency(cur)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
              aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
          <span class="crow-name">{{ cur.name }}</span>
          <input class="crow-input" :class="{ 'is-flash': activeFlash === 'row:' + cur.currencies.code }"
            :value="getRowDisplay(cur)" @focus="onRowFocus(cur, $event)" @input="onRowInput(cur, $event)"
            @keydown="onRowKeydown(cur, $event)" @blur="onRowBlur(cur)" spellcheck="false" />
          <span v-if="rowPreviews[cur.currencies.code]" class="crow-preview"
            :class="{ 'is-error': !rowPreviews[cur.currencies.code].valid }">
            {{ rowPreviews[cur.currencies.code].text }}
          </span>
          <span class="crow-code">{{ cur.currencies.code }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue'
import Decimal from 'decimal.js'
import { useDataStore } from '../stores/data.js'
import api from '@/shared/api.js'
import addCurrency from '../components/addCurrency.vue'

const store = useDataStore()

// ==================== 算式计算器（+ - * / 左到右，无优先级） ====================
// 用于悬浮窗所有币种输入框的实时预览：输入含运算符时显示 = 结果或 = ?
// 设计要点：
//   - tokenizer + 左到右逐对归约，每步 Decimal 运算保证金额精度
//   - 校验与执行共享同一 tokenizer 管道（避免"校验过了但执行报错"）
//   - 支持：负数开头（-5+3）、运算符后跟负号（6--1*5 → ((6)-(-1))*5=35）
//   - 不支持：括号、函数、百分比、币种尾巴（1+5美元 属于非法）
// 返回：{ ok: true, value: Decimal } 或 { ok: false }
function tokenize(raw) {
  if (!raw) return null
  const tokens = []
  let i = 0
  const s = raw.trim()
  const numRe = /^-?\d+(?:\.\d+)?/
  // 开头可跟可选 +/-（作为第一个数字的符号）
  if (s[i] === '-' || s[i] === '+') {
    const m = s.slice(i).match(numRe)
    if (!m) return null
    tokens.push(m[0])
    i += m[0].length
  }
  while (i < s.length) {
    const ch = s[i]
    if (/[0-9.]/.test(ch)) {
      const m = s.slice(i).match(numRe)
      if (!m) return null
      tokens.push(m[0])
      i += m[0].length
    } else if (/^[+\-*/]$/.test(ch)) {
      tokens.push(ch)
      i++
      // 运算符后可跟可选 +/-（作为下一个数字的符号）
      if (i < s.length && (s[i] === '-' || s[i] === '+')) {
        const m = s.slice(i).match(numRe)
        if (!m) return null
        tokens.push(m[0])
        i += m[0].length
      }
    } else {
      // 非法字符（币种名、中文、括号等）
      return null
    }
  }
  if (tokens.length === 0) return null
  // 序列校验：偶数位（0,2,4...）必须是数字；奇数位（1,3,5...）必须是运算符
  for (let k = 0; k < tokens.length; k++) {
    const isNum = /^-?\d+(?:\.\d+)?$/.test(tokens[k])
    const isOp = /^[+\-*/]$/.test(tokens[k])
    if (k % 2 === 0 && !isNum) return null
    if (k % 2 === 1 && !isOp) return null
  }
  // 序列长度必须是奇数（数字 运算符 数字 ... 数字）
  if (tokens.length % 2 !== 1) return null
  return tokens
}

function calcExpr(raw) {
  const tokens = tokenize(raw)
  if (!tokens) return { ok: false }
  try {
    // 左到右逐对归约，无优先级
    let acc = new Decimal(tokens[0])
    for (let k = 1; k < tokens.length; k += 2) {
      const op = tokens[k]
      const b = new Decimal(tokens[k + 1])
      if (op === '+') acc = acc.plus(b)
      else if (op === '-') acc = acc.minus(b)
      else if (op === '*') acc = acc.times(b)
      else if (op === '/') {
        if (b.isZero()) return { ok: false } // 除零
        acc = acc.div(b)
      }
    }
    // Decimal.isFinite() 检查非 NaN/Infinity
    if (!acc.isFinite()) return { ok: false }
    return { ok: true, value: acc }
  } catch {
    return { ok: false }
  }
}

// 判断输入是否包含"二元运算符"（只有纯数字/空串时不显示计算预览）
// 注意：开头的 +/- 是数字符号（负数/正数），不是运算符，必须先剥掉再判断，
// 否则纯负数 "-5.00" 会被误判成算式 → 应用结果后预览复活 / 直接输负数误显预览
function hasOperator(raw) {
  const s = (raw ?? '').trim()
  if (!s) return false
  return /[+\-*/]/.test(s.replace(/^[+-]/, ''))
}

// 是否为单个纯数字（含负数、小数），不含任何二元运算符
function isPureNumber(raw) {
  return /^-?\d+(?:\.\d+)?$/.test((raw ?? '').trim())
}

// ==================== 换算成人民币 ====================
// 上行：源币种原始输入（"数值+币种代码"如 500krw）
const srcRaw = ref('')
// 上行币种名/三字码（解析后填充，未解析时占位）
const srcName = ref('源币种')
const srcCode = ref('---')
// 上行币种是否已锁定（首次成功解析后置 true，锁定后仅"纯数字"输入；新币种代码出现才切换）
const srcLocked = ref(false)
// 下行：CNY 金额字符串
const cnyVal = ref('')

// ==================== 算式预览状态 ====================
// srcPreview / cnyPreview：{ text, valid } | null；同步行用 reactive map
const srcPreview = ref(null)
const cnyPreview = ref(null)
const rowPreviews = reactive({}) // key = code, value = { text, valid } | null

// 更新某个输入框的计算预览
function refreshPreview(raw, targetRef) {
  if (!hasOperator(raw)) {
    targetRef.value = null
    return
  }
  const r = calcExpr(raw)
  if (r.ok) {
    targetRef.value = { text: `= ${r.value.toFixed(2)}`, valid: true }
  } else {
    targetRef.value = { text: '= ?', valid: false }
  }
}

// 把算式应用为结果（Enter/= 触发），返回 null 表示无法应用
function applyCalcResult(raw) {
  if (!hasOperator(raw)) return null
  const r = calcExpr(raw)
  if (!r.ok) return null
  return r.value.toFixed(2) // 统一保留 2 位小数
}

// 联动写值：一个框的换算结果"程序化覆盖"另一个框时，被覆盖框的算式预览必须清——
// 因为框里显示的已是联动结果，不再是用户输入的算式，预览失去依据。
// （用户在本框亲自输入走 onXxxInput + refreshPreview，不经这两个 helper）
function setSrcValue(val) {
  srcRaw.value = val
  srcPreview.value = null
}
function setCnyValue(val) {
  cnyVal.value = val
  cnyPreview.value = null
}
// ==================== 币种名解析（共享模块） ====================
import { CN_ALIASES, buildCodeIndex } from '../shared/searchIndex.js'

// 解析"数值+币种标识"。币种标识可以是：三字码、中文名、英文名、简称
// 返回 { amount, code(大写), rawCode }，非法返回 null
function parseSrcInput(input) {
  const raw = (input ?? '').trim()
  if (!raw) return null
  // 先尝试"数值 + 任意非空尾巴"：尾巴可能是字母 code、中文币种名或英文币种名
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(.+)$/)
  if (!match) return null
  const amount = match[1]
  // 金额与币种之间允许分隔符：200/jpy、200 / jpy、200|jpy
  //   注意：200/2 这类"/ 后接数字"的是除法算式，调用方 calcExpr 会先算成功，
  //   不会走到币种解析；只有"/ 后接币种名"（算式非法）时才靠这里兜底识别。
  const tail = match[2].trim().replace(/^[\/\\|\s]+/, '')
  if (!tail) return null

  const idx = buildCodeIndex(store.currencies_list)
  // 精确匹配优先（code 或完整中文名）
  if (idx[tail]) {
    const code = idx[tail]
    return { amount, code, rawCode: tail }
  }
  // 包含匹配：如果尾巴是 "美"、"欧"、"日" 这种单字简称，做最长匹配
  // 按长度降序遍历所有 key，匹配 tail 开头的 key
  const sortedKeys = Object.keys(idx).sort((a, b) => b.length - a.length)
  for (const k of sortedKeys) {
    if (tail.startsWith(k)) {
      return { amount, code: idx[k], rawCode: tail }
    }
  }
  return null
}

// 查源币种与 CNY 的 rate（rate = 1USD 兑该币种数量）
function findCurrencies(code) {
  const src = store.currencies_list.find(
    i => i.currencies.code.toUpperCase() === code
  )
  const cny = store.currencies_list.find(
    i => i.currencies.code.toUpperCase() === 'CNY'
  )
  if (!src || !cny) return null
  const srcRate = src.currencies.rate
  const cnyRate = cny.currencies.rate
  if (!srcRate || !cnyRate) return null
  return { src, cny, srcRate, cnyRate }
}

// 闪烁单选状态：全局只有一个输入框保持青色呼吸闪烁。
//   focus 某个输入框 → 登记它的 key（'src' / 'cny' / 'row:<code>'）并全选内容；
//   blur【不清除】——焦点离开到空白处/按钮上时，最后聚焦的输入框继续闪烁；
//   只有点到【另一个输入框】触发新 focus 覆盖 key，旧的闪烁才取消。
const activeFlash = ref('')
function markFlash(key, e) {
  activeFlash.value = key
  if (e && e.target) e.target.select()
}

// 有效币种解析结果 → 切换锁定 + 换算 CNY（"500usd" 与 "200/jpy" 两种格式共用）
function applyParsedSrc(parsed, r) {
  const switched = !srcLocked.value || srcCode.value !== r.src.currencies.code
  if (switched) {
    srcLocked.value = true
    srcName.value = r.src.name
    srcCode.value = r.src.currencies.code
  }
  try {
    setCnyValue(new Decimal(parsed.amount).times(r.cnyRate).div(r.srcRate).toFixed(2))
  } catch {
    setCnyValue('')
  }
}

// 上行输入：
//   - 空 → 只清空金额（下行）；币种锁定状态【保持不变】
//   - 币种切换的唯一时机：输入了新的有效币种（500usd / 200/jpy / 300日元）将其覆盖：
//       · 有效币种 ≠ 当前锁定 → 切换锁定
//       · 有效币种 = 当前锁定 → 只更新数值（保持锁定）
//       · 未知币种 → 非锁定态显示"未知"；锁定态忽略（不覆盖）
//   - 纯数字 → 锁定态下只更新数值部分；非锁定态不处理
//   - 含运算符 → 实时计算预览（Enter/= 应用结果）；
//     算式非法但形如"金额/币种"时按币种识别（/ 后接名字而非数字）
function onSrcInput(e) {
  srcRaw.value = e.target.value
  const raw = srcRaw.value.trim()
  if (!raw) {
    // 清空金额：币种锁定/名称/代码全部保持不动——
    // 已锁定 USD 时清空，币种仍是 USD；初始未锁定态本来就是"源币种 ---"。
    setCnyValue('') // 清空下行，连带清下行算式预览
    refreshPreview(raw, srcPreview)
    return
  }

  // 含运算符：优先按算式处理（计算优先于币种识别）
  if (hasOperator(raw)) {
    const expr = calcExpr(raw)
    if (expr.ok) {
      refreshPreview(raw, srcPreview) // 合法算式 → 显示 = 结果
      return
    }
    // 算式非法：但可能是"金额/币种"格式（/ 后接币种名而非数字，如 200/jpy）
    const slashParsed = parseSrcInput(raw)
    const slashR = slashParsed ? findCurrencies(slashParsed.code) : null
    if (slashParsed && slashR) {
      srcPreview.value = null // 是币种输入而非算式 → 不出预览
      applyParsedSrc(slashParsed, slashR)
      return
    }
    refreshPreview(raw, srcPreview) // 确实算不出 → 显示 = ?
    return
  }
  refreshPreview(raw, srcPreview) // 纯数字不含运算符 → 清预览

  const parsed = parseSrcInput(raw)
  if (!parsed) {
    // 无币种代码：锁定态下只接受纯数字（含负数，单独改数值部分），其他格式忽略
    if (srcLocked.value && isPureNumber(raw)) {
      updateCnyWithAmount(raw)
    }
    return
  }

  // 有币种代码 → 查有效性
  const r = findCurrencies(parsed.code)
  if (!r) {
    // 未知币种：只有非锁定态才切到"未知"
    if (!srcLocked.value) {
      srcName.value = '未知币种'
      srcCode.value = parsed.rawCode.toUpperCase()
      setCnyValue('') // 下行清空，连带清下行算式预览
    }
    return
  }

  // 有效币种 → 切换锁定 + 更新显示
  applyParsedSrc(parsed, r)
}

// 上行 Enter/=：把算式应用为结果。锁定态下直接替换 srcRaw 数值；
// 非锁定态替换后走正常解析（如果不含币种尾巴，锁定态不会被解除）。
function onSrcKeydown(e) {
  if (e.key !== 'Enter' && e.key !== '=') return
  e.preventDefault()
  const raw = (e.target.value ?? '').trim()
  const result = applyCalcResult(raw)
  if (result == null) return
  setSrcValue(result) // 写回上行 + 清上行预览
  // 应用后走正常 onSrcInput 链路（但 @input 不会自动触发，手动调一次）
  // 锁定态 + 纯数字（含负数结果）→ 直接换算 CNY；否则走完整解析
  srcLocked.value && isPureNumber(result)
    ? updateCnyWithAmount(result)
    : onSrcInput({ target: { value: result } })
}

// 锁定态下纯数字输入时，用已锁定币种算 CNY
function updateCnyWithAmount(amountStr) {
  const r = findCurrencies(srcCode.value)
  if (!r) return
  try {
    setCnyValue(new Decimal(amountStr).times(r.cnyRate).div(r.srcRate).toFixed(2))
  } catch {
    setCnyValue('')
  }
}

// 下行输入：反向算源币种（只替换数值，币种代码跟随已锁定的 srcCode）
// 同样支持算式预览 + Enter/= 应用
function onCnyInput(e) {
  cnyVal.value = e.target.value
  const raw = (cnyVal.value ?? '').trim()
  refreshPreview(raw, cnyPreview)
  if (!raw) return
  // 含运算符：预览已更新，跳过数字校验直接返回
  if (hasOperator(raw)) return
  if (!isPureNumber(raw)) return
  // 锁定态用 srcCode；非锁定态用当前 srcRaw 里解析的 code
  const effectiveCode = srcLocked.value ? srcCode.value : (parseSrcInput(srcRaw.value)?.code ?? srcCode.value)
  const r = findCurrencies(effectiveCode)
  if (!r) return
  try {
    const srcAmount = new Decimal(raw).times(r.srcRate).div(r.cnyRate)
    // 锁定态：只回填纯数值（保持"锁定后只输数字"的契约）
    // 非锁定态：回填"数值+code"（用户能看到当前币种）
    // setSrcValue 会连带清掉上行的算式预览（上行已被反算结果覆盖）
    setSrcValue(srcLocked.value
      ? srcAmount.toFixed(2)
      : `${srcAmount.toFixed(2)}${effectiveCode}`)
  } catch {
    // 反算失败不回填
  }
}

// 下行 Enter/=：把算式应用为 CNY 金额，走正常反向算源币种
function onCnyKeydown(e) {
  if (e.key !== 'Enter' && e.key !== '=') return
  e.preventDefault()
  const raw = (e.target.value ?? '').trim()
  const result = applyCalcResult(raw)
  if (result == null) return
  setCnyValue(result) // 写回下行 + 清下行预览
  onCnyInput({ target: { value: result } })
}

// ==================== 同步换算 ====================
// 加币种选择面板展开状态
const showPicker = ref(false)
// 当前正在编辑的币种 code（避免被动刷新覆盖正在编辑的输入框）
let editingCode = null
// 正在编辑的行的用户原始输入值（key = code，用户聚焦输入时缓存，失焦时清空）
// 用户聚焦期间：input :value 显示此缓存值，完全由用户掌控，不被 toFixed 打断
const editingBuffer = ref({})

// 行显示值：正在编辑的行显示用户原始输入；其他行显示 toFixed(2)
function getRowDisplay(cur) {
  const code = cur.currencies.code
  if (editingBuffer.value[code] != null) {
    return editingBuffer.value[code]
  }
  const v = cur.currencies.value ?? 0
  return Number(v).toFixed(2)
}

// 行获得焦点：切为主动 + 存 editingBuffer
function onRowFocus(cur, e) {
  activeFlash.value = 'row:' + cur.currencies.code // 登记闪烁单选（blur 不取消，点别的输入框才切换）
  editingCode = cur.currencies.code
  becomeInitiative(cur)
  // 聚焦后本行显示 editingBuffer（初始为当前值的 toFixed 字符串），与 Vue 渲染同步
  editingBuffer.value[cur.currencies.code] = getRowDisplay(cur)
  nextTick(() => {
    if (e && e.target) e.target.select()
  })
}

// 行输入：更新 editingBuffer + 写 store + 同步其他被动
function onRowInput(cur, e) {
  const raw = (e.target.value ?? '').trim()
  const code = cur.currencies.code
  // 任何输入都先缓存——让输入框完全由用户掌控
  editingBuffer.value[code] = raw
  becomeInitiative(cur)

  // 计算预览（同步行用 rowPreviews reactive map）
  if (hasOperator(raw)) {
    const r = calcExpr(raw)
    rowPreviews[code] = r.ok ? { text: `= ${r.value.toFixed(2)}`, valid: true } : { text: '= ?', valid: false }
  } else {
    delete rowPreviews[code]
  }

  if (!raw) {
    cur.currencies.value = 0
    store.syncPassiveValues()
    return
  }
  if (/^-?\d+\.?\d*$/.test(raw)) {
    cur.currencies.value = Number(raw)
    store.syncPassiveValues()
  }
}

// 同步行 Enter/=：把算式应用为结果（更新 editingBuffer + store 联动）
function onRowKeydown(cur, e) {
  if (e.key !== 'Enter' && e.key !== '=') return
  e.preventDefault()
  const raw = (e.target.value ?? '').trim()
  const result = applyCalcResult(raw)
  if (result == null) return
  const num = Number(result)
  cur.currencies.value = num
  editingBuffer.value[cur.currencies.code] = result // 让 getRowDisplay 显示结果
  delete rowPreviews[cur.currencies.code] // 应用结果后预览消失
  store.syncPassiveValues()
}

// 行失焦：清 editingBuffer，恢复 toFixed(2) 显示；同时清掉未应用的算式预览
function onRowBlur(cur) {
  editingCode = null
  delete editingBuffer.value[cur.currencies.code]
  delete rowPreviews[cur.currencies.code]
}

// 设为主动：清零其他 initiative，置当前为主动
function becomeInitiative(cur) {
  if (cur.currencies.initiative) return
  store.activeCurrency.forEach(item => {
    item.currencies.initiative = false
  })
  cur.currencies.initiative = true
}

// ==================== 初始化 ====================
// 复用 Home 的初始化逻辑：拉数据 + 种入默认 CNY/USD（store 有 guard，重复调用幂等）
onMounted(async () => {
  const today = new Date().toISOString().substring(0, 10)
  if (store.currencies_list.length === 0) {
    await store.load_all_countries_list()
  }
  if (store.syncDate !== today) {
    await store.updata_exchangeRates()
  }
  store.seedDefaultCurrencies()
  // 订阅主进程定时刷新推送（30 分钟一次）
  // 主进程单点调度，渲染层只接收，无需本地 setInterval
  api.erc.onRateUpdated((res) => {
    store.applyRateUpdate(res)
  })
})
</script>

<style scoped>
/* 壳：纵向栈，紧凑间距 */
.fh {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 6px;
  color: #fff;
  font-size: 12px;
}

.any-to-cny {}

.sync-to {
  margin-top: 2px;
  flex: 1;
  /* flex column 子项默认 min-height: auto，会被内容撑开突破父容器，
     导致内部 .fh-picker / .fh-sync-list 的 overflow 无法触发。
     显式置 0 允许它收缩到内容以下，子项滚动才能生效。 */
  min-height: 0;
}

/* 区块 */
.fh-sec {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 渐变背景短一些 */
  background: linear-gradient(to right, 9px 0px, rgba(99, 226, 183, 0.85), rgba(255, 255, 255, 0.08));
}

.fh-sec-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.62);
  letter-spacing: 0.04em;
  user-select: none;
}

.duo-section {
  /* border: 1px solid rgba(255, 255, 255, 0.12); */
  margin-top: 2px;
}

.fh-add {

  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.85);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.fh-add:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

/* 行容器 */
.fh-rows,
.fh-sync-list {
  border-left: 4px solid rgba(45, 117, 93, 0.85);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* fh-picker / fh-sync-list：占满 .sync-to 剩余高度，内容超出时内部滚动。
   flex:1 拉伸填满；min-height:0 允许收缩到内容以下以触发 overflow；overflow-y:auto 出现滚动条。 */
.fh-sync-list,
.fh-picker {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* 加币种选择面板：保留视觉边框。
   --currency-list-max-h: none 解除 addCurrency 内部 .currency-list 的 240px/150px 默认上限，
   让列表按内容自然展开 → 撑出 .fh-picker 边界 → 由 .fh-picker 的 overflow-y:auto 统一滚动。
   这样搜索框固定在顶部不动，列表整体在 .fh-picker 内滚（避免双滚动条）。 */
.fh-picker {
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  --currency-list-max-h: none;
}

/* 币种行：左删除 + 币种名 + 右对齐金额 + 三字码（单行紧凑） */
.crow {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  /* flex column 容器内子项默认 flex-shrink:1 会被压缩——
     行多时高度被挤压变形。置 0 锁定 30px 不变，超出由 .fh-sync-list 滚动。 */
  flex-shrink: 0;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  border-left: 0px;
  /* 设置左边没有圆角 */
  border-top-left-radius: 0px;
  border-bottom-left-radius: 0px;
  box-sizing: border-box;
  transition: background 0.12s, border-color 0.12s;
}

/* 主动币种（换算锚点）：仅保留左侧 2px 青绿锚点条。
   不使用整块青绿背景/青绿边框——那套"选中卡"视觉只属于加币种列表
   （.currency-item.is-selected），避免选中态观感"透传"到同步换算列表。
   正在编辑哪一行由输入框 :focus 的青色呼吸闪烁表达，背景/边框维持默认灰白。 */
.crow.is-init {
  /* border-left: 2px solid rgba(99, 226, 183, 0.85); */
  padding-left: 7px;
  background: transparent;
  border: 1px solid rgba(45, 117, 93, 0.85);
  border-left: 0px solid rgba(45, 117, 93, 0.95);

}

/* 删除按钮：默认半透明，hover 提亮变红 */
.crow-del {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.35);
  cursor: pointer;
  border-radius: 3px;
  transition: color 0.12s, background 0.12s;
}

.crow-del:hover {
  color: rgba(255, 90, 90, 0.95);
  background: rgba(255, 90, 90, 0.12);
}

.crow-del svg {
  width: 10px;
  height: 10px;
  display: block;
  pointer-events: none;
}

.crow-name {
  flex: 0 0 auto;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 70px;
  user-select: none;
}

.crow-input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: #39ff14;
  font-size: 12px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 4px rgba(57, 255, 20, 0.35);
}

.crow-input::placeholder {
  color: rgba(255, 255, 255, 0.3);
}

.crow-code {
  flex: 0 0 auto;
  font-size: 10px;
  color: #39ff14;
  letter-spacing: 0.04em;
  user-select: none;
}

/* 算式计算预览：放在 input 和 crow-code 之间
   flex-shrink:0 → 容器宽度随内容自适应，出现时自然把算式往左顶开，不被挤压
   颜色选 rgba(180, 220, 255, 0.65) —— 偏青偏蓝，比纯白浅但在深灰背景上清晰可见
   text-decoration 用 dotted 虚线下划线，营造"提示/预览"语义 */
.crow-preview {
  flex: 0 0 auto;
  font-size: 11px;
  color: rgba(180, 220, 255, 0.65);
  user-select: none;
  white-space: nowrap;
  text-decoration: underline dotted rgba(180, 220, 255, 0.4);
  text-underline-offset: 2px;
  margin-left: 2px;
  margin-right: 2px;
}

.crow-preview.is-error {
  color: rgba(255, 120, 120, 0.8);
  text-decoration-color: rgba(255, 120, 120, 0.5);
}

/* 选中的输入框：荧光「亮度高低」呼吸闪烁（青色 + 0.8s ease-in-out，
   亮度随文字颜色 + 荧光光晕同步起伏，节奏加快仍柔和）。
   闪烁为单选状态（.is-flash 由 activeFlash 驱动）：blur 不停止，
   只有聚焦到另一个输入框时旧的才取消。 */
.crow-input.is-flash {
  animation: fh-flash 0.8s ease-in-out infinite;
}

@keyframes fh-flash {

  0%,
  100% {
    color: #00ffff;
    text-shadow: 0 0 8px rgba(0, 255, 255, 0.8);
  }

  50% {
    color: rgba(0, 255, 255, 0.35);
    text-shadow: none;
  }
}

/* 滚动条暗色（4px 宽，半透明 thumb，透明 track——与 .currency-list / .floating-content 统一） */
.fh-sync-list::-webkit-scrollbar,
.fh-picker::-webkit-scrollbar {
  width: 4px;
}

.fh-sync-list::-webkit-scrollbar-thumb,
.fh-picker::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

.fh-sync-list::-webkit-scrollbar-track,
.fh-picker::-webkit-scrollbar-track {
  background: transparent;
}
</style>
