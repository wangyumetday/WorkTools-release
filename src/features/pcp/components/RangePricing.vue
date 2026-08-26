<!-- ============================================================
     PCP RangePricing.vue - 区间底价配置组件（最终版，自写区间选择，不再用 n-cascader）
     自己手写的两级区间选择（完全可控，不依赖 naive-ui cascader 的内部黑盒实现）
       - 触发按钮：显示 "L → R" 或 "选择区间" / 清空按钮
       - 左列：整百 100..2900（步长100）；右列：99 结尾 199..2999（步长100）
         同一索引即自然配对 [L, L+99] → 相邻区间 [100,199]/[200,299] 天然不重合
       - 强制 右界 > 左界（左 ≥ 已选右界 / 右 ≤ 已选左界 的点击被忽略）
       - 其余需求：is_done 空行保证 / 删除按钮 / 公式校验 / 输出二维数组同前
     ============================================================ -->
<template>
  <div class="rp" :class="{ 'rp--disabled': disabled }">
    <div v-for="(row, i) in rows" :key="row._id" class="rp-row">
      <!-- 左：公式（实时校验，失败标红 + 红字提示） -->
      <div class="rp-f-wrap">
        <n-input
          v-model:value="row.formula"
          placeholder="区间底价公式，例：cost * 1.1 + 50"
          :status="row._ferr ? 'error' : undefined"
          :disabled="disabled"
          clearable
          @update:value="onFormula(i, $event)"
        />
        <div v-if="row._ferr" class="rp-f-err">{{ row._ferr }}</div>
      </div>

      <!-- 中：自写区间选择器（触发按钮 + 独立遮罩面板） -->
      <div class="rp-rng">
        <!-- 触发按钮（点击开/关面板，避免事件冒泡影响其他） -->
        <div
          class="rp-rng-trigger"
          :class="{ 'rp-rng-sel': !!row.val, 'rp-rng-disabled': disabled }"
          @click.stop="!disabled && (row._open = !row._open)"
        >
          <span class="rp-rng-placeholder" v-if="!row.val">{{ disabled ? '（已锁定）' : '选择区间' }}</span>
          <span v-else>{{ row.val[0] }} → {{ row.val[1] }}</span>
          <!-- 清空按钮（仅已选择时显示） -->
          <button
            v-if="row.val && !disabled" type="button" class="rp-rng-clear"
            title="清空区间"
            @click.stop.prevent="clearRange(i)"
          >×</button>
        </div>
      </div>

      <!-- 遮罩 + 弹出面板（fixed 全屏居中，独立 DOM 层，不受外层父容器 overflow/position 影响） -->
      <Teleport to="body" :disabled="!row._open">
        <div v-if="row._open" class="rp-mask" @mousedown.self="() => { row._open = false }">
          <div
            class="rp-rng-panel"
            @click.stop
          >
            <!-- 左列：整百 100..2900（与右列等长 → scrollTop 同步后同一索引自然配对 L→L+99） -->
            <div
              class="rp-rng-col"
              :ref="(el) => setColRef(i, 'L', el)"
              @scroll="onScroll(i, 'L')"
            >
              <div
                v-for="V in LEFT_LIST" :key="`L-${i}-${V}`"
                class="rp-rng-opt"
                :class="{
                  'rp-rng-opt--hover': row._hoverL === V,
                  'rp-rng-opt--sel': Array.isArray(row.val) && row.val[0] === V
                }"
                @mouseenter="row._hoverL = V"
                @mouseleave="row._hoverL = null"
                @click.stop="pickL(i, V)"
              >{{ V }}</div>
            </div>
            <!-- 右列：99 结尾 199..2999（同一索引 = 左列值 + 99，天然不重合） -->
            <div
              class="rp-rng-col"
              :ref="(el) => setColRef(i, 'R', el)"
              @scroll="onScroll(i, 'R')"
            >
              <div
                v-for="V in RIGHT_LIST" :key="`R-${i}-${V}`"
                class="rp-rng-opt rp-rng-opt--right"
                :class="{
                  'rp-rng-opt--sel': Array.isArray(row.val) && row.val[1] === V
                }"
                @click.stop="pickR(i, V)"
              >{{ V }}</div>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 右：删除（最后一行禁用，避免删光；进行中整体禁用） -->
      <n-button
        text type="error" size="small" class="rp-del"
        :disabled="disabled || rows.length <= 1"
        :title="disabled ? '步骤流进行中，已锁定' : (rows.length <= 1 ? '最后一行保留，清空内容即可' : '删除此行')"
        @click="removeRow(i)"
      >删除</n-button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { NInput, NButton } from 'naive-ui'

