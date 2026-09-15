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
       - o2/o3 通过 #params / #result 两个 slot 覆盖块内容
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
        <!-- trip/o2/o3：航线 + 日期 / 航司 -->
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
        <!-- o2/o3 等其他平台：slot 覆盖，未覆盖时展示 preRequest JSON 或兜底文案 -->
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

        <!-- trip：携程返回的全部报价条目（won/lost/own/unmatched 四态着色，一条不丢） -->
        <template v-else-if="platform === 'trip'">
          <!-- 标题总览已含 航班/匹配(比赢+比输)/自有，此处只补充：低价套餐 / 报价 / 外显 / 未显 / 未匹配
               失败时无报价数据，整行不显示（错误原因已在上方状态行） -->
          <div v-if="!isResultFail" class="rb-summary-line">
            低价套餐 {{ tripStats.lowPriceCount }} · 报价 {{ tripStats.total }}
            · 外显 {{ tripStats.ownShown }} · 未显 {{ tripStats.ownHidden }}
            · 未匹配 {{ tripStats.unmatched }}
          </div>
          <!-- 配色图例：仿携程 OTA——绿=我方投放且外显，黄=我方投放未外显，白=他人投放
               比赢/比输/未匹配写在「结果」列标签里 -->
          <div v-if="!isResultFail" class="rb-legend">
            <span class="rbl-item"><i class="rbl-dot rbl-dot--ownShown" />我方外显</span>
            <span class="rbl-item"><i class="rbl-dot rbl-dot--ownHidden" />我方未显</span>
            <span class="rbl-item"><i class="rbl-dot rbl-dot--lost" />比输</span>
            <span class="rbl-item"><i class="rbl-dot rbl-dot--other" />他人投放</span>
            <span class="rbl-hint">点击航班行展开：蓝行为锦绣官网对比数据 · 未匹配标签为首个不符参数（hover 看明细）</span>
          </div>
          <!-- 仿携程 OTA：每个航班一条主行（quantifyFlagRemark=initSelected 那条，
               无 init 标记则组内首条），列与套餐行完全一致；点主行展开该航班全部套餐 -->
          <table v-if="tripGroups.length > 0" class="rb-table rb-table--quotes">
            <thead>
              <tr>
                <th>匹配结果</th>
                <th>航线</th>
                <th>舱位</th>
                <th>携程底价</th>
                <th>行李</th>
              </tr>
            </thead>
            <tbody v-for="g in tripGroups" :key="g.key">
              <!-- 对比基准：与该航班对比的我方锦绣官网条目（航班块上方，折叠时也常显）
                   5 列与携程数据行对齐：官网标签 / 航班+航线换行 / 舱位 / 价格+底价换行 / 行李 -->
              <tr v-if="g.ourBasis" class="qrow-basis">
                <td><span class="qb-tag">官网</span></td>
                <td class="qm-route-cell">
                  <div class="qm-flight">{{ g.ourBasis.flightNo }}</div>
                  <div class="qm-route">{{ g.ourBasis.route }}</div>
                </td>
                <td>{{ g.ourBasis.cabin }}</td>
                <td class="rb-price qb-price-floor">
                  <div>{{ g.ourBasis.price == null ? '—' : `¥${g.ourBasis.price}` }} 官 </div>
                  <div>{{ g.ourBasis.floor == null ? '—' : `¥${g.ourBasis.floor}` }} 底 </div>
                </td>
                <td class="rb-baggage">{{ g.ourBasis.baggageShort || '—' }}</td>
              </tr>
              <!-- 主行：OTA 展示行本身（普通数据行，点击展开/收起套餐） -->
              <tr
                class="qrow qrow--main"
                :class="`qrow--${g.head.status}`"
                @click="toggleFlight(g.key)"
              >
                <td>
                  <span
                    class="rb-outcome"
                    :class="`rb-outcome--${g.head.status}`"
                    :title="g.head.unmatchedReason?.detail || ''"
                    @click.stop
                  >{{ g.head.statusText }}</span>
                </td>
                <td class="qm-route-cell">
                  <div class="qm-flight">{{ g.head.flightNo }}</div>
                  <div class="qm-route">{{ g.route }}</div>
                </td>
                <td>{{ g.head.cw }}</td>
                <td class="rb-price">{{ g.head.xcPrice === '—' ? '—' : `¥${g.head.xcPrice}` }}</td>
                <td class="rb-baggage" :title="g.head.baggage">{{ g.head.baggageShort }}</td>
              </tr>
              <!-- 套餐子行：该航班除主行（OTA 选中行）外的其余套餐；航线列留空体现层级 -->
              <tr
                v-for="(f, i) in g.children"
                v-show="!flightCollapsed.has(g.key)"
                :key="`${g.key}-${i}`"
                :class="['qrow', 'qrow-child', `qrow--${f.status}`]"
              >
                <td>
                  <!-- 未匹配：标签直接写首个不通过的参数，hover 看双方对比明细 -->
                  <span
                    class="rb-outcome"
                    :class="`rb-outcome--${f.status}`"
                    :title="f.unmatchedReason?.detail || ''"
                  >{{ f.statusText }}</span>
                </td>
                <td></td>
                <td>{{ f.cw }}</td>
                <td class="rb-price">{{ f.xcPrice === '—' ? '—' : `¥${f.xcPrice}` }}</td>
                <td class="rb-baggage" :title="f.baggage">{{ f.baggageShort }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="req-empty">无报价数据</div>
        </template>

        <!-- o2/o3 等其他平台：slot 覆盖，未覆盖时展示 result JSON -->
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
  platform: { type: String, default: 'jxgj' } // 'jxgj' | 'trip' | 'o2' | 'o3'
})

