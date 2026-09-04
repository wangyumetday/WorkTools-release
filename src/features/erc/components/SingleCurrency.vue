<!-- ============================================================
     SingleCurrency.vue - 单币种换算卡片
     职责：
       - 输入框接收数字或四则运算表达式，实时计算结果
       - 主动币种驱动其他被动币种同步换算（基于 BASE_VALUE）
       - 支持设为主动币种、删除该币种
     精度：用 decimal.js 做四则运算，消除 JS 浮点误差（如 0.1+0.2）
     ============================================================ -->

<template>
  <div class="sc" ref="scRoot" @click="setInitiativeCurrency">
    <div class="sc-num">
      <n-input
        class="sc-nin"
        :value="rawExpression"
        placeholder="0"
        @update:value="handleInput"
        @blur="commitCalculation"
        clearable
      >
        <template #suffix>
          <span class="eq-result" v-if="showEquals">={{ displayResult }}</span>
          <span class="currency-symbol">{{ currency.currencies.symbol }}</span>
        </template>
      </n-input>
    </div>
    <div class="sc-readme">
      <div class="scr-top">
        <div class="scrt-left">
          {{ currency.currencies.initiative ? '主动币种' : '被动币种' }}
        </div>
        <div class="scrt-right">
          <div class="rate">
            {{ currency.currencies.rate.toFixed(2) }}
          </div>
          <div class="symbol">
            <span class="symbol-glyph">{{ currency.currencies.symbol }}</span><span class="symbol-code">{{ currency.currencies.code }}</span>
          </div>
        </div>
      </div>
      <div class="scr-bottom">
        <div class="scrb-name">
          {{ currency.name }}
        </div>
      </div>
    </div>
    <div class="sc-btn">
      <n-icon
        @click.stop="removeCurrency(currency)"
        :component="CloseCircleSharp"
        size="24"
        color="#e06c75"
        :depth="3"
        style="cursor: pointer;"
      />
    </div>
  </div>
</template>

<script setup>
import { NInput, NIcon } from 'naive-ui'
import { CloseCircleSharp } from '@vicons/ionicons5'
import Decimal from 'decimal.js'
import { useDataStore } from '../stores/data.js'
import { ref, watch, computed } from 'vue'

const store = useDataStore()

const props = defineProps({
  currency: { type: Object, required: true }
})

// 卡片根元素引用，用于判断当前焦点是否落在本卡片内（避免误跳过其他卡片刷新）
const scRoot = ref(null)

// 用户实际输入的原始字符串（仅含表达式或数字，不含 = 结果）
// 被动币种初始展示 2 位小数；主动币种展示原值
const initVal = props.currency.currencies.value ?? 0
const rawExpression = ref(
  props.currency.currencies.initiative ? String(initVal) : Number(initVal).toFixed(2)
)

// 实时计算的结果；null 表示当前无需显示 = 结果（纯数字或非法表达式）
const displayResult = ref(null)
// 标记本卡片输入框是否被用户编辑过（用于失焦恢复判断）
const dirty = ref(false)

// 是否显示 =结果：仅当 displayResult 非空且为有效数字
const showEquals = computed(
  () => displayResult.value !== null && !Number.isNaN(displayResult.value)
)

// 当外部值变化（如被动币种被 syncPassiveValues 刷新），同步到输入框显示
// 跳过用户正在编辑的输入框，避免覆盖未提交的输入
// 被动币种展示固定 2 位小数；主动币种展示原值（无强制小数位）
watch(
  () => props.currency.currencies.value,
  (newVal) => {
    // 仅跳过用户正在编辑的本卡片，其他卡片被动刷新不受影响
    if (scRoot.value?.contains(document.activeElement)) return
    if (props.currency.currencies.initiative) {
      rawExpression.value = String(newVal ?? 0)
    } else {
      rawExpression.value = Number(newVal ?? 0).toFixed(2)
    }
    displayResult.value = null
  }
)

// 从左到右计算表达式（不遵循传统先乘除后加减的优先级）
// 每一步原子运算用 decimal.js，避免 JS 浮点精度问题
function evaluateLeftToRight(expr) {
  // 仅允许数字、小数点、加减乘除和空白字符
  if (!/^[\d+\-*/.\s]+$/.test(expr)) return null
  // 拆出操作数与运算符：例如 "1+3*2" -> ["1","+","3","*","2"]
  const tokens = expr.match(/\d+\.?\d*|[+\-*/]/g)
  if (!tokens || tokens.length === 0) return null

  let result = new Decimal(tokens[0])
  // 从左到右两两消费：tokens[1] 是运算符，tokens[2] 是右操作数，依此类推
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i]
    const nextToken = tokens[i + 1]
    // 表达式末尾是运算符且无右操作数 → 中止
    if (nextToken === undefined) break
    const num = new Decimal(nextToken)
    switch (op) {
      case '+': result = result.plus(num); break
      case '-': result = result.minus(num); break
      case '*': result = result.times(num); break
      case '/': result = result.div(num); break
      default: return null
    }
  }
  return result.toNumber()
}