// =============== 常量（一次性构造，永不变）===============
const STEP = 100
const L_MIN = 100
const L_MAX = 2900
// 左列：整百 100..2900（29 项）；右列：99 结尾 199..2999（29 项）
// 同一索引即自然配对 [L, L+99]：相邻区间 [100,199]/[200,299] 边界不重合，闭开区间无需纠结
const LEFT_LIST = Object.freeze(
  Array.from({ length: Math.floor((L_MAX - L_MIN) / STEP) + 1 }, (_, k) => L_MIN + k * STEP)
)
const RIGHT_LIST = Object.freeze(LEFT_LIST.map(v => v + 99))
// 每项高度（与 CSS rp-rng-opt 一致，用于滚动定位选中项）
const ITEM_H = 32

// =============== Props / v-model ===============
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

// =============== 行数据 ===============
//   _id:       稳定唯一 key（v-for）
//   formula:   公式字符串
//   _ferr:     公式错误信息（空=合法）
//   val:       [L, R] 或 null —— 先点左列选 L，再点右列选 R；两边点完即 is_done=true
//   _open:     面板是否打开
//   _hoverL:   左列 hover 值（仅用于高亮）
let _idSeq = 0
function newEmptyRow() {
  return { _id: ++_idSeq, formula: '', _ferr: '', val: null, _open: false, _hoverL: null }
}
function isRangeDone(r) {
  return Array.isArray(r.val) && r.val.length === 2
    && Number.isFinite(r.val[0]) && Number.isFinite(r.val[1])
}

// =============== DOM 引用：每行 L/R 列的滚动容器（做 scrollTop 同步） ===============
// colRefs[i] = { L: el, R: el }
const colRefs = new Map()
let _scrollingCol = null  // 防止双向同步死循环：'L' 正在拖时不把 R 同步回 L
function setColRef(i, side, el) {
  if (!colRefs.has(i)) colRefs.set(i, {})
  colRefs.get(i)[side] = el
}
// 第 i 行 side 列滚动时：把另一列的 scrollTop 设置成一样
function onScroll(i, side) {
  if (_scrollingCol && _scrollingCol !== side) return  // 另一列在被动跟，别反同步回驱动列
  const pair = colRefs.get(i)
  if (!pair) return
  const src = pair[side]
  const dst = pair[side === 'L' ? 'R' : 'L']
  if (!src || !dst) return
  _scrollingCol = side
  dst.scrollTop = src.scrollTop
  // nextTick 清空标志，给下一帧新的滚动用
  queueMicrotask(() => { _scrollingCol = null })
}

