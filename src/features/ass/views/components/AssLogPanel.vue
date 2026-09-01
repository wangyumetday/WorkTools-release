<!-- ============================================================
     AssLogPanel.vue — 执行日志区（抽离自 Home.vue）
     职责：渲染 P1/P2 结构化行 + 信息行（纯终端风）
     纯展示组件：日志数据由 Home 持有（pushLog 组装 entry），本组件只负责着色渲染
     ============================================================ -->

<template>
  <!-- ============ 顶栏统计：agency 航班数排行榜（终端同画风，纯文本长度条） ============ -->
  <div class="rizhi-wrap">
    <div class="stats-bar">
      <div class="st-title dim">
        agency 统计{{ stats.length ? ` · ${stats.length} 家 · 共 ${statsTotal} 班` : '' }}
      </div>
      <div v-if="stats.length" class="st-rows">
        <div v-for="s in stats" :key="s.code" class="st-row">
          <span class="st-name" :title="s.name">{{ s.name }}</span>
          <span class="st-bar">
            <span class="bar-bg">{{ barOf(s, stats[0].count) }}</span>
            <!-- 胜出统计（数据无用，暂注释）：绿色半透明覆盖条
          <span v-if="s.winCount" class="bar-win">{{ barOfWin(s, stats[0].count) }}</span>
          -->
          </span>
          <span class="st-count">{{ s.count }}</span>
          <span class="st-pct dim">{{ pctOf(s.count) }}</span>
          <!-- 胜出统计（数据无用，暂注释）：绿色数值
        <span class="st-win">{{ s.winCount ?? 0 }}</span>
        -->
        </div>
      </div>
      <div v-else class="st-title dim">（暂无统计，P2 请求返回后自动累计）</div>
    </div>

    <!-- ============ 执行日志：终端风 ============ -->
    <div class="log-area">
      <div v-if="logs.length === 0" class="empty-hint">（暂无日志，点击"开始执行"后将实时显示每次 P1/P2 请求结果。）</div>

      <template v-for="(l, i) in logs" :key="i">
        <!-- =================== 结构化：P1 / P2 单请求 =================== -->
        <div v-if="l._isItem" class="log-line">
          <span class="dim">{{ l._ts }}</span>
          <span class="dim"> [</span>
          <span :class="[l._phase === 'P2_ITEM' ? 'phase-p2' : 'phase-p1']">
            {{ l._phase === 'P2_ITEM' ? 'P2' : 'P1' }}
          </span>
          <span class="dim">] </span>

          <span class="txt">{{ l.route || '?-?' }}</span>
          <span v-if="l.airline" class="dim">·{{ l.airline }}</span>

          <span class="dim"> date:</span>
          <span class="txt">{{ l.dateDisplay }}</span>

          <!-- 状态关键字着色（唯一的高亮色） -->
          <span class="status" :style="{ color: termStatusColor(l.result) }">{{ l.result }}</span>

          <span class="dim"> count:</span>
          <span :class="(l.count ?? 0) > 0 ? 'txt' : 'dim'">{{ l.count ?? 0 }}</span>

          <span class="progress">{{ l._idx }} / {{ l._tot }}</span>

          <!-- 错误：独立一行红色，前缩进对齐 -->
          <div v-if="l._errorMsg" class="err-line">error: {{ l._errorMsg }}</div>
        </div>

        <!-- =================== 信息行：INIT / DONE / FATAL / LOGIN / ERROR =================== -->
        <div v-else class="log-line">
          <span class="dim">{{ l._ts }}</span>
          <span class="dim"> </span>
          <span class="kind" :style="{ color: termKindColor(l._kind) }">{{ (l._kind || 'INFO').toLowerCase() }}</span>
          <span class="txt"> {{ l._msg }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  logs: { type: Array, default: () => [] },
  /** 排行榜数据：[{ code, name, count }]（主进程已按 count 降序） */
  stats: { type: Array, default: () => [] },
})

/** 长度条最满时的字符数 */
const BAR_COLS = 24

const statsTotal = computed(() =>
  props.stats.reduce((sum, s) => sum + (s.count || 0), 0)
)

/**
 * 按 count 相对最大值生成 '█' 长度条（最少 1 格，最多 BAR_COLS 格）
 */
function barOf(entry, maxCount) {
  if (!entry || !entry.count || !maxCount) return ''
  const len = Math.max(1, Math.round((entry.count / maxCount) * BAR_COLS))
  return '█'.repeat(len)
}