// 每次输入实时计算并同步值：纯数字不显示 =；表达式有效则显示 =结果
// 改动即把当前币种设为主动币种，其余被动币种由 store.syncPassiveValues 联动重算
function handleInput(value) {
  rawExpression.value = value ?? ''
  dirty.value = true
  const raw = (value ?? '').trim()

  if (!raw) {
    displayResult.value = null
    becomeInitiative()
    props.currency.currencies.value = 0
    store.syncPassiveValues()
    return
  }

  // 纯数字：不显示 = 结果，直接同步值
  if (/^-?\d+\.?\d*$/.test(raw)) {
    displayResult.value = null
    becomeInitiative()
    props.currency.currencies.value = Number(raw)
    store.syncPassiveValues()
    return
  }

  // 表达式：实时计算
  const result = evaluateLeftToRight(raw)
  if (result === null || Number.isNaN(result)) {
    // 非法表达式：不显示 =，也不更新币种值（保留上一次有效值）
    displayResult.value = null
    return
  }
  displayResult.value = result
  becomeInitiative()
  props.currency.currencies.value = result
  store.syncPassiveValues()
}

// 失焦时整理：若当前显示的是表达式，把输入框折叠为结果数字，便于下次编辑
// 仅在用户编辑过时恢复，避免点击提升后失焦把 2 位小数展示覆写为全精度浮点
function commitCalculation() {
  if (displayResult.value !== null) {
    rawExpression.value = String(displayResult.value)
    displayResult.value = null
    dirty.value = false
    return
  }
  if (!dirty.value) return
  // 当前为非法或空，恢复为当前币种值
  const v = props.currency.currencies.value ?? 0
  rawExpression.value = props.currency.currencies.initiative
    ? String(v)
    : Number(v).toFixed(2)
  dirty.value = false
}

// 删除该币种（从参与换算中移除）
function removeCurrency(currency) {
  store.removeCurrency(currency)
}

// 设为主动币种：清零其余 initiative，置当前为主动，并联动重算被动币种
function becomeInitiative() {
  if (props.currency.currencies.initiative) return
  store.activeCurrency.forEach(item => {
    item.currencies.initiative = false
  })
  props.currency.currencies.initiative = true
}

// 点击卡片：设为主动并联动重算（点击被动币种时以其当前值为新锚点）
function setInitiativeCurrency() {
  if (!props.currency.currencies.initiative) {
    becomeInitiative()
    store.syncPassiveValues()
  }
}
</script>

<style scoped>
.sc {
  width: 150px;
  background: #2f2f2f;
  border-radius: 5px;
  position: relative;
}
.sc-num {
  width: 100%;
  height: 35px;
}
.sc-num .sc-nin .eq-result {
  color: #888;
  margin-right: 4px;
}
.sc-readme {
  width: 100%;
  padding: 4px;
}
.sc-readme div {
  width: 100%;
}
.scr-top {
  height: 42px;
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  justify-content: space-between;
}
.scr-top div {
  overflow: hidden;
  flex: 1;
}
.scrt-left {
  height: 42px;
  padding: 2px 0;
  margin-right: 4px;
  align-items: center;
  justify-content: center;
  display: flex;
  flex-flow: row nowrap;
}
.scrt-right {
  width: 56%;
  font-size: 12px;
  padding: 0 0 0 4px;
  display: flex;
  flex-flow: column nowrap;
  align-items: center;
  justify-content: center;
}
.scrt-right div {
  font-size: 14px;
  line-height: 18px;
}
.scrt-right .rate {
  font-size: 15px;
  font-weight: 400;
}
.scrt-right .symbol {
  font-size: 12px;
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.scrt-right .symbol .symbol-glyph {
  color: rgba(99, 226, 183, 0.85);
}
.scrt-right .symbol .symbol-code {
  color: rgba(255, 255, 255, 0.75);
}
.scr-bottom {
  padding: 0;
}
.scr-bottom .scrb-name {
  width: 100%;
  font-size: 15px;
  line-height: 20px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-btn {
  position: absolute;
  bottom: 0;
  right: 4px;
}
</style>