// ===== 内容块折叠状态（三块独立）=====
//   请求参数块默认展开（入队即可扫到参数）
//   返回数据块默认折叠（避免长列表刷屏；需要时点标题展开查看状态/航班提要）
const paramsCollapsed = ref(false)
const resultCollapsed = ref(true)
// 按日期分类（携程请求预览）：默认折叠，标题上直接显示日期组数供快速扫视
const datesCollapsed = ref(true)

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

// ===== trip 全量报价列表 =====
//   首选数据源：mergeResult 新增的 quoteRows（携程 lowPrices.prices 全量枚举，五态标注）
//   兜底：旧结果（落盘的历史任务，无 quoteRows）→ 从 processedData 映射命中行，标 won/lost
//   五态：won 比赢 / lost 比输（他人报价被我方命中）
//         ownShown 我方外显（绿）/ ownHidden 我方未显（黄）/ unmatched 他人未命中（白）
const QUOTE_STATUS_TEXT = {
  won: '比赢',
  lost: '比输',
  ownShown: '外显',
  ownHidden: '未显',
  unmatched: '未匹配'
}

// 未匹配首因 → 标签短文案（人话明细在 unmatchedReason.detail，hover 标签看）
const UNMATCH_REASON_TEXT = {
  flight: '无此航班',
  cabin: '舱位不符',
  baggage: '行李不符',
  price: '价格异常'
}

const tripRows = computed(() => {
  const r = props.task.result
  if (Array.isArray(r?.quoteRows)) {
    return r.quoteRows.map(q => {
      const reason = q.unmatchedReason?.reason
      return {
        status: q.status,
        // 未匹配行：标签直接写首个不通过的参数；无诊断信息（旧数据）时回退「未匹配」
        statusText: q.status === 'unmatched'
          ? (UNMATCH_REASON_TEXT[reason] || '未匹配')
          : (QUOTE_STATUS_TEXT[q.status] || q.status),
        cw: q.seatClass ?? '—',
        flightNo: q.flightNo ?? '—',
        date: q.date ?? '—',
        dep: q.depAirport ?? '—',
        arr: q.arrAirport ?? '—',
        xcPrice: q.sortIndicator ?? '—',
        ourFloor: q.ourFloor ?? null,
        ourPrice: q.ourPrice ?? null,
        // ★ 锦绣官网对比基准行：adapter.js 在 quoteRows 已挂 ourBasis（航班/航线/舱位/价格/底价/行李），
        //   必须透传到行对象，否则 tripGroups 取不到 → 对比行 <tr v-if="g.ourBasis"> 永远不渲染
        ourBasis: q.ourBasis ?? null,
        baggage: q.baggage ?? '',
        baggageShort: q.baggageShort ?? '—',
        isInit: !!q.isInit,
        // ★ 我方投放标记 + 外显标记：adapter.js 在 quoteRows 已挂 isOwn 和 shown
        //   （shown = showState===1，即该报价在售卖平台实际外显）
        //   胜出率判定：航班组内至少一条 isOwn && shown 才算有效（仅投放未外显不算胜出）
        isOwn: !!q.isOwn,
        shown: !!q.shown,
        flagRemark: q.flagRemark ?? '',
        unmatchedReason: q.unmatchedReason ?? null
      }
    })
  }
  // 旧结果兼容：只可能有命中行（无 showState/行李短文案）
  const arr = r?.processedData
  if (!Array.isArray(arr)) return []
  return arr.map(item => {
    const outcome = item['_outcome'] || 'won'
    return {
      status: outcome,
      statusText: QUOTE_STATUS_TEXT[outcome] || outcome,
      cw: item['C舱位'] ?? '—',
      flightNo: item['H航班号'] ?? '—',
      date: item['C出发日期'] ?? '—',
      dep: item['C出发机场'] ?? '—',
      arr: item['D到达机场'] ?? '—',
      xcPrice: item['XC_dijia'] ?? '—',
      ourFloor: item['dijia'] ?? null,
      ourPrice: item['C成人总票价_CNY_INT'] ?? null,
      baggage: '',
      baggageShort: '—',
      isInit: false,
      flagRemark: '',
      unmatchedReason: null
    }
  })
})

