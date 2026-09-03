<!-- ============================================================
     CurrencyConverter.vue - 汇率转换页
     职责：
       - 展示参与换算的币种（activeCurrency）的 SingleCurrency 卡片网格
       - "加币种"按钮打开 drawer 选择币种加入换算
     说明：上方"换算成人民币"区块由 ToCNY 组件实现
     ============================================================ -->

<template>
  <div class="content">
    <!-- 任意币种换算成人民币 -->
    <n-layout class="toCNY">
      <n-layout-header>换算成人民币</n-layout-header>
      <n-layout-content content-style="padding: 24px;">
        <ToCNY />
      </n-layout-content>
    </n-layout>

    <!-- 同步换算：所有参与换算的币种卡片 -->
    <n-layout class="toAny">
      <n-layout-header>同步换算</n-layout-header>
      <n-layout-content content-style="padding: 24px;">
        <div class="ta-flex">
          <SingleCurrency
            v-for="currency in store.activeCurrency"
            :key="currency"
            :currency="currency"
          />
        </div>
      </n-layout-content>
    </n-layout>

    <n-button type="primary" @click="showSelectCurrency('right')">
      加币种
    </n-button>

    <!-- 币种选择 drawer -->
    <n-drawer
      v-model:show="SelectCurrencyStatus"
      :default-width="500"
      :max-width="500"
      :min-width="200"
      :placement="placement"
      resizable
    >
      <n-drawer-content title="选择币种" :native-scrollbar="false" body-class="ndc-body">
        <addCurrency />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup>
import { NLayout, NLayoutHeader, NLayoutContent, NDrawer, NButton, NDrawerContent } from 'naive-ui'
import SingleCurrency from '../components/SingleCurrency.vue'
import ToCNY from '../components/ToCNY.vue'
import addCurrency from '../components/addCurrency.vue'
import { useDataStore } from '../stores/data.js'
import { ref } from 'vue'

const store = useDataStore()

// 加币种弹窗显示状态
const SelectCurrencyStatus = ref(false)
// drawer 弹出方向
const placement = ref('right')

// 打开币种选择 drawer
function showSelectCurrency(place) {
  SelectCurrencyStatus.value = true
  placement.value = place
}
</script>

<style scoped>
.content {
  width: 100%;
  background: transparent;
}
.toCNY {
  margin-top: 24px;
}
.toAny {
  margin-top: 24px;
}
.ta-flex {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
  justify-items: center;
  box-sizing: border-box;
}
.ndc-body {
  background-color: #2c2d35;
}
</style>