/* 胜出绿条（数据无用，暂注释）
function barOfWin(entry, maxCount) {
  if (!entry || !entry.winCount || !maxCount) return ''
  const len = Math.max(1, Math.round((entry.winCount / maxCount) * BAR_COLS))
  return '█'.repeat(len)
}
*/

/**
 * 本组数量占总数据量的百分比（一位小数）
 */
function pctOf(count) {
  const total = statsTotal.value
  if (!total || !count) return '0.0%'
  return `${((count / total) * 100).toFixed(1)}%`
}

/**
 * 【终端风 · 仅前景色】请求状态关键字 → 字颜色
 * 只有这 6 个关键字变色，其他一律默认白 / 灰，保持干净。
 */
function termStatusColor(r) {
  switch (r) {
    case 'HAS_FLIGHT': return '#3fb950' // 绿：有航班（锦绣）
    case 'NO_FLIGHT': return '#f85149' // 红：无航班（锦绣）
    case 'UNKNOWN': return '#d29922' // 黄：未知/异常
    case 'OK': return '#3fb950' // 绿：查询成功（携程）
    case 'SKIP': return '#8b949e' // 灰：直接跳过
    case 'ERROR': return '#f85149' // 红：错误
    default: return '#e6edf3' // 白：保底
  }
}

/**
 * 【终端风 · 仅前景色】信息行 kind 标签 → 字颜色
 */
function termKindColor(kind) {
  const k = String(kind || 'INFO').toUpperCase()
  if (k === 'DONE') return '#3fb950'
  if (k === 'FATAL' || k === 'ERR' || k === 'ERROR') return '#f85149'
  if (k === 'LOGIN') return '#79c0ff'
  if (k === 'INIT' || k === 'START') return '#8b949e'
  return '#8b949e'
}
</script>

<style scoped>
/* 顶栏统计：与日志区同画风的黑底终端块（只黑白灰，无彩色） */
/* 外层稳定结构：占满父级 100% 高度、禁止外层溢出；高度分配交给内部 flex */
.rizhi-wrap {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-flow: column nowrap;
}

.stats-bar {
  background: #000;
  color: #e6edf3;
  font-family: Consolas, Menlo, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.55;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 8px;
  border-bottom: 1px solid #21262d;
}

.st-rows {
  margin-top: 2px;
}

.st-row {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.st-name {
  flex: 0 0 13em;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e6edf3;
}

.st-bar {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  color: #e6edf3;
}

/* 胜出绿条样式（数据无用，暂注释）
.bar-win {
  position: absolute;
  left: 0;
  top: 0;
  color: #3fb950;
  opacity: 0.3;
}
*/

.st-count {
  flex: 0 0 5ch;
  text-align: right;
  color: #e6edf3;
  font-weight: 700;
}

.st-pct {
  flex: 0 0 7ch;
  text-align: right;
}

/* 胜出数样式（数据无用，暂注释）
.st-win {
  flex: 0 0 5ch;
  text-align: right;
  color: #3fb950;
  font-weight: 700;
}
*/

/* 纯黑终端风：只有状态/kind 关键词有前景色，其余默认灰白，无边框无装饰 */
/* 占满剩余高度、滚动只在自身内部发生 */
.log-area {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: #000;
  color: #e6edf3;
  font-family: Consolas, Menlo, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.55;
  padding: 10px 12px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ---- 滚动条美化：简约细条，与终端风一致（只黑白灰） ---- */
.log-area::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.log-area::-webkit-scrollbar-track {
  background: transparent;
}

.log-area::-webkit-scrollbar-thumb {
  background: #30363d;
  border-radius: 4px;
}

.log-area::-webkit-scrollbar-thumb:hover {
  background: #484f58;
}

.log-area::-webkit-scrollbar-corner {
  background: transparent;
}

/* Firefox 滚动条 */
.log-area {
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}

.empty-hint {
  color: #6e7681;
}

.log-line {
  padding: 1px 0;
}

.dim {
  color: #6e7681;
}

.txt {
  color: #e6edf3;
}

.phase-p1 {
  color: #79c0ff;
  font-weight: 600;
}

.phase-p2 {
  color: #d2a8ff;
  font-weight: 600;
}

.status {
  font-weight: 700;
  min-width: 108px;
  display: inline-block;
  letter-spacing: 0.3px;
}

.progress {
  color: #484f58;
  margin-left: 2ch;
}

.kind {
  font-weight: 600;
  min-width: 48px;
  display: inline-block;
}

.err-line {
  color: #f85149;
  padding-left: 2ch;
  font-size: 12px;
}
</style>