// =============== 公式校验（同 jxgj 规则，等价）===============
function checkFormula(s) {
  if (!s || typeof s !== 'string' || !s.trim()) return ''
  if (!/^[\d+\-*/().\sa-zA-Z_]*$/.test(s)) return `仅允许 数字、+ - * /、括号、变量 cost`
  if (/\*\*/.test(s)) return `不允许 ** 幂`
  if (/%/.test(s)) return `不允许 % 取模`
  const idRe = /[a-zA-Z_][a-zA-Z_0-9]*/g
  let m
  while ((m = idRe.exec(s)) !== null) if (m[0] !== 'cost') return `不允许的变量/函数：${m[0]}`
  const toks = []
  let i = 0, n = s.length
  while (i < n) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (/\d/.test(c) || c === '.') {
      let j = i, d = 0
      while (j < n && (/\d/.test(s[j]) || s[j] === '.')) { if (s[j] === '.') d++; j++ }
      if (d > 1) return `数字格式错误：${s.slice(i, j)}`
      toks.push({ k: 'N' }); i = j; continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < n && /[a-zA-Z_0-9]/.test(s[j])) j++
      if (s.slice(i, j) !== 'cost') return `不允许的变量：${s.slice(i, j)}`
      toks.push({ k: 'V' }); i = j; continue
    }
    if (c === '(') { toks.push({ k: '(' }); i++; continue }
    if (c === ')') { toks.push({ k: ')' }); i++; continue }
    if ('+-*/'.includes(c)) {
      const prev = toks.length ? toks[toks.length - 1].k : null
      const atStart = prev === null || '+-*/u('.includes(prev)
      if (atStart && (c === '+' || c === '-')) { toks.push({ k: 'u' }); i++; continue }
      if (!atStart && '+-*/'.includes(c)) { toks.push({ k: c }); i++; continue }
      return `运算符 ${c} 位置错误`
    }
    return `非法字符：${c}`
  }
  let depth = 0, prev = null
  for (const t of toks) {
    if (t.k === '(') {
      depth++
      if (prev && (prev.k === 'N' || prev.k === 'V' || prev.k === ')')) return `左括号前缺运算符`
    } else if (t.k === ')') {
      depth--
      if (depth < 0) return `括号不匹配：多余的 )`
      if (!prev || '+-*/u('.includes(prev.k)) return `括号内内容为空`
    } else if ('+-*/'.includes(t.k)) {
      if (!prev || '+-*/u('.includes(prev.k)) return `二元运算符 ${t.k} 缺少左操作数`
    } else if (t.k === 'u') {
      if (prev && !'+-*/u('.includes(prev.k)) return `一元符号位置错误`
    } else if (t.k === 'N' || t.k === 'V') {
      if (prev && (prev.k === 'N' || prev.k === 'V' || prev.k === ')')) return `数字或变量相邻，缺运算符`
    }
    prev = t
  }
  if (depth !== 0) return `括号不匹配：缺少 ${depth} 个 )`
  if (!prev) return `公式为空`
  if ('+-*/u('.includes(prev.k)) return `公式不完整：末尾缺操作数`
  return ''
}

// =============== 初始化 & 回显 ===============
function initRows() {
  const list = []
  const src = Array.isArray(props.modelValue) ? props.modelValue : []
  for (const triple of src) {
    const [L, U, F] = Array.isArray(triple) ? triple : [null, null, '']
    const l = Number(L), u = Number(U)
    if (!(Number.isFinite(l) && Number.isFinite(u) && l < u)) continue
    const formula = (typeof F === 'string' ? F : '') || 'cost'
    const ferr = checkFormula(formula)
    list.push({
      _id: ++_idSeq,
      formula: ferr ? formula : (formula === 'cost' ? '' : formula),
      _ferr: ferr,
      val: [l, u],
      _open: false,
      _hoverL: null
    })
  }
  const allDone = list.every(r => isRangeDone(r) && !r._ferr)
  if (allDone) list.push(newEmptyRow())
  return list
}
const rows = ref(initRows())

// =============== 输出 emit（同值不发）===============
function isDone(r) { return isRangeDone(r) && !r._ferr }
let _lastOut = ''
function emitOut() {
  const out = rows.value
    .filter(isDone)
    .map(r => [String(r.val[0]), String(r.val[1]), r.formula || 'cost'])
    .filter(([l, u]) => l !== '' && l !== 'null' && u !== '' && u !== 'null')  // 双保险
  const s = JSON.stringify(out)
  if (s === _lastOut) return
  _lastOut = s
  emit('update:modelValue', out)
}
function ensureEmpty() {
  // 进行中：不再追加空行（锁定）
  if (props.disabled) return
  if (rows.value.every(isDone)) rows.value.push(newEmptyRow())
}

