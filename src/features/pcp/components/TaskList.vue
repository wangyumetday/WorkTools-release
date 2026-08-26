<!-- ============================================================
     PCP TaskList.vue - 任务列表(真实列表实现,当前使用)
     设计:
       - v-for 渲染全部任务行(几百~千级无压力)
       - 行高真实,滚动测算天然正确
       - 详情面板内嵌行下,最大 400px 框内滚动(见 taskList.css)
     与 TaskListVirtual.vue 共享 useTaskList 逻辑 + taskList.css 样式
     ============================================================ -->
<template>
  <div class="tab-list">
    <div v-for="item in store.tasks" :key="item.id" class="tl-row-wrap">
      <div class="tl-row" @click="toggleExpand(item.id)">
        <!-- ★ 纯 CSS 背景进度条：transform scaleX 走 GPU，不触发重排 -->
        <div class="tl-row-bg" :class="progressClass(item)" :style="{
          transform: `scaleX(${Math.max(0, Math.min(1, (progressWidth(item) || 0) / 100))})`,
          transformOrigin: 'left center'
        }"></div>

        <div class="tl-row-content">
          <div class="tl-row-expand" :class="{ open: expandedTaskId === item.id }">▶</div>
          <div class="tab-header-item">{{ shortId(item.id) }}</div>
          <div class="tab-header-item">{{ typeMap[item.type] || item.type }}</div>
          <!-- 百分比按状态着色 -->
          <div class="tab-header-item" :class="pctClass(item)">{{ Math.round(item.progress || 0) }}%</div>
          <!-- 状态文字按状态着色 -->
          <div class="tab-header-item" :class="statusClass(item.status)">
            {{ statusMap[item.status]?.text || item.status }}
          </div>
          <div class="tab-header-item">{{ formatDuration(getDuration(item)) }}</div>
        </div>
      </div>

      <!-- ★ 展开详情面板（紧凑版）：核心信息一目了然，次要信息折叠 -->
      <!-- 滚动:纯 CSS overscroll-behavior:auto,详情滚到底/到顶原生链式带动任务列表(见 taskList.css) -->
      <div v-if="expandedTaskId === item.id" class="tl-detail">
        <!-- ===== 顶部 meta 条：一行 chip 横排 ===== -->
        <div class="tld-section tld-meta">
          <span class="tld-chip">
            <span class="tld-chip__label">状态</span>
            <span class="tld-chip__value"
              :class="{
                'tld-chip__value--fail': item.status === 'failed',
                'tld-chip__value--ok': item.status === 'completed',
                'tld-chip__value--warn': item.status === 'skipped' || item.status === 'paused',
                'tld-chip__value--run': item.status === 'running'
              }">{{ statusMap[item.status]?.text || item.status }}</span>
          </span>
          <span class="tld-chip__sep"></span>
          <span class="tld-chip">
            <span class="tld-chip__label">平台</span>
            <span class="tld-chip__value">{{ typeMap[item.type] || item.type }}</span>
          </span>
          <span class="tld-chip__sep"></span>
          <span class="tld-chip">
            <span class="tld-chip__label">耗时</span>
            <span class="tld-chip__value">{{ formatDuration(getDuration(item)) }}s</span>
          </span>

          <template v-if="item.result?._usedCredential">
            <span class="tld-chip__sep"></span>
            <span class="tld-chip" :title="`账号：${item.result._usedCredential.name || '-'} / 用户：${item.result._usedCredential.username || '-'}`">
              <span class="tld-chip__label">账号</span>
              <span class="tld-chip__value">{{ item.result._usedCredential.name || '-' }}</span>
            </span>
          </template>

          <!-- 致命错误徽章 inline -->
          <span v-if="item.result?.isFatal" class="tld-chip__sep"></span>
          <n-tag v-if="item.result?.isFatal" type="error" size="small" round>已停止剩余任务</n-tag>
        </div>

        <!-- ===== 核心结果：失败原因 / 跳过原因 / 处理结果 ===== -->
        <div v-if="item.status === 'failed' && item.result?.error"
             class="tld-section tld-result tld-result--fail">{{ item.result.error }}</div>

        <div v-else-if="item.status === 'skipped' && item.result?.error"
             class="tld-section tld-result tld-result--skip">{{ item.result.error }}</div>

        <div v-else-if="item.status === 'completed' && item.result"
             class="tld-section tld-result tld-result--ok">{{ summarizeResult(item.result) }}</div>

        <!-- ===== 航班信息区块（仅完成态展示；jxgj 与 OTA 字段不同）===== -->
        <div v-if="item.status === 'completed' && item.result" class="tld-section tld-flights">
          <!-- ===== jxgj：请求查询 + 返回数据(date_obj) ===== -->
          <template v-if="item.type === 'jxgj'">
            <!-- 请求查询区：来自 a1Item，单值直接排列 -->
            <div class="tld-meta">
              <span class="tld-chip">
                <span class="tld-chip__label">航班号</span>
                <span class="tld-chip__value">{{ item.data?.hangsi || '-' }}</span>
              </span>
              <span class="tld-chip__sep"></span>
              <span class="tld-chip">
                <span class="tld-chip__label">出发</span>
                <span class="tld-chip__value">{{ item.data?.CF_jichang || '-' }}</span>
              </span>
              <span class="tld-chip__sep"></span>
              <span class="tld-chip">
                <span class="tld-chip__label">到达</span>
                <span class="tld-chip__value">{{ item.data?.DD_jichang || '-' }}</span>
              </span>
              <span class="tld-chip__sep"></span>
              <span class="tld-chip">
                <span class="tld-chip__label">所有舱位</span>
                <span class="tld-chip__value">{{ item.data?.cangwei_str || '-' }}</span>
              </span>
            </div>

            <!-- 返回数据区：date_obj（按日期分组） -->
            <div v-if="getJxgjDateEntries(item).length === 0" class="tld-empty">无航班数据</div>
            <template v-else>
              <!-- 单条航班（1 日 1 航班）：直接排列，无需折叠 -->
              <template v-if="getJxgjTotalFlights(item) === 1">
                <div class="tld-meta">
                  <span class="tld-chip">
                    <span class="tld-chip__label">日期</span>
                    <span class="tld-chip__value">{{ getJxgjDateEntries(item)[0].date }}</span>
                  </span>
                  <span class="tld-chip__sep"></span>
                  <span class="tld-chip">
                    <span class="tld-chip__label">航班</span>
                    <span class="tld-chip__value">{{ getJxgjDateEntries(item)[0].items[0]?.H航班号 }}</span>
                  </span>
                  <span class="tld-chip__sep"></span>
                  <span class="tld-chip">
                    <span class="tld-chip__label">舱位</span>
                    <span class="tld-chip__value">{{ getJxgjDateEntries(item)[0].items[0]?.C舱位 }}</span>
                  </span>
                  <span class="tld-chip__sep"></span>
                  <span class="tld-chip">
                    <span class="tld-chip__label">票价</span>
                    <span class="tld-chip__value">{{ getJxgjDateEntries(item)[0].items[0]?.C成人总票价_CNY_INT }}</span>
                  </span>
                  <span class="tld-chip__sep"></span>
                  <span class="tld-chip">
                    <span class="tld-chip__label">底价</span>
                    <span class="tld-chip__value">{{ getJxgjDateEntries(item)[0].items[0]?.dijia }}</span>
                    <!-- 调试：底价计算命中来源（区间/全局/降级）+ 公式字符串（区间则显示 [L,U]） -->
                    <small v-if="getJxgjDateEntries(item)[0].items[0]?._floorMeta" class="tld-fp-meta">
                      ({{ formatFloorMeta(getJxgjDateEntries(item)[0].items[0]._floorMeta) }})
                    </small>
                  </span>
                </div>
              </template>

              <!-- 多条航班：日期组折叠 → 点击展开看日期列表 → 点击日期看航班行 -->
              <template v-else>
                <span class="tld-collapse-toggle"
                      :class="{ open: flightPanelExpandedId === item.id }"
                      @click.stop="toggleFlightPanel(item.id)">
                  <span class="caret">▶</span>
                  <span>航班信息 · {{ getJxgjTotalFlights(item) }} 条 / {{ getJxgjDateEntries(item).length }} 日</span>
                </span>
                <div v-if="flightPanelExpandedId === item.id" class="tld-flights-list">
                  <div v-for="d in getJxgjDateEntries(item)"
                       :key="d.date"
                       class="tld-date-group">
                    <span class="tld-collapse-toggle"
                          :class="{ open: expandedDates.has(d.date) }"
                          @click.stop="toggleDate(d.date)">
                      <span class="caret">▶</span>
                      <span>{{ d.date }} · {{ d.items.length }} 条</span>
                    </span>
                    <div v-if="expandedDates.has(d.date)">
                      <table class="tld-flight-table">
                        <thead>
                          <tr>
                            <th>航班</th><th>舱位</th><th>票价</th><th>底价</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="(f, idx) in d.items"
                              :key="(f.H航班号 || '') + '_' + (f.C舱位 || '') + '_' + idx">
                            <td>{{ f.H航班号 }}</td>
                            <td>{{ f.C舱位 }}</td>
                            <td>{{ f.C成人总票价_CNY_INT }}</td>
                            <td>
                              {{ f.dijia }}
                              <small v-if="f._floorMeta" class="tld-fp-meta">
                                ({{ formatFloorMeta(f._floorMeta) }})
                              </small>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </template>
            </template>
          </template>

          <!-- ===== OTA（trip/o2/o3）：官网 vs 携程 对照(单行一项) =====
               processedData 每条同时含 C成人总票价_CNY_INT(官网/jxgj 链路)
               和 XC_dijia(携程 OTA 返回底价)。同一任务 dateKey 相同,故仅在表头上方显示一次。
               差额 = 携程底价 - 官网成人总票价(正=携程高于官网)。 -->
          <template v-else-if="item.type === 'trip' || item.type === 'o2' || item.type === 'o3'">
            <div v-if="getOtaFlights(item).length === 0" class="tld-empty">无匹配航班</div>
            <template v-else>
              <!-- 查询日期(同一任务 dateKey 共享,所有航班同日) -->
              <div class="tld-cmp-date">查询日期：{{ item.data.dateKey || '-' }}</div>
              <!-- 一行一项:官网价/携程价 并排 + 差额,斑马纹隔行 -->
              <div class="tld-cmp-section">
                <table class="tld-flight-table tld-cmp-table">
                  <thead>
                    <tr>
                      <th>航班号/舱位</th><th>出发--到达</th>
                      <th>官网</th><th>携程</th><th>差额</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(f, idx) in getOtaFlights(item)" :key="'a_' + idx" class="cmp-row-single">
                      <td>{{ f.H航班号 }} / {{ f.C舱位 }}</td>
                      <td>{{ f.C出发机场 }}--{{ f.D到达机场 }}</td>
                      <td>{{ f.C成人总票价_CNY_INT }}</td>
                      <td>{{ f.XC_dijia }}</td>
                      <td>{{ getOtaDiff(f) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </template>
        </div>

        <!-- ===== 输入数据：默认折叠，需要才展开 ===== -->
        <div v-if="item.data || item.result?._usedCredential" class="tld-section">
          <span class="tld-collapse-toggle"
                :class="{ open: inputDataExpandedId === item.id }"
                @click.stop="toggleInputData(item.id)">
            <span class="caret">▶</span>
            <span>{{ inputDataExpandedId === item.id ? '收起详情' : '展开输入数据' }}</span>
          </span>

          <div v-if="inputDataExpandedId === item.id">
            <div v-if="item.result?._usedCredential" style="margin-top:4px; font-size:11.5px; color:#777;">
              使用账号：{{ item.result._usedCredential.name }} / {{ item.result._usedCredential.username }}
              <span v-if="item.result._usedCredential.platform">· 平台：{{ item.result._usedCredential.platform }}</span>
            </div>
            <div v-if="item.data" class="tld-data-json">{{ prettyJson(item.data, 30) }}</div>
          </div>
        </div>

        <!-- ===== 返回数据：与输入数据相同的折叠方式 ===== -->
        <div v-if="item.result && typeof item.result === 'object'" class="tld-section">
          <span class="tld-collapse-toggle"
                :class="{ open: resultDataExpandedId === item.id }"
                @click.stop="toggleResultData(item.id)">
            <span class="caret">▶</span>
            <span>{{ resultDataExpandedId === item.id ? '收起详情' : '展开返回数据' }}</span>
          </span>

          <div v-if="resultDataExpandedId === item.id" class="tld-data-json">
            {{ prettyJson(item.result, 30) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { NTag } from 'naive-ui'
import { useTaskList } from '../composables/useTaskList.js'

const {
  store,
  expandedTaskId, toggleExpand,
  inputDataExpandedId, toggleInputData,
  resultDataExpandedId, toggleResultData,
  flightPanelExpandedId, toggleFlightPanel,
  expandedDates, toggleDate,
  getJxgjDateEntries, getJxgjTotalFlights,
  getOtaFlights, getOtaDiff,
  summarizeResult, prettyJson,
  typeMap, statusMap,
  shortId, progressWidth, progressClass, pctClass, statusClass,
  getDuration, formatDuration, formatFloorMeta
} = useTaskList()
</script>

<!-- 共享样式(与 TaskListVirtual.vue 同源):行/详情/颜色 -->
<style scoped src="./taskList.css"></style>
