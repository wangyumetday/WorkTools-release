<!-- ============================================================
     addCurrency.vue - 币种选择列表（带三字码搜索）
     职责：展示全部币种（store.currencies_list），点击币种加入/移出参与换算
     复用场景：
       1. Home.vue 的"全部币种"tab 页面
       2. FloatingHome 的内联"加币种"面板
     国旗图片来自 public/flags/<alpha2Code>.png（vite 静态资源，用绝对路径 /flags/）
     列表项：两列布局（左列 / 右列），每列上下两行：
       左列：国旗（上） | 中文国家名（下），均靠左
       右列：币种三字码 + 汇率（上） | 币种中文名（下）
     已移除国家英文名，避免信息冗余
     滚动条：统一 4px 宽，半透明 thumb
     列表高度由父级通过 --currency-list-max-h 覆盖（默认占满剩余空间）
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
        <!-- 左列：国旗（上）/ 中文国家名（下） -->
        <div class="col-left">
          <div class="flag">
            <img
              v-if="!failedFlags[item.alpha2Code]"
              :src="`/flags/${item.alpha2Code}.png`"
              :alt="item.translations?.common || item.name"
              @error="failedFlags[item.alpha2Code] = true"
            >
            <svg v-else class="flag-broken" viewBox="0 0 24 18" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="2" width="20" height="14" rx="1"/>
              <circle cx="8" cy="6.5" r="1.5"/>
              <path d="M3 15l5-5 3 3 4-4 6 6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <span class="country-zh">{{ item.translations?.common || item.name }}</span>
        </div>
        <!-- 右列：币种+汇率（上）/ 币种中文名（下） -->
        <div class="col-right">
          <div class="rate-line">
            <span class="code">{{ item.currencies.code }}</span>
            <span class="rate">{{ formatRate(item.currencies.rate) }}</span>
          </div>
          <span class="currency-zh">{{ getCurrencyZhName(item.currencies.code) || item.currencies.name }}</span>
        </div>
      </div>
      <div v-if="filteredCurrencies.length === 0" class="empty-tip">
        无匹配币种
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useDataStore } from '../stores/data.js'
import { matchCurrencyByKeyword, getCurrencyZhName } from '../shared/searchIndex.js'

const store = useDataStore()

const searchCode = ref('')

// 国旗图片加载失败记录：key = alpha2Code，值为 true 表示该国旗加载失败
const failedFlags = reactive({})

// 多维度模糊过滤：三字码 / 中文名(translations) / 币种英文名 / 国家英文名 / 硬编码别名
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
  display: flex;
  flex-direction: column;
}

.search-box {
  width: 100%;
  margin-bottom: 8px;
  flex-shrink: 0;
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
  flex: 1;
  min-height: 0;
  max-height: var(--currency-list-max-h, none);
  overflow-y: auto;
}

/* ===== 列表项：两列布局 =====
   左列固定宽度：国旗（上）+ 中文国家名（下），均靠左
   右列自适应：币种+汇率（上）+ 币种中文名（下），靠左对齐
   用 grid 两列，每列内 flex-col 实现上下两行 */
.currency-item {
  display: grid;
  grid-template-columns: 92px 1fr;
  column-gap: 12px;
  align-items: center;
  min-height: 48px;
  padding: 6px 8px;
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
  padding: 5px 7px;
}
.currency-item.is-selected .code {
  color: #63e2b7;
}
.currency-item + .currency-item {
  margin-top: 2px;
}

/* 左列：国旗 + 中文国家名，上下排列、靠左 */
.col-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  min-width: 0;
}
.flag {
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
.flag-broken {
  width: 100%;
  height: 100%;
  color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.04);
  display: block;
}
.country-zh {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* 右列：币种+汇率（上）/ 币种中文名（下），靠左对齐 */
.col-right {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 3px;
  min-width: 0;
}
.rate-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.code {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.92);
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}
.rate {
  font-size: 12px;
  color: rgba(99, 226, 183, 0.85);
  font-variant-numeric: tabular-nums;
}
.currency-zh {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
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
