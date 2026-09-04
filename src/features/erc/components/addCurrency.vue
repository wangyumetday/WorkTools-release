<!-- ============================================================
     addCurrency.vue - 币种选择列表（带三字码搜索）
     职责：展示全部币种（store.currencies_list），点击币种加入/移出参与换算
     复用场景：
       1. CurrencyConverter 的"加币种"drawer 内容
       2. Home.vue 的"全部币种"tab 页面
       3. FloatingHome 的内联"加币种"面板
     国旗图片来自 public/flags/<alpha2Code>.png（vite 静态资源，用绝对路径 /flags/）
     列表项：国旗 | 三字码 | 汇率(2位) | 国家名(超出省略)
     滚动条：统一 4px 宽，半透明 thumb
     列表最大高度可由父级通过 --currency-list-max-h 覆盖（默认 240px）
     ============================================================ -->

<template>
  <div class="wrap">
    <div class="search-box">
      <input
        class="search-input"
        type="text"
        v-model="searchCode"
        placeholder="输入三字码 / 中文名 / 英文名搜索"
        spellcheck="false"
      />
    </div>
    <div class="currency-list">
      <div
        class="currency-item"
        :class="{ 'is-selected': isActive(item.currencies.code) }"
        v-for="(item, index) in filteredCurrencies"
        :key="index"
        @click="selectCurrency(item)"
      >
        <div class="flag">
          <img :src="`/flags/${item.alpha2Code}.png`" :alt="item.name">
        </div>
        <div class="code">{{ item.currencies.code }}</div>
        <div class="rate">{{ formatRate(item.currencies.rate) }}</div>
        <div class="country-name">{{ item.name }}</div>
      </div>
      <div v-if="filteredCurrencies.length === 0" class="empty-tip">
        无匹配币种
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useDataStore } from '../stores/data.js'
import { matchCurrencyByKeyword } from '../shared/searchIndex.js'

const store = useDataStore()

const searchCode = ref('')

// 多维度模糊过滤：三字码 / 中文名(translations.zho) / 币种英文名 / 国家英文名 / 硬编码别名
const filteredCurrencies = computed(() => {
  const kw = searchCode.value.trim().toLowerCase()
  if (!kw) return store.currencies_list
  return store.currencies_list.filter(item => matchCurrencyByKeyword(item, kw))
})

// 当前活跃币种 code 集合（用于高亮已选中项）
const activeCodes = computed(() => {
  const set = new Set()
  for (const c of store.activeCurrency) {
    if (c?.currencies?.code) set.add(c.currencies.code.toUpperCase())
  }
  return set
})
function isActive(code) {
  return activeCodes.value.has(String(code || '').toUpperCase())
}

// 汇率显示：保留两位小数（四舍五入）
function formatRate(rate) {
  const n = Number(rate)
  if (Number.isNaN(n)) return '0.00'
  return n.toFixed(2)
}

// 点击币种：加入或移出参与换算
function selectCurrency(currency) {
  store.updataActiveCurrency(currency)
}
</script>

<style scoped>
.wrap {
  width: 100%;
  height: 100%;
  padding: 8px;
  box-sizing: border-box;
}

.search-box {
  width: 100%;
  margin-bottom: 8px;
}
.search-input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.12s;
}
.search-input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}
.search-input:focus {
  border-color: rgba(99, 226, 183, 0.5);
}

.currency-list {
  max-height: var(--currency-list-max-h, 240px);
  overflow-y: auto;
}

.currency-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 6px;
  border-radius: 4px;
  cursor: pointer;
  box-sizing: border-box;
  transition: background 0.12s;
}
.currency-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.currency-item.is-selected {
  background: rgba(99, 226, 183, 0.14);
  border: 1px solid rgba(99, 226, 183, 0.35);
  padding: 0 5px;
}
.currency-item.is-selected .code {
  color: #63e2b7;
}
.currency-item + .currency-item {
  margin-top: 2px;
}

.flag {
  flex: 0 0 auto;
  width: 24px;
  height: 16px;
  overflow: hidden;
  border-radius: 2px;
}
.flag img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.code {
  flex: 0 0 auto;
  width: 36px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.9);
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}

.rate {
  flex: 0 0 auto;
  width: 56px;
  text-align: right;
  font-size: 12px;
  color: rgba(99, 226, 183, 0.85);
  font-variant-numeric: tabular-nums;
}

.country-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.62);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-tip {
  text-align: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  padding: 16px 0;
}

/* 统一滚动条样式：4px 宽，半透明 thumb，透明 track */
.currency-list::-webkit-scrollbar {
  width: 4px;
}
.currency-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}
.currency-list::-webkit-scrollbar-track {
  background: transparent;
}
</style>
