<!-- ============================================================
     PCP RequestItem.vue - 请求项全生命周期可视化组件
     设计：
       - jxgj/trip 共用骨架，内容分块（均可独立折叠）：
         块1「请求参数」：预请求参数（入队时由 adapter.prepareRequest 挂上）
         块2「返回数据」：返回状态 + 信息 + 提要列表
         块3「按日期分类（携程请求预览）」：仅 jxgj，读贪心覆盖后的 date_obj
       - jxgj 提要：航班号 / 日期 / 人民币总价（取自 result.data.inputData.cangwei_arr）
       - jxgj 日期分类：每组 舱位 / 航班号 / 人民币总价（取自 date_obj，组数=携程请求数）
       - trip 参数：日期 / 航线 / 航司 / 舱位（preRequest + task.data.dateValue）
       - trip 提要：携程返回的全部报价条目（quoteRows），四态着色
         won 比赢 / lost 比输 / own 自有报价 / unmatched 未匹配，数据展示不丢任何条目
       - reserved 等其他平台通过 #params / #result 两个 slot 覆盖块内容
       - 头部：状态色点 + 预请求摘要 + 进度百分比 + 当前阶段
     数据源：task 对象（自带 stage/preRequest/result/error）
     ============================================================ -->
<template>
  <div class="req-item" :class="[`req-item--${stageGroup}`, `req-item--pf-${platform}`]">
    <!-- ===== 头部：状态色点 + 预请求摘要 + 进度 + 阶段名 ===== -->
    <div class="req-h">
      <span class="req-h-dot" :class="`dot--${stageGroup}`" />
      <span class="req-h-summary">
        <!-- jxgj：出发→到达 / 航司 -->
        <template v-if="platform === 'jxgj'">
          <span class="rh-route">{{ preq.depAirPort }}→{{ preq.arrAirPort }}</span>
          <span class="rh-carrier">{{ preq.carrier }}</span>
        </template>
        <!-- trip/reserved：航线 + 日期 / 航司 -->
        <template v-else>
          <span class="rh-route">{{ tripHead.route }}</span>
          <span class="rh-carrier">{{ tripHead.sub }}</span>
        </template>
      </span>
      <span class="req-h-progress">{{ Math.round(task.progress || 0) }}%</span>
      <span class="req-h-stage">{{ stageLabel }}</span>
    </div>

    <!-- ===== 块 1：请求参数（入队即有，全生命周期可见；可折叠）===== -->
    <div class="req-block" :class="{ 'is-collapsed': paramsCollapsed }">
      <div class="rb-title" @click="paramsCollapsed = !paramsCollapsed">
        <span class="rb-caret" :class="{ open: !paramsCollapsed }">▶</span>
        请求参数
      </div>
      <div v-show="!paramsCollapsed" class="rb-body">
        <!-- jxgj：出发机场 / 到达机场 / 航司（一行横排） -->
        <template v-if="platform === 'jxgj'">
          <div class="rb-kv rb-kv--inline">
            <span class="rb-group"><span class="rb-k">出发机场</span><span class="rb-v">{{ preq.depAirPort || '—' }}</span></span>
            <span class="rb-group"><span class="rb-k">到达机场</span><span class="rb-v">{{ preq.arrAirPort || '—' }}</span></span>
            <span class="rb-group"><span class="rb-k">航司</span><span class="rb-v">{{ preq.carrier || '—' }}</span></span>
          </div>
        </template>
        <!-- trip：日期 / 航线（机场→机场）/ 航司 / 舱位（一行横排）
             参数本体在 task.preRequest（segments 用城市码，是真正的请求入参）；
             机场/舱位从 task.data.dateValue[0] 取（同一请求覆盖的舱位航班组） -->
        <template v-else-if="platform === 'trip'">
          <div class="rb-kv rb-kv--inline">
            <span class="rb-group"><span class="rb-k">日期</span><span class="rb-v">{{ tripParams.date || '—' }}</span></span>
            <span class="rb-group"><span class="rb-k">航线</span><span class="rb-v">{{ tripParams.route || '—' }}</span></span>
            <span class="rb-group"><span class="rb-k">航司</span><span class="rb-v">{{ tripParams.carrier || '—' }}</span></span>
            <span class="rb-group rb-group--cw"><span class="rb-k">舱位</span><span class="rb-v">{{ tripParams.cabins || '—' }}</span></span>
          </div>
        </template>
        <!-- reserved 等其他平台：slot 覆盖，未覆盖时展示 preRequest JSON 或兜底文案 -->
        <template v-else>
          <slot name="params" :task="task" :preRequest="preq">
            <pre v-if="preq && Object.keys(preq).length">{{ JSON.stringify(preq, null, 2) }}</pre>
            <span v-else class="req-empty">参数未挂载</span>
          </slot>
        </template>
      </div>
    </div>

    <!-- ===== 块 2：返回数据（有结果/失败时才显示；可折叠）===== -->
    <div v-if="hasResult" class="req-block" :class="{ 'is-collapsed': resultCollapsed }">
      <div class="rb-title" @click="resultCollapsed = !resultCollapsed">
        <span class="rb-caret" :class="{ open: !resultCollapsed }">▶</span>
        返回数据
        <!-- trip 头部速览（折叠时也可见）：
             成功 = 状态 / 返回航班总数 / 匹配数（比赢+比输）/ 自有数；
             失败 = 仅状态（错误原因展开块内查看，避免标题挂一串无意义的 0） -->
        <span v-if="platform === 'trip'" class="rb-title-count rb-title-count--trip">
          <template v-if="isResultFail">{{ resultStatusText }}</template>
          <template v-else>
            {{ resultStatusText }} · 航班 {{ tripStats.flightCount }}
            · 匹配 {{ tripStats.won + tripStats.lost }} · 自有 {{ tripStats.own }}
          </template>
        </span>
      </div>
      <div v-show="!resultCollapsed" class="rb-body">
        <!-- 状态 + 信息：
             jxgj：折叠标题无总览，块内显示状态标签 + 信息
             trip：折叠标题已是总览（状态·航班·匹配·自有），成功时不再重复状态行；
                   失败时标题只有「失败」，块内保留一行错误原因 -->
        <div v-if="platform !== 'trip'" class="rb-status-line">
          <span class="rbs-tag" :class="resultTagClass">{{ resultStatusText }}</span>
          <span class="rbs-msg">{{ resultMsgText }}</span>
        </div>
        <div v-else-if="isResultFail" class="rb-status-line">
          <span class="rbs-msg rbs-msg--fail">{{ resultMsgText || '请求失败' }}</span>
        </div>

        <!-- jxgj：提要列表（航班号 / 日期 / 人民币总价） -->
        <template v-if="platform === 'jxgj'">
          <table v-if="jxgjFlights.length > 0" class="rb-table">
            <thead>
              <tr>
                <th>航班号</th>
                <th>日期</th>
                <th>人民币总价</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(f, i) in jxgjFlights" :key="i">
                <td>{{ f.flightNo }}</td>
                <td>{{ f.date }}</td>
                <td class="rb-price">¥{{ f.price }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="req-empty">无航班数据</div>
        </template>

        <!-- trip：套餐对套餐对比（我方锦绣套餐/主行 vs 携程按行李额分的报价）+ 无对应附加行 -->
        <template v-else-if="platform === 'trip'">
          <div v-if="!isResultFail" class="rb-summary-line">
            报价 {{ tripStats.total }} · 对比单元 {{ tripStats.compareTotal }}
            · 比赢 {{ tripStats.won }} · 比输 {{ tripStats.lost }}
            · 外显 {{ tripStats.ownShown }} · 未显 {{ tripStats.ownHidden }}
            · 未匹配 {{ tripStats.unmatched }} · 无对应 {{ tripStats.other }}
          </div>
          <!-- 每套餐一块：第 1 行官网数据，其后为该套餐匹配到的全部携程报价行，列一一对齐 -->
          <div v-if="!isResultFail" class="rb-legend">
            <span class="rbl-item"><i class="rbl-dot rbl-dot--ownShown" />我方外显</span>
            <span class="rbl-item"><i class="rbl-dot rbl-dot--ownHidden" />我方未显</span>
            <span class="rbl-item"><i class="rbl-dot rbl-dot--lost" />比输</span>
            <span class="rbl-item"><i class="rbl-dot rbl-dot--other" />未匹配/无对应</span>
            <span class="rbl-hint">每块=官网行（我方官价/底价+行李）+ 其下携程行（携程价+行李）· 标签 hover 看明细</span>
          </div>
          <table v-if="tripGroups.length > 0" class="rb-table rb-table--quotes">
            <thead>
              <tr>
                <th>匹配结果</th>
                <th>航线</th>
                <th>舱位</th>
                <th>我方</th>
                <th>我方行李</th>
                <th>携程价</th>
                <th>携程行李</th>
              </tr>
            </thead>
            <tbody v-for="g in tripGroups" :key="g.key">
              <tr
                v-for="(f, i) in g.rows"
                :key="`${g.key}-${i}`"
                :class="['qrow', `qrow--${f.status}`, `qrow--${f.role}`]"
              >
                <td>
                  <span
                    class="rb-outcome"
                    :class="`rb-outcome--${f.status}`"
                    :title="f.unmatchedReason?.detail || f.note || ''"
                  >{{ f.statusText }}</span>
                </td>
                <td class="qm-route-cell">
                  <div class="qm-flight">{{ f.flightNo }}</div>
                  <div class="qm-route">{{ g.route }}</div>
                </td>
                <td>{{ f.cabinLabel }}</td>
                <td class="rb-price">
                  <template v-if="f.role === 'official'">
                    <div>{{ f.ourPrice == null ? '—' : `¥${f.ourPrice}` }} 官</div>
                    <div>{{ f.ourFloor == null ? '—' : `¥${f.ourFloor}` }} 底</div>
                  </template>
                  <template v-else>—</template>
                </td>
                <td class="rb-baggage">{{ f.role === 'official' ? (f.ourBaggageShort || '—') : '—' }}</td>
                <td class="rb-price">
                  <span v-if="f.role === 'official' && f.kind !== 'other' && f.status === 'unmatched'" class="rb-nodrop">无人投放</span>
                  <template v-else>{{ f.xcPrice == null ? '—' : `¥${f.xcPrice}` }}</template>
                </td>
                <td class="rb-baggage" :title="f.xcBaggage">{{ f.xcBaggageShort || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="req-empty">无报价数据</div>
        </template>

        <!-- reserved 等其他平台：slot 覆盖，未覆盖时展示 result JSON -->
        <template v-else>
          <slot name="result" :task="task" :result="task.result">
            <pre v-if="task.result">{{ formatJson(task.result) }}</pre>
            <span v-else class="req-empty">无返回数据</span>
          </slot>
        </template>
      </div>
    </div>

    <!-- ===== 块 3：按日期分类（携程请求预览；仅 jxgj，有结果时显示，默认折叠）=====
         数据源：mergeResult 贪心集合覆盖后的 date_obj（已剔除重复舱位、日期数最少）
         每个日期组后续会拆成一个携程请求，故日期组数 = 携程请求数 -->
    <div v-if="platform === 'jxgj' && hasResult" class="req-block" :class="{ 'is-collapsed': datesCollapsed }">
      <div class="rb-title" @click="datesCollapsed = !datesCollapsed">
        <span class="rb-caret" :class="{ open: !datesCollapsed }">▶</span>
        按日期分类（携程请求预览）
        <span class="rb-title-count">{{ jxgjDateGroups.length }} 个日期</span>
      </div>
      <div v-show="!datesCollapsed" class="rb-body">
        <div v-if="jxgjDateGroups.length > 0" class="rb-date-groups">
          <div v-for="g in jxgjDateGroups" :key="g.date" class="rb-date-group">
            <div class="rdg-head">{{ g.date }}<span class="rdg-count">（{{ g.items.length }} 个舱位）</span></div>
            <table class="rb-table">
              <thead>
                <tr>
                  <th>舱位</th>
                  <th>航班号</th>
                  <th>人民币总价</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(f, i) in g.items" :key="i">
                  <td>{{ f.cw }}</td>
                  <td>{{ f.flightNo }}</td>
                  <td class="rb-price">¥{{ f.price }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else class="req-empty">无日期数据</div>
      </div>
    </div>

    <!-- ===== 错误提示（failed 终态，无 result 时的兜底错误展示）===== -->
    <div v-if="task.stage === 'failed' && task.error && !hasResult" class="req-error">
      <span class="re-icon">✗</span>
      <span class="re-msg">{{ task.error }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  task: { type: Object, required: true },
  platform: { type: String, default: 'jxgj' }, // 'jxgj' | 'trip' | 'reserved'
  // 外置 UI 状态 map（虚拟列表场景必填）：{ [taskId]: { params, result, dates, flights: string[] } }
  // 虚拟列表只渲染可见项，滚出视口的组件会被销毁重建，折叠状态必须放外面才能跨回收保持；
  // 为 null 时退回组件本地 ref（组件独立使用不受影响）
  uiState: { type: Object, default: null }
})

// ===== 内容块折叠状态（三块独立）=====
//   请求参数块默认展开（入队即可扫到参数）
//   返回数据块默认折叠（避免长列表刷屏；需要时点标题展开查看状态/航班提要）
//   按日期分类默认折叠（标题上直接显示日期组数供快速扫视）
// 本地兜底状态（未传 uiState 时使用）
const _localParams = ref(false)
const _localResult = ref(true)
const _localDates = ref(true)

// 折叠布尔状态的统一读写：有外置 map 按 task.id 存取（惰性建条目），否则走本地 ref
const _localMap = { params: _localParams, result: _localResult, dates: _localDates }
function _collapsed(field, def) {
  return computed({
    get() {
      const map = props.uiState
      if (!map) return _localMap[field].value
      const e = map[props.task.id]
      return e ? e[field] ?? def : def
    },
    set(v) {
      const map = props.uiState
      if (!map) {
        _localMap[field].value = v
        return
      }
      const e = map[props.task.id] || (map[props.task.id] = {})
      e[field] = v
    }
  })
}
const paramsCollapsed = _collapsed('params', false)
const resultCollapsed = _collapsed('result', true)
const datesCollapsed = _collapsed('dates', true)

// 预请求参数（task.preRequest）
const preq = computed(() => props.task.preRequest || {})

// ===== trip 头部摘要：航线（机场→机场）+ 日期 / 航司 =====
//   机场取自 task.data.dateValue[0]（与锦绣同源的 jxgj 航班项）；
//   日期取 dateKey；航司取 preRequest.validatingCarrier（= H航司名，真正的请求入参）
const tripHead = computed(() => {
  const dv = props.task.data?.dateValue
  const first = Array.isArray(dv) && dv.length > 0 ? dv[0] : null
  const dep = first?.['C出发机场'] || ''
  const arr = first?.['D到达机场'] || ''
  const date = props.task.data?.dateKey || ''
  const carrier = preq.value.validatingCarrier || ''
  const route = dep && arr ? `${dep}→${arr}${date ? ' ' + date : ''}` : (props.task.data?.id || '')
  return { route, sub: carrier }
})

// ===== trip 请求参数（块1）=====
//   日期：dateKey（= segments[0].departDate）
//   航线：机场→机场（业务视角；请求入参 segments 用的是城市码，挂在 preRequest 上）
//   航司：validatingCarrier（开票航司 = H航司名）
//   舱位：该日期组覆盖的全部舱位（去重保序，一个 trip 请求覆盖多舱位）
const tripParams = computed(() => {
  const dv = props.task.data?.dateValue
  const list = Array.isArray(dv) ? dv : []
  const first = list[0] || null
  const cabins = [...new Set(list.map(x => x?.['C舱位']).filter(Boolean))].join(',')
  return {
    date: props.task.data?.dateKey || preq.value.segments?.[0]?.departDate || '',
    route: first?.['C出发机场'] && first?.['D到达机场']
      ? `${first['C出发机场']}→${first['D到达机场']}`
      : '',
    carrier: preq.value.validatingCarrier || first?.['H航司名'] || '',
    cabins
  }
})

// 当前阶段名（中文显示）
const stageLabel = computed(() => {
  const map = {
    idle: '待执行', credential: '取账密', login: '登录', prepare: '组参',
    request: '请求中', merge: '交叉中', done: '完成', failed: '失败', skipped: '跳过'
  }
  return map[props.task.stage] || props.task.stage
})

// 阶段分组（用于颜色）
const stageGroup = computed(() => {
  const s = props.task.stage
  if (s === 'done') return 'done'
  if (s === 'failed') return 'failed'
  if (s === 'skipped') return 'skipped'
  if (s === 'idle') return 'idle'
  return 'running' // credential/login/prepare/request/merge 都是进行中
})

// ===== 返回数据：状态 / 信息 =====
//   jxgj mergeResult：{status:'success', resultCode:'0000', resultMsg:'处理成功', data:{...}}
//   trip mergeResult：{status:'ok', code:200, message:'success', processedData, summary:{...}}
//   BUG-4 无日期分支：{status:'ok', reason:'...'}
//   失败时 task.result = {error:'...'}
const hasResult = computed(() => !!props.task.result)

const resultStatusText = computed(() => {
  const r = props.task.result
  if (!r) return ''
  if (r.error) return '失败'
  // 成功态归一化：jxgj success / trip ok → 「成功」，附带各自 code
  const okStatus = r.status === 'success' || r.status === 'ok'
  const code = r.resultCode || r.code ? ` ${r.resultCode || r.code}` : ''
  return okStatus ? `成功${code}` : (r.status || '未知')
})

const resultMsgText = computed(() => {
  const r = props.task.result
  if (!r) return ''
  return r.resultMsg || r.message || r.reason || r.error || ''
})

const resultTagClass = computed(() => {
  const r = props.task.result
  if (!r) return ''
  if (r.error || r.status === 'error' || r.status === 'failed') return 'rbs-tag--fail'
  return 'rbs-tag--ok'
})

// trip 专用：标题总览只显示「失败」二字，块内据此决定是否展开错误原因行
const isResultFail = computed(() => resultTagClass.value === 'rbs-tag--fail')

// ===== jxgj 提要列表：航班号 / 日期 / 人民币总价 =====
//   数据源：result.data.inputData.cangwei_arr（mergeResult 中 cangwei_arr 每项一个舱位匹配行）
//   字段：H航班号 / C出发日期 / C成人总票价_CNY_INT（geshihua 已处理为整数）
const jxgjFlights = computed(() => {
  const arr = props.task.result?.data?.inputData?.cangwei_arr
  if (!Array.isArray(arr)) return []
  return arr.map(item => ({
    flightNo: item['H航班号'] ?? '—',
    date: item['C出发日期'] ?? '—',
    price: item['C成人总票价_CNY_INT'] ?? '—'
  }))
})

// ===== jxgj 按日期分类（携程请求预览）=====
//   数据源：result.data.inputData.date_obj（mergeResult 贪心集合覆盖后的分组）
//   对象转数组并按日期升序（YYYY-MM-DD 字典序 = 时间序），保证展示顺序稳定
//   每组项：舱位 C舱位 / 航班号 H航班号 / 人民币总价 C成人总票价_CNY_INT
const jxgjDateGroups = computed(() => {
  const dateObj = props.task.result?.data?.inputData?.date_obj
  if (!dateObj || typeof dateObj !== 'object') return []
  return Object.keys(dateObj)
    .sort()
    .map(date => ({
      date,
      items: (dateObj[date] || []).map(item => ({
        cw: item['C舱位'] ?? '—',
        flightNo: item['H航班号'] ?? '—',
        price: item['C成人总票价_CNY_INT'] ?? '—'
      }))
    }))
})

// JSON 展示辅助：剔除调试字段
function formatJson(obj) {
  if (!obj) return ''
  const { _usedCredential, ...rest } = obj
  return JSON.stringify(rest, null, 2)
}

// ===== trip 套餐对套餐对比行 =====
//   数据源：mergeResult.quoteRows（我方对比单元 main/package + 附加行 other）
//   状态：won 比赢 / lost 比输 / ownShown 外显 / ownHidden 未显 / unmatched 未匹配 / other 无对应
const QUOTE_STATUS_TEXT = {
  won: '比赢',
  lost: '比输',
  ownShown: '外显',
  ownHidden: '未显',
  unmatched: '未匹配',
  other: '无对应'
}

// 未匹配首因 → 标签短文案（人话明细在 unmatchedReason.detail / note，hover 标签看）
const UNMATCH_REASON_TEXT = {
  flight: '无此航班',
  baggage: '行李不符',
  price: '价格异常'
}

const tripRows = computed(() => {
  const r = props.task.result
  if (!Array.isArray(r?.quoteRows)) return []
  return r.quoteRows.map(q => {
    const reason = q.unmatchedReason?.reason
    const role = q.role ?? 'other'
    return {
      role,
      unitKey: q.unitKey ?? null,
      kind: q.kind ?? 'other',
      status: q.status,
      // 未匹配行：标签直接写首个不通过的参数；无诊断信息时回退「未匹配」
      statusText: q.status === 'unmatched'
        ? (UNMATCH_REASON_TEXT[reason] || '未匹配')
        : (QUOTE_STATUS_TEXT[q.status] || q.status),
      flightNo: q.flightNo ?? '—',
      date: q.date ?? '—',
      dep: q.depAirport ?? '—',
      arr: q.arrAirport ?? '—',
      // 舱位列：官网行=舱位+单元标记；携程行=侧标记；附加行=携程舱位
      cabinLabel: role === 'ctrip'
        ? '↳ 携程'
        : (q.kind === 'main'
          ? `${q.seatClass ?? '—'}·主行`
          : (q.kind === 'package'
            ? `${q.seatClass ?? '—'}${q.pkgIndex != null ? `·套餐${q.pkgIndex}` : ''}`
            : (q.seatClass ?? '—'))),
      ourBaggageShort: q.ourBaggageShort ?? '—',
      ourPrice: q.ourPrice ?? null,
      ourFloor: q.ourFloor ?? null,
      xcPrice: q.xcPrice ?? '—',
      xcBaggage: q.xcBaggage ?? '',
      xcBaggageShort: q.xcBaggageShort ?? '—',
      note: q.note ?? '',
      isOwn: !!q.isOwn,
      shown: !!q.shown,
      flagRemark: q.flagRemark ?? '',
      unmatchedReason: q.unmatchedReason ?? null
    }
  })
})

// ===== trip 分块归组：按 unitKey（每套餐一块=官网行+其携程行；附加行各自成块）=====
const tripGroups = computed(() => {
  const map = new Map()
  for (const row of tripRows.value) {
    const key = row.unitKey || `other|${row.flightNo}|${row.date}|${row.dep}|${row.arr}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        route: row.dep !== '—' && row.arr !== '—' ? `${row.dep}→${row.arr}` : '',
        rows: []
      })
    }
    map.get(key).rows.push(row)
  }
  return [...map.values()]
})

// trip 返回统计：summary 双口径（携程全部报价平铺 + 对比单元/附加行）
const tripStats = computed(() => {
  const s = props.task.result?.summary || {}
  return {
    flightCount: s.flightCount ?? 0,
    lowPriceCount: s.lowPriceCount ?? 0,
    total: s.quoteTotal ?? 0,
    compareTotal: s.compareTotal ?? 0,
    won: s.quoteWon ?? 0,
    lost: s.quoteLost ?? 0,
    own: s.quoteOwn ?? 0,
    ownShown: s.quoteOwnShown ?? 0,
    ownHidden: s.quoteOwnHidden ?? 0,
    unmatched: s.quoteUnmatched ?? 0,
    other: s.otherCount ?? 0
  }
})
</script>

<style scoped>
/* ============================================================
   RequestItem 视觉系统（v2 重构——多级数据清晰可读）
   设计令牌
     间距阶：4 · 6 · 8 · 10 · 12 · 16 · 20
     背景层级（外→内，仅 4 层，每层语义明确）：
       卡片浅彩（平台锚点） → 头部加深 → 内容区白（反白突出数据）→ 航班块极浅灰
     边框层级（外→内，仅 3 层，粗细递减）：
       卡片边+3px 左色条 → 块标题底边线 → 航班块弱描边 → 单元格分隔线
     状态色（行背景）：绿=我方外显 / 黄=我方未显 / 棕红=比输 / 透明=比赢·未匹配
     子项层级：套餐子行用 3px 左缩进条 + 略浅底 + 字号略小，明确从属主行
   ============================================================ */
.req-item {
  --gap-block: 10px;
  --pad-card-y: 10px;
  --pad-card-x: 12px;
  --pad-title-y: 8px;
  --pad-title-x: 12px;
  --pad-body: 12px;
  --pad-cell-y: 7px;
  --pad-cell-x: 10px;
  --bg-content: #ffffff;
  --bg-block: #f8f9fb;
  --bg-soft: #fafbfc;
  --border-card: #ececec;
  --border-block: #d9dde3;
  --border-soft: #ececef;
  --border-softer: #f5f5f5;
  display: flex;
  flex-flow: column nowrap;
  gap: var(--gap-block);
  padding: var(--pad-card-y) var(--pad-card-x);
  border: 1px solid var(--border-card);
  border-left-width: 3px;
  border-radius: 4px;
  background: #fff;
  font-size: 13px;
  line-height: 1.5;
}

/* 平台色条 + 整圈彩色边框 + 卡片浅彩底（远距离即可识别归属）*/
.req-item--pf-jxgj { border-color: #91caff; border-left: 3px solid #1890ff; background: #f7faff; }
.req-item--pf-trip { border-color: #ffbb96; border-left: 3px solid #fa8c16; background: #fff9f2; }
.req-item--pf-reserved { border-left-color: #bfbfbf; }

/* 头部色带：负边距撑满卡片宽度，比卡片体深一档；与块之间留 --gap-block 间距 */
.req-item--pf-jxgj .req-h {
  background: #e8f2ff;
  margin: calc(-1 * var(--pad-card-y)) calc(-1 * var(--pad-card-x)) var(--gap-block);
  padding: var(--pad-title-y) var(--pad-title-x);
  border-radius: 3px 3px 0 0;
}
.req-item--pf-trip .req-h {
  background: #fff1de;
  margin: calc(-1 * var(--pad-card-y)) calc(-1 * var(--pad-card-x)) var(--gap-block);
  padding: var(--pad-title-y) var(--pad-title-x);
  border-radius: 3px 3px 0 0;
}
.req-item--pf-trip .rh-route { color: #d46b08; }

/* ===== 头部 ===== */
.req-h {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 10px;
}

.req-h-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot--idle    { background: #ccc; }
.dot--running { background: #1890ff; animation: pulse 1.2s infinite; }
.dot--done    { background: #52c41a; }
.dot--failed  { background: #f5222d; }
.dot--skipped { background: #faad14; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.req-h-summary {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.rh-route {
  font-family: 'Consolas', 'Menlo', monospace;
  color: #1890ff;
  font-weight: 600;
  white-space: nowrap;
}

.rh-carrier {
  color: #666;
  font-size: 12px;
}

.req-h-progress {
  color: #999;
  font-size: 12px;
  font-family: 'Consolas', 'Menlo', monospace;
  flex-shrink: 0;
}

.req-h-stage {
  color: #666;
  font-size: 12px;
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.55);
}

/* ===== 内容块（请求参数 / 返回数据 / 按日期分类）=====
   ★ 关键：块不用边框——靠内容区反白（白）与卡片浅彩底形成层级；
   标题栏承担分隔职责（底边线 + 弱背景，是块的开头） */
.req-block {
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-content);
}

.rb-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--pad-title-y) var(--pad-title-x);
  font-size: 11px;
  color: #888;
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
  user-select: none;

  &:hover {
    background: #f5f6f8;
  }
}

.rb-caret {
  display: inline-block;
  font-size: 10px;
  color: #aaa;
  transition: transform 0.15s ease;
  transform: rotate(0deg);

  &.open {
    transform: rotate(90deg);
  }
}

.rb-title-count {
  margin-left: auto;
  font-size: 11px;
  color: #1890ff;
  font-weight: 500;
}

.rb-title-count--trip {
  min-width: 0;
  color: #888;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.req-block.is-collapsed .rb-title {
  border-bottom: none;
}

.rb-body {
  padding: var(--pad-body);
}

/* 键值对 */
.rb-kv {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.7;
}

.rb-kv--inline {
  flex-wrap: wrap;
  row-gap: 4px;
  column-gap: 16px;
}

.rb-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.rb-kv--inline .rb-k {
  flex: 0 0 auto;
}

.rb-k {
  flex: 0 0 60px;
  color: #999;
}

.rb-v {
  color: #333;
  font-family: 'Consolas', 'Menlo', monospace;
}

/* 返回数据：状态行 */
.rb-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12px;
}

.rbs-tag {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}

.rbs-tag--ok {
  color: #389e0d;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
}

.rbs-tag--fail {
  color: #cf1322;
  background: #fff1f0;
  border: 1px solid #ffa39e;
}

.rbs-msg {
  color: #555;
}

.rbs-msg--fail {
  color: #cf1322;
  word-break: break-all;
}

/* trip 返回统计行：加浅灰容器，与图例形成"返回数据开头的两条信息条" */
.rb-summary-line {
  margin-bottom: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: #555;
  background: var(--bg-soft);
  border-radius: 3px;
}

.rb-outcome {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.rb-outcome--won {
  color: #389e0d;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
}

.rb-outcome--lost {
  color: #d46b08;
  background: #fff7e6;
  border: 1px solid #ffd591;
}

.rb-outcome--ownShown {
  color: #237804;
  background: #d9f7be;
  border: 1px solid #95de64;
}

.rb-outcome--ownHidden {
  color: #ad6800;
  background: #fff1b8;
  border: 1px solid #ffd666;
}

.rb-outcome--unmatched {
  color: #8c8c8c;
  background: #fafafa;
  border: 1px solid #e0e0e0;
}

.rb-outcome--other {
  color: #8c8c8c;
  background: #fafafa;
  border: 1px dashed #d9d9d9;
}

/* ===== 套餐对套餐对比表 ===== */
.rb-table--quotes {
  table-layout: fixed;

  th:nth-child(1) { width: 76px; }
  th:nth-child(2) { width: 18%; }
  th:nth-child(3) { width: 68px; }
  th:nth-child(4) { width: 68px; }
  th:nth-child(5) { width: 56px; }
  th:nth-child(6) { width: 64px; }
  th:nth-child(7) { width: 56px; }

  th,
  tr.qrow > td {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.rb-baggage {
  color: #999 !important;
  font-size: 11px !important;
}

.rb-nodrop {
  color: #bbb;
  font-size: 11px;
}

/* ===== 航班块（tbody）层级分隔 =====
   tbody 不渲染 margin/border/border-radius，靠 td 拼接：
   - 块整体极浅灰底（与白内容区微差，可见但不抢眼）
   - 块四周 1px 弱描边（不再是 2px 灰描边，收敛）
   - 块间距 8px（用内容区白色作槽，比之前 14px 灰槽更安静）
   - 比赢/未匹配行透明露出块底；绿/黄/棕红状态行保留自身色 */
.rb-table--quotes tbody {
  background: var(--bg-block);
}
.rb-table--quotes tbody td:first-child { border-left: 1px solid var(--border-block); }
.rb-table--quotes tbody td:last-child  { border-right: 1px solid var(--border-block); }
.rb-table--quotes tbody tr:first-child > td {
  border-top: 1px solid var(--border-block);
}
.rb-table--quotes tbody:not(:first-child) tr:first-child > td {
  border-top: 8px solid var(--bg-content);
  box-shadow: inset 0 1px 0 var(--border-block);
}
.rb-table--quotes tbody tr:last-child > td {
  border-bottom: 1px solid var(--border-block);
}
.rb-table--quotes thead th {
  border-bottom: 1px solid var(--border-soft);
}

.qm-route-cell {
  white-space: normal;
  line-height: 1.3;
}

.qm-flight {
  font-weight: 600;
}

.qm-route {
  color: #999;
  font-size: 11.5px;
}

/* 状态行背景：透明=比赢/未匹配，露出块浅灰底；附加行（非我方投放）灰字弱化 */
tr.qrow--ownShown > td { background: #f6ffed; }
tr.qrow--ownHidden > td { background: #fffbe6; }
tr.qrow--lost > td { background: #fbe4dc; }
tr.qrow--won > td,
tr.qrow--unmatched > td { background: transparent; }
tr.qrow--other:not(.qrow--ownShown):not(.qrow--ownHidden) > td { background: transparent; color: #8c8c8c; }

/* 图例：加浅灰容器，与统计行视觉一致 */
.rb-legend {
  display: flex;
  flex-flow: row wrap;
  gap: 12px;
  margin-bottom: 10px;
  padding: 6px 10px;
  font-size: 11px;
  color: #888;
  background: var(--bg-soft);
  border-radius: 3px;
}

.rbl-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.rbl-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid transparent;
}

.rbl-dot--ownShown  { background: #f6ffed; border-color: #95de64; }
.rbl-dot--ownHidden { background: #fffbe6; border-color: #ffd666; }
.rbl-dot--lost      { background: #fbe4dc; border-color: #d4876f; }
.rbl-dot--other     { background: var(--bg-block); border-color: var(--border-block); }

.rbl-hint {
  color: #bbb;
  flex: 1 1 100%;
  margin-top: 2px;
}

.rb-group--cw {
  flex: 1 1 120px;
  min-width: 0;

  .rb-v {
    white-space: normal;
    word-break: break-all;
  }
}

/* 提要表 */
.rb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  th, td {
    padding: var(--pad-cell-y) var(--pad-cell-x);
    text-align: left;
    border-bottom: 1px solid var(--border-softer);
  }

  th {
    color: #999;
    font-weight: 500;
    background: var(--bg-soft);
  }

  td {
    color: #333;
    font-family: 'Consolas', 'Menlo', monospace;
  }
}

.rb-price {
  color: #f5222d;
  font-weight: 600;
}

/* 按日期分组（携程请求预览）：每组加容器，组间间距明确 */
.rb-date-groups {
  display: flex;
  flex-flow: column nowrap;
  gap: 12px;
}

.rb-date-group {
  padding: 10px;
  background: var(--bg-soft);
  border-radius: 3px;
}

.rdg-head {
  font-size: 12px;
  font-weight: 600;
  color: #333;
  padding: 0 0 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--border-soft);
}

.rdg-count {
  font-weight: 400;
  color: #999;
}

.rb-body pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-soft);
  border-radius: 3px;
  font-family: 'Consolas', 'Menlo', monospace;
  font-size: 11px;
  color: #555;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.req-empty {
  color: #bbb;
  font-size: 12px;
  padding: 4px 0;
}

/* ===== 错误提示 ===== */
.req-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #fff1f0;
  border: 1px solid #ffa39e;
  border-radius: 3px;
  font-size: 12px;
  color: #f5222d;
}

.re-icon {
  font-weight: bold;
}
</style>
