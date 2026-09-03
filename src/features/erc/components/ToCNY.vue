<!-- ============================================================
     ToCNY.vue - 任意币种与人民币互转
     职责：
       - 第一个框：输入 "数值+币种代码"（如 500krw），大小写不敏感
       - 第二个框：显示/输入人民币金额（两位小数），后跟 CNY 标识
       - 中间 ⇄ 符号仅作视觉示意，不可交互
     双向：
       - 编辑 box1 → 正向换算写入 box2（CNY = 数值 × cnyRate ÷ srcRate）
       - 编辑 box2 → 反向换算写入 box1（源币种金额 = CNY × srcRate ÷ cnyRate）
         反向时保留 box1 中已有的币种代码，仅替换数值；box1 无合法币种代码则不回填
     解耦：仅依赖本模块 store 的 currencies_list，不涉及其他模块
     精度：用 decimal.js 折算，消除 JS 浮点误差
     ============================================================ -->

<template>
  <div class="tc">
    <n-input
      class="tc-input"
      :value="rawInput"
      placeholder="如 500krw"
      @update:value="handleSrcInput"
      clearable
    />
    <span class="tc-arrow" title="数值互转">⇄</span>
    <n-input
      class="tc-output"
      :value="cnyInput"
      placeholder="0.00"
      @update:value="handleCnyInput"
      clearable
    >
      <template #suffix>
        <span class="tc-suffix">CNY</span>
      </template>
    </n-input>
  </div>
</template>

<script setup>
import { NInput } from 'naive-ui'
import Decimal from 'decimal.js'
import { ref } from 'vue'
import { useDataStore } from '../stores/data.js'

const store = useDataStore()

// box1 原始输入（数值+币种代码，如 500krw）
const rawInput = ref('')
// box2 输入的人民币金额字符串
const cnyInput = ref('')

// 解析 box1：提取数值与币种代码
// 返回 { amount, code(大写用于匹配), rawCode(原大小写用于回填) }，非法返回 null
function parseSrcInput(input) {
  const raw = (input ?? '').trim()
  if (!raw) return null
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]{3})$/)
  if (!match) return null
  return {
    amount: match[1],
    code: match[2].toUpperCase(),
    rawCode: match[2]
  }
}

// 查找源币种与 CNY（rate 为 1USD 兑该币种数量）
function findCurrencies(code) {
  const srcCurrency = store.currencies_list.find(
    item => item.currencies.code.toUpperCase() === code
  )
  const cnyCurrency = store.currencies_list.find(
    item => item.currencies.code.toUpperCase() === 'CNY'
  )
  // 无兜底数据：缺任一或汇率缺失返回 null
  if (!srcCurrency || !cnyCurrency) return null
  const srcRate = srcCurrency.currencies.rate
  const cnyRate = cnyCurrency.currencies.rate
  if (!srcRate || !cnyRate) return null
  return { srcRate, cnyRate }
}

// 编辑 box1：正向换算写入 box2
function handleSrcInput(value) {
  rawInput.value = value ?? ''
  const parsed = parseSrcInput(rawInput.value)
  if (!parsed) {
    cnyInput.value = ''
    return
  }
  const rates = findCurrencies(parsed.code)
  if (!rates) {
    cnyInput.value = ''
    return
  }
  // CNY = 数值 × cnyRate ÷ srcRate
  try {
    const result = new Decimal(parsed.amount).times(rates.cnyRate).div(rates.srcRate)
    cnyInput.value = result.toFixed(2)
  } catch (e) {
    cnyInput.value = ''
  }
}

// 编辑 box2：反向换算写入 box1（保留 box1 已有币种代码，仅替换数值）
function handleCnyInput(value) {
  cnyInput.value = value ?? ''
  const raw = (value ?? '').trim()
  if (!raw) return
  // box2 仅接受数值（可含小数）
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return
  // 反向需 box1 已有合法币种代码
  const parsed = parseSrcInput(rawInput.value)
  if (!parsed) return
  const rates = findCurrencies(parsed.code)
  if (!rates) return
  // 源币种金额 = CNY × srcRate ÷ cnyRate
  try {
    const srcAmount = new Decimal(raw).times(rates.srcRate).div(rates.cnyRate)
    rawInput.value = `${srcAmount.toFixed(2)}${parsed.rawCode}`
  } catch (e) {
    // 反算失败不回填
  }
}
</script>

<style scoped>
.tc {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 12px;
}
.tc-input {
  flex: 1;
}
.tc-arrow {
  user-select: none;
  pointer-events: none;
  color: #888;
  font-size: 18px;
  line-height: 1;
}
.tc-output {
  flex: 1;
}
.tc-output .tc-suffix {
  color: #888;
  margin-left: 4px;
}
</style>
