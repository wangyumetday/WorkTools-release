<!-- ============================================================
     addCurrency.vue - 币种选择网格
     职责：展示全部币种（store.currencies_list），点击币种加入/移出参与换算
     复用场景：
       1. CurrencyConverter 的"加币种"drawer 内容
       2. Home.vue 的"全部币种"tab 页面
     国旗图片来自 public/flags/<alpha2Code>.png（vite 静态资源，用绝对路径 /flags/）
     ============================================================ -->

<template>
  <n-layout class="wrap">
    <n-layout-content content-style="padding: 12px;">
      <div class="w-nflex">
        <div
          class="wnf"
          v-for="(item, index) in store.currencies_list"
          :key="index"
          @click="selectCurrency(item)"
        >
          <div class="wnf-img">
            <img :src="`/flags/${item.alpha2Code}.png`" :alt="item.name">
          </div>
          <div class="wnf-detail">
            {{ item.currencies.code }}: {{ item.currencies.rate }}
          </div>
        </div>
      </div>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { NLayout, NLayoutContent } from 'naive-ui'
import { useDataStore } from '../stores/data.js'

const store = useDataStore()

// 点击币种：加入或移出参与换算
function selectCurrency(currency) {
  store.updataActiveCurrency(currency)
}
</script>

<style scoped>
.wrap {
  width: 100%;
}
.w-nflex {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 12px;
  justify-items: center;
  box-sizing: border-box;
}
.wnf {
  width: 90px;
  padding: 5px;
  background-color: #2c2d35;
  border-radius: 5px;
  cursor: pointer;
}
.wnf-img {
  width: 54px;
  height: 36px;
}
.wnf-img img {
  width: 100%;
  height: 100%;
}
.wnf-detail {
  width: 100%;
  height: 18px;
  line-height: 18px;
  font-size: 14px;
  padding: 2px 0 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