// =============== 用户事件：左/右分开点 ===============
// 左列点击 = 选择 lower（左界必须小于已选右界）
function pickL(i, V) {
  if (props.disabled) return
  const row = rows.value[i]
  const oldR = (row.val ? row.val[1] : null)
  if (oldR != null && V >= oldR) return  // 左界 ≥ 已选右界 → 无效区间，忽略
  row.val = [Number(V), oldR]
  _afterPickOrOpen(i)
}
// 右列点击 = 选择 upper（右界必须大于已选左界；若 L 尚未选，默认取 L=当前两列可见行的左对应；否则留 [null, R] 也允许单独填 R）
function pickR(i, V) {
  if (props.disabled) return
  const row = rows.value[i]
  const oldL = (row.val ? row.val[0] : null)
  if (oldL != null && V <= oldL) return  // 右界 ≤ 已选左界 → 无效区间，忽略
  row.val = (oldL != null) ? [Number(oldL), Number(V)] : [null, Number(V)]
  // 若 L 也已填上 → 两列都齐 → 关面板
  if (row.val && row.val[0] != null && row.val[1] != null) {
    nextTick(() => { row._open = false })
  }
  _afterPickOrOpen(i)
}
// 清空
function clearRange(i) {
  if (props.disabled) return
  const row = rows.value[i]
  row.val = null
  row._hoverL = null
  ensureEmpty()
  emitOut()
}
// 选完或打开后都要做的事：ensureEmpty + emitOut
function _afterPickOrOpen(i) {
  // 打开面板后：若有已选中的 L/R，滚动到对应行（两列 scrollTop 同步）
  const row = rows.value[i]
  if (row._open) {
    const pair = colRefs.get(i)
    if (pair && pair.L && pair.R) {
      const V = (row.val ? row.val[0] : null) ?? (row._hoverL) ?? L_MIN
      const idx = Math.max(0, Math.min(LEFT_LIST.length - 1, Math.floor((Number(V) - L_MIN) / STEP)))
      // 让目标项大致居中（滚动容器 max-height 340 ≈ 10 行，减 4 行居中）
      const top = Math.max(0, idx * ITEM_H - 4 * ITEM_H)
      pair.L.scrollTop = top
      pair.R.scrollTop = top
    }
  }
  ensureEmpty()
  emitOut()
}
// 面板打开的 watch：打开后若已选中某值则滚动到那一行
watch(() => rows.value.map(r => r._open), async () => {
  await nextTick()
  for (let i = 0; i < rows.value.length; i++) {
    if (rows.value[i]._open) _afterPickOrOpen(i)
  }
}, { flush: 'post' })
function onFormula(i, v) {
  if (props.disabled) return
  const r = rows.value[i]
  r.formula = v ?? ''
  r._ferr = checkFormula(r.formula)
  ensureEmpty()
  emitOut()
}
function removeRow(i) {
  if (props.disabled) return
  if (rows.length <= 1) return
  rows.value.splice(i, 1)
  ensureEmpty()
  emitOut()
}