// ===== trip 按航班分组（仿携程 OTA：主行=OTA 展示行，点击展开该航班全部套餐）=====
//   分组键：航班号|日期|出发|到达；组顺序=报价首次出现顺序（携程返回序）
//   head：quantifyFlagRemark 含 initSelected 的那条行对象，没有则回退组内首条
const tripGroups = computed(() => {
  const map = new Map()
  for (const row of tripRows.value) {
    const key = `${row.flightNo}|${row.date}|${row.dep}|${row.arr}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        route: row.dep !== '—' && row.arr !== '—' ? `${row.dep}→${row.arr}` : '',
        rows: []
      })
    }
    map.get(key).rows.push(row)
  }
  const groups = [...map.values()]
  for (const g of groups) {
    // 主行=OTA 选中行（initSelected，无标记则首条）；子行=其余套餐，主行不在展开区重复
    g.head = g.rows.find(r => r.isInit) || g.rows[0]
    g.children = g.rows.filter(r => r !== g.head)
    // 对比基准（锦绣官网那条）：优先取比赢/比输行记录的命中条目，其次任一行携带的同航班条目
    g.ourBasis =
      g.rows.find(r => (r.status === 'won' || r.status === 'lost') && r.ourBasis)?.ourBasis ||
      g.rows.find(r => r.ourBasis)?.ourBasis ||
      null
  }
  return groups
})

// 航班组折叠状态：空 Set = 全部展开；点航班行把 key 加入/移出集合
const flightCollapsed = ref(new Set())
function toggleFlight(key) {
  const next = new Set(flightCollapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  flightCollapsed.value = next
}

// trip 返回统计：summary 里的携程航班/套餐数 + 各态报价计数
const tripStats = computed(() => {
  const s = props.task.result?.summary || {}
  return {
    flightCount: s.flightCount ?? 0,
    lowPriceCount: s.lowPriceCount ?? 0,
    total: s.quoteTotal ?? tripRows.value.length,
    won: s.quoteWon ?? tripRows.value.filter(r => r.status === 'won').length,
    lost: s.quoteLost ?? tripRows.value.filter(r => r.status === 'lost').length,
    own: s.quoteOwn ?? 0,
    ownShown: s.quoteOwnShown ?? tripRows.value.filter(r => r.status === 'ownShown').length,
    ownHidden: s.quoteOwnHidden ?? tripRows.value.filter(r => r.status === 'ownHidden').length,
    unmatched: s.quoteUnmatched ?? tripRows.value.filter(r => r.status === 'unmatched').length
  }
})
</script>

<style scoped>
.req-item {
  display: flex;
  flex-flow: column nowrap;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #ececec;
  border-left-width: 3px;        /* 平台识别左色条（颜色按平台覆盖）*/
  border-radius: 4px;
  background: #fff;
  font-size: 13px;
}

/* 平台色条 + 整圈彩色边框 + 卡片底色：锦绣蓝 / 携程橙 / 其他灰——远距离即可识别 */
.req-item--pf-jxgj { border-color: #91caff; border-left: 3px solid #1890ff; background: #f7faff; }
.req-item--pf-trip { border-color: #ffbb96; border-left: 3px solid #fa8c16; background: #fff9f2; }
.req-item--pf-o2,
.req-item--pf-o3 { border-left-color: #bfbfbf; }

/* 头部轻染色，强化平台锚点（比卡片体略深一档）*/
.req-item--pf-jxgj .req-h { background: #e8f2ff; margin: -8px -10px 0; padding: 6px 10px; border-radius: 3px 3px 0 0; }
.req-item--pf-trip .req-h { background: #fff1de; margin: -8px -10px 0; padding: 6px 10px; border-radius: 3px 3px 0 0; }
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
  background: #f5f5f5;
}

/* ===== 内容块（请求参数 / 返回数据）===== */
.req-block {
  border: 1px solid #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
}

.rb-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-size: 11px;
  color: #888;
  background: #fafafa;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: #f5f5f5;
  }
}

/* 折叠三角箭头：展开时旋转 90°；折叠态标题去掉底边框（body 已隐藏） */
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

/* 标题右侧计数（如「2 个日期」），弱化显示 */
.rb-title-count {
  margin-left: auto;
  font-size: 11px;
  color: #1890ff;
  font-weight: 500;
}

/* trip 返回数据头部速览：灰色一行（状态/航班/匹配/自有），超长省略不折行 */
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
  padding: 6px 8px;
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

/* 一行横排多组键值：每组 label+value 包在一起不被拆开，空间不足时整组换行 */
.rb-kv--inline {
  flex-wrap: wrap;
  row-gap: 2px;
  column-gap: 12px;
}

.rb-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* 横排模式下标签按自然宽度（不占固定 60px），组间距更紧凑 */
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
  margin-bottom: 6px;
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

/* trip 失败时块内仅保留错误原因（标题已有「失败」标签，不重复 tag） */
.rbs-msg--fail {
  color: #cf1322;
  word-break: break-all;
}

/* trip 返回统计行（航班数/套餐数/胜负计数） */
.rb-summary-line {
  margin-bottom: 6px;
  font-size: 12px;
  color: #666;
}

/* 「结果」列标签（行背景仿 OTA 只表达投放归属；胜负仍由标签表达）
   比赢绿字 / 比输橙字（比输不用红色失败语义）/ 外显绿 / 未显棕 / 未匹配灰 */
.rb-outcome {
  display: inline-block;
  padding: 0 6px;
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

/* 全量报价表：五列全部给宽度——table-layout:fixed 下列宽之和小于表格宽度时，
   浏览器按比例把多余空间分摊给所有列（不留单列独吞空白）；容器变窄时同步压缩。
   列序：匹配结果 / 航线(航班号+机场换行) / 舱位 / 携程底价 / 行李；
   我方价格不在报价行展示，统一见各航班块展开后上方的「锦绣官网」基准行
   table-layout:auto → 航线列宽 = 本组所有行航线内容最宽者的宽度（内容自适应），
   其他列保留 width 作为建议宽度，auto 模式下按内容就近伸缩，整列仍对齐 */
.rb-table--quotes {
  table-layout: fixed;

  th:nth-child(1) { width: 72px; }   /* 匹配结果（最长标签「无此航班」）*/
  th:nth-child(2) { width: 18%; }   /* 航线（航班号+机场换行）*/
  th:nth-child(3) { width: 48px; }  /* 舱位 */
  th:nth-child(4) { width: 62px; }  /* 携程底价（¥1240）*/
  th:nth-child(5) { width: 58px; }  /* 行李（1×20KG）*/

  /* 表头与其他数据行：不换行 + 超出省略（航线列 td 通过 .qm-route-cell 覆盖允许换行） */
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

/* ===== 航班块（tbody）视觉分隔：完整描边 + 灰槽 + 整块浅灰底 =====
   tbody 不渲染 margin/border/border-radius，描边靠各行 td 拼接
   （border-collapse:collapse 下相邻边框自动合并）：
   - 左/右边线：块内每行首末 td
   - 顶线：首行 td border-top；非首块额外加 14px 灰槽（间距）+ 槽底实线
   - 底线：末行 td border-bottom
   比赢/未匹配行透明露出块底；绿/黄/棕红状态行保留自身色 */
.rb-table--quotes tbody {
  background: #eef1f5;
}
.rb-table--quotes tbody td:first-child { border-left: 2px solid #aeb7c2; }
.rb-table--quotes tbody td:last-child  { border-right: 2px solid #aeb7c2; }
.rb-table--quotes tbody tr:first-child > td {
  border-top: 2px solid #aeb7c2;
}
.rb-table--quotes tbody:not(:first-child) tr:first-child > td {
  border-top: 14px solid #d5dae2;             /* 块间灰槽 */
  box-shadow: inset 0 2px 0 #aeb7c2;          /* 灰槽底部实线 = 块顶描边 */
}
.rb-table--quotes tbody tr:last-child > td {
  border-bottom: 2px solid #aeb7c2;
}
.rb-table--quotes thead th {
  border-bottom: 2px solid #8c96a3;   /* 表头与首个航班块的分隔，加深 */
}

/* ===== 航班主行（OTA 展示行=普通数据行，点击展开套餐）===== */
tr.qrow--main {
  cursor: pointer;
  user-select: none;
}

/* 任意底色下都适用的轻微 hover 反馈（绿/黄/白行压暗一点点）*/
tr.qrow--main:hover > td {
  filter: brightness(0.97);
}

/* 第2列「航线」单元格：航班号+机场换行显示（节省宽度）
   携程数据行 td 有 white-space:nowrap 继承，这里覆盖允许子 div 换行 */
.qm-route-cell {
  white-space: normal;
  line-height: 1.25;
}

.qm-flight {
  font-weight: 600;
}

.qm-route {
  color: #999;
  font-size: 11.5px;
}

/* 锦绣对比行第4列：价格+底价换行（携程这列是「携程底价」，锦绣多一条「价格」）*/
.qb-price-floor {
  white-space: normal;
  line-height: 1.25;
}

/* 行背景：绿=我方外显，黄=我方未显，棕红=比输；比赢/未匹配透明，露出航班块浅灰底 */
tr.qrow--ownShown > td { background: #f6ffed; }
tr.qrow--ownHidden > td { background: #fffbe6; }
tr.qrow--lost > td { background: #fbe4dc; }   /* 比输：浅棕红 */
tr.qrow--won > td,
tr.qrow--unmatched > td { background: transparent; }

/* ===== 锦绣官网对比基准行（5 列与携程数据行对齐，蓝底一行）=====
   第2列 航班+航线换行；第4列 价格+底价换行——整行 td 允许换行 */
.qrow-basis > td {
  padding: 3px 8px;
  background: #f0f7ff;
  border-top: 1px solid #e8e8e8;
  font-size: 11.5px;
  color: #555;
  white-space: normal;          /* 允许子 div 换行（航班/航线、价格/底价）*/
  line-height: 1.25;
  vertical-align: top;
}

.qb-tag {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  color: #096dd9;
  background: #e6f4ff;
  border: 1px solid #91caff;
}

/* 图例 */
.rb-legend {
  display: flex;
  flex-flow: row wrap;
  gap: 10px;
  margin-bottom: 6px;
  font-size: 11px;
  color: #888;
}

.rbl-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
.rbl-dot--other     { background: #eef1f5; border-color: #aeb7c2; }

.rbl-hint {
  color: #bbb;
}

/* 舱位组：舱位串可能较长，允许占满后换行（不挤压其他参数组） */
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
    padding: 3px 8px;
    text-align: left;
    border-bottom: 1px solid #f5f5f5;
  }

  th {
    color: #999;
    font-weight: 500;
    background: #fafafa;
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

/* 按日期分组（携程请求预览） */
.rb-date-groups {
  display: flex;
  flex-flow: column nowrap;
  gap: 8px;
}

.rdg-head {
  font-size: 12px;
  font-weight: 600;
  color: #333;
  padding: 2px 0;
}

.rdg-count {
  font-weight: 400;
  color: #999;
}

/* JSON / 空态 */
.rb-body pre {
  margin: 0;
  padding: 6px 8px;
  background: #fafafa;
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
}

/* ===== 错误提示（无 result 时的兜底）===== */
.req-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
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
