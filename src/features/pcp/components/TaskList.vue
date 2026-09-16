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
      <div v-show="openIdx === 0" ref="jxgjScrollEl" class="vis-body">
        <!-- ★ 虚拟列表：只渲染视口+overscan 内的 RequestItem，避免数百项全量 DOM 卡顿
             每项绝对定位 translateY(start)；高度由 measureElement 实测（折叠/展开自适应）
             折叠状态外置在 itemUi（按 task.id），组件回收重建不丢展开态 -->
        <div v-if="store.jxgjTasks.length > 0" class="vis-virtual-viewport"
             :style="{ height: jxgjVirt.getTotalSize() + 'px' }">
          <div
            v-for="vi in jxgjVirt.getVirtualItems()"
            :key="vi.key"
            :data-index="vi.index"
            :ref="(node) => jxgjVirt.measureElement(node)"
            class="vis-virtual-item"
            :style="{ transform: `translateY(${vi.start}px)` }"
          >
            <RequestItem
              :task="store.jxgjTasks[vi.index]"
              platform="jxgj"
              :ui-state="itemUi"
            />
          </div>
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
      <div v-show="openIdx === 1" ref="tripScrollEl" class="vis-body">
        <!-- ★ 虚拟列表（同锦绣面板）；platform 取 task.type（trip/o2/o3） -->
        <div v-if="store.tripTasks.length > 0" class="vis-virtual-viewport"
             :style="{ height: tripVirt.getTotalSize() + 'px' }">
          <div
            v-for="vi in tripVirt.getVirtualItems()"
            :key="vi.key"
            :data-index="vi.index"
            :ref="(node) => tripVirt.measureElement(node)"
            class="vis-virtual-item"
            :style="{ transform: `translateY(${vi.start}px)` }"
          >
            <RequestItem
              :task="store.tripTasks[vi.index]"
              :platform="store.tripTasks[vi.index].type"
              :ui-state="itemUi"
            />
          </div>
        </div>
        <div v-else class="vis-empty">尚未生成预请求</div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useTaskStore } from '../stores/task.js'
import RequestItem from './RequestItem.vue'

const store = useTaskStore()

// 手风琴展开状态：-1 = 全关，0 = 锦绣请求，1 = 携程请求
//   同时只展开一个：点已开的面板 = 关闭；点其他面板 = 切换过去
const openIdx = ref(-1)

function toggle(idx) {
  openIdx.value = openIdx.value === idx ? -1 : idx
}

// ===== 虚拟列表 =====
// 两个面板各自的滚动容器（.vis-body，v-show 常驻 DOM，切面板不丢 scrollTop/不重挂载）
const jxgjScrollEl = ref(null)
const tripScrollEl = ref(null)

// RequestItem 折叠状态外置（参数块/返回数据块/日期块/航班套餐展开）：
// 虚拟列表只挂载可见项，滚出视口的组件会被销毁；状态按 task.id 存在这里，
// 重建时经 :ui-state 传回，展开态原样恢复。两列表共用（task.id 全局唯一）
const itemUi = reactive({})

// 任务全部移除（阶段衔接/新一轮开始，task.id 计数器会复用）时清掉折叠状态，
// 避免新任务错误命中同 id 的旧展开态
watch(
  () => store.jxgjTasks.length + store.tripTasks.length,
  (total, oldTotal) => {
    if (total === 0 && oldTotal > 0) {
      for (const k of Object.keys(itemUi)) delete itemUi[k]
    }
  }
)

// 折叠态默认高度估算（头部 + 默认展开的参数块）；
// 真实高度由 measureElement 经 ResizeObserver 实测并按 key 缓存，展开/折叠后自动修正
const ESTIMATE_ITEM_SIZE = 112

const jxgjVirt = useVirtualizer(computed(() => ({
  count: store.jxgjTasks.length,
  getScrollElement: () => jxgjScrollEl.value,
  estimateSize: () => ESTIMATE_ITEM_SIZE,
  overscan: 6,
  getItemKey: (i) => store.jxgjTasks[i]?.id ?? i
})))

const tripVirt = useVirtualizer(computed(() => ({
  count: store.tripTasks.length,
  getScrollElement: () => tripScrollEl.value,
  estimateSize: () => ESTIMATE_ITEM_SIZE,
  overscan: 6,
  getItemKey: (i) => store.tripTasks[i]?.id ?? i
})))

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

/* 面板体：展开后内容容器，★ 仅此容器纵向滚动（单一滚动容器，避免父子双滚动）
   左右 padding 移到 .vis-virtual-item（绝对定位项需要自己承担边距）*/
.vis-body {
  padding: 12px 0 0;
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
  margin: 0 16px 12px;
  color: #bbb;
  font-size: 13px;
  border: 1px dashed #e0e0e0;
  border-radius: 4px;
}

/* ===== 虚拟列表 =====
   viewport：相对定位的总高占位（height=总高度，撑起滚动条）
   item：绝对定位 + translateY(start)，左右 16px 边距，底部 12px 项间距；
         元素本身被 measureElement 测量（含 padding），展开/折叠高度自动修正 */
.vis-virtual-viewport {
  position: relative;
  width: 100%;
}

.vis-virtual-item {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  box-sizing: border-box;
  padding: 0 16px 12px;
}
</style>