// =============== 外部 modelValue 同步（按 L_U key 增量，不毁 v-for key）===============
watch(() => props.modelValue, (nv) => {
  const src = Array.isArray(nv) ? nv : []
  const inc = new Map()
  for (const triple of src) {
    const [L, U, F] = Array.isArray(triple) ? triple : [null, null, '']
    const l = Number(L), u = Number(U)
    if (!(Number.isFinite(l) && Number.isFinite(u) && l < u)) continue
    const key = `${l}_${u}`
    if (!inc.has(key)) inc.set(key, { l, u, formula: (typeof F === 'string' ? F : '') || 'cost' })
  }
  const used = new Set()
  for (const r of rows.value) {
    if (!isRangeDone(r)) continue
    const key = `${r.val[0]}_${r.val[1]}`
    if (inc.has(key)) {
      const item = inc.get(key)
      const formula = item.formula === 'cost' ? '' : item.formula
      if (r.formula !== formula) {
        r.formula = formula
        r._ferr = checkFormula(formula)
      }
      used.add(key)
    } else {
      r._rm = true
    }
  }
  rows.value = rows.value.filter(r => !r._rm)
  for (const [key, item] of inc) {
    if (used.has(key)) continue
    const formula = item.formula === 'cost' ? '' : item.formula
    rows.value.push({
      _id: ++_idSeq,
      formula,
      _ferr: checkFormula(formula),
      val: [item.l, item.u],
      _open: false,
      _hoverL: null
    })
  }
  ensureEmpty()
  emitOut()
}, { deep: true })
</script>

<style scoped>
.rp { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.rp-row { display: flex; flex-direction: row; align-items: flex-start; gap: 8px; }
.rp-f-wrap { flex: 1.6; display: flex; flex-direction: column; min-width: 0; }
.rp-f-err { margin-top: 3px; font-size: 11.5px; color: #d03050; line-height: 1.4; word-break: break-all; }
.rp-del { flex-shrink: 0; margin-top: 4px; }

/* ---------- 自写区间选择器 ---------- */
.rp-rng {
  flex: 1;
  min-width: 220px;
}
.rp-rng-trigger {
  height: 34px;
  padding: 0 28px 0 12px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.88);
  cursor: pointer;
  user-select: none;
  transition: border-color .2s;
  position: relative;
}
.rp-rng-trigger:hover { border-color: #18a058; }
.rp-rng-placeholder { color: rgba(0,0,0,0.35); }
.rp-rng-sel { color: #18a058; border-color: rgba(24, 160, 88, 0.5); }
.rp-rng-clear {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px; height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0,0,0,0.08);
  color: rgba(0,0,0,0.6);
  font-size: 14px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.rp-rng-clear:hover { background: #ff4d4f; color: #fff; }

/* 全屏遮罩（点空白关面板） */
.rp-mask {
  position: fixed;
  z-index: 2000;
  inset: 0;
  background: rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 弹出面板（fixed 居中，两列并排） */
.rp-rng-panel {
  position: relative;
  min-width: 300px;
  max-height: 460px;
  display: flex;
  flex-direction: row;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

/* 每列滚动区 */
.rp-rng-col {
  flex: 1;
  min-width: 130px;
  max-height: 340px;
  overflow-y: auto;
  border-right: 1px solid #f0f0f0;
}
.rp-rng-col:last-child { border-right: none; }
/* 选项 */
.rp-rng-opt {
  height: 32px;
  padding: 0 14px;
  line-height: 32px;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.88);
  cursor: pointer;
  transition: background-color .15s, color .15s;
  white-space: nowrap;
}
.rp-rng-opt:hover,
.rp-rng-opt--hover {
  background: #f5f7fa;
  color: #18a058;
}
.rp-rng-opt--sel {
  background: #eafff3;
  color: #18a058;
  font-weight: 600;
}
/* 右列 hover 即表示"想选这个"，给个更明显的手势 */
.rp-rng-opt--right { cursor: pointer; }
.rp-rng-opt--right:hover {
  background: #18a058;
  color: #fff;
}

/* 锁定态（进行中）样式 */
.rp--disabled .rp-row { opacity: .7; }
.rp-rng-trigger.rp-rng-disabled {
  cursor: not-allowed;
  background: #f5f7fa;
  border-color: #e4e7ed;
  color: #909399;
}

/* 滚动条美化 */
.rp-rng-col::-webkit-scrollbar { width: 6px; }
.rp-rng-col::-webkit-scrollbar-thumb { background: #dcdfe6; border-radius: 3px; }
.rp-rng-col::-webkit-scrollbar-track { background: transparent; }
</style>
