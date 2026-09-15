<!-- ============================================================
     PCP TaskList.vue - 任务列表改版（手风琴式进度可视化）
     设计：
       - 手风琴容器：同时只展开一个面板，标题点击切换
       - 两个可视化面板（按流程顺序）：
         1. 锦绣请求可视化（jxgj 阶段任务）
         2. 携程请求可视化（trip 阶段任务）
       - 航司/舱位/航线已移至左栏 TopToolbar「必填信息」框内常驻展示
     旧实现备份于 TaskList.vue.bak
     ============================================================ -->
<template>
  <div class="vis-list">
    <!-- ===== 面板 1：锦绣请求可视化 ===== -->
    <section class="vis-panel" :class="{ 'is-open': openIdx === 0 }">
      <header class="vis-h" @click="toggle(0)">
        <span class="vis-h-caret" :class="{ open: openIdx === 0 }">▶</span>
        <span class="vis-h-title">锦绣请求</span>
        <span class="vis-h-summary">
          {{ store.jxgjTasks.length > 0 ? `${store.jxgjTasks.length} 个请求项` : '尚未生成预请求' }}
        </span>
      </header>
      <div v-if="openIdx === 0" class="vis-body">
        <!-- ★ RequestItem：task 自带 stage/preRequest/result/error，全生命周期实时更新
             jxgj 的「请求参数/返回数据（状态+信息+航班提要表）」由组件内置渲染 -->
        <div v-if="store.jxgjTasks.length > 0" class="vis-item-list">
          <RequestItem
            v-for="t in store.jxgjTasks"
            :key="t.id"
            :task="t"
            platform="jxgj"
          />
        </div>
        <div v-else class="vis-empty">尚未生成预请求</div>
      </div>
    </section>

    <!-- ===== 面板 2：携程请求可视化 ===== -->
    <section class="vis-panel" :class="{ 'is-open': openIdx === 1 }">
      <header class="vis-h" @click="toggle(1)">
        <span class="vis-h-caret" :class="{ open: openIdx === 1 }">▶</span>
        <span class="vis-h-title">携程请求</span>
        <span class="vis-h-summary">
          {{ store.tripTasks.length > 0 ? `${store.tripTasks.length} 个请求项 · 胜出率 ${tripWinRateText}` : '待锦绣阶段产出日期组' }}
        </span>
      </header>
      <div v-if="openIdx === 1" class="vis-body">
        <!-- ★ trip RequestItem：参数（日期/航线/航司/舱位）+ 返回数据（状态/统计/比价提要）
             由组件内置渲染；o2/o3 走组件内置兜底（JSON / 参数未挂载） -->
        <div v-if="store.tripTasks.length > 0" class="vis-item-list">
          <RequestItem
            v-for="t in store.tripTasks"
            :key="t.id"
            :task="t"
            :platform="t.type"
          />
        </div>
        <div v-else class="vis-empty">尚未生成预请求</div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useTaskStore } from '../stores/task.js'
import RequestItem from './RequestItem.vue'

const store = useTaskStore()

// 手风琴展开状态：-1 = 全关，0 = 锦绣请求，1 = 携程请求
//   同时只展开一个：点已开的面板 = 关闭；点其他面板 = 切换过去
const openIdx = ref(-1)

function toggle(idx) {
  openIdx.value = openIdx.value === idx ? -1 : idx
}

// ★ 本次任务全部携程请求的汇总胜出率
//   分母 = 所有 trip 请求项返回的航班总数（按 航班号|日期|出发|到达 分组，与 RequestItem tripGroups 一致）
//   分子 = 组内至少一条 isOwn && shown（= showState===1 外显）的航班数
//   仅投放未外显（ownHidden 黄）不算胜出；0 航班时显示 '—' 避免除零
const tripWinRateText = computed(() => {
  let totalFlights = 0
  let wonFlights = 0
  for (const t of store.tripTasks) {
    const rows = t.result?.quoteRows
    if (!Array.isArray(rows)) continue
    const map = new Map()
    for (const q of rows) {
      const key = `${q.flightNo}|${q.date}|${q.depAirport}|${q.arrAirport}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(q)
    }
    for (const group of map.values()) {
      totalFlights++
      if (group.some(q => q.isOwn && q.shown)) wonFlights++
    }
  }
  if (totalFlights === 0) return '—'
  return `${Math.round((wonFlights / totalFlights) * 100)}%`
})
</script>

<style scoped>
.vis-list {
  display: flex;
  flex-flow: column nowrap;
  width: 100%;
  /* ★ 滚动链：撑满 .tm-bottom 剩余高度（tm-bottom 已 flex:1 + min-height:0） */
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.vis-panel {
  border-bottom: 1px solid #e0e0e0;
  display: flex;
  flex-flow: column nowrap;
  /* 未展开面板：只占 header 自然高度；展开面板：吃掉剩余高度，内部 vis-body 滚动 */
  flex: 0 0 auto;
  min-height: 0;
}

.vis-panel.is-open {
  flex: 1 1 0;
}

.vis-panel:last-child {
  border-bottom: none;
}

/* 面板头：可点击切换展开 */
.vis-h {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: pointer;
  user-select: none;
  background: #fafafa;

  &:hover {
    background: #f0f0f0;
  }
}

/* 三角箭头：展开时旋转 90° */
.vis-h-caret {
  display: inline-block;
  font-size: 12px;
  color: #666;
  transition: transform 0.15s ease;
  transform: rotate(0deg);

  &.open {
    transform: rotate(90deg);
  }
}

.vis-h-title {
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.vis-h-summary {
  font-size: 12px;
  color: #999;
}

/* 面板体：展开后内容容器，★ 仅此容器纵向滚动（单一滚动容器，避免父子双滚动） */
.vis-body {
  padding: 12px 16px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* 列表占位（后续接入真实数据时替换） */
.vis-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  color: #bbb;
  font-size: 13px;
  border: 1px dashed #e0e0e0;
  border-radius: 4px;
}

/* ===== RequestItem 列表容器 =====
   每个 RequestItem 自带边框/圆角/背景，容器只负责垂直排列 + gap */
.vis-item-list {
  display: flex;
  flex-flow: column nowrap;
  gap: 12px;
}
</style>
