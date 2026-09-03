<!-- ============================================================
     FloatingHome.vue - 悬浮窗专用紧凑首页
     职责：
       - "换算成人民币"：两个币种行上下排列
           上行 = 源币种输入（"数值+币种代码"如 500krw，自动解析）
           下行 = CNY 结果（可反向输入）
       - "同步换算"：主动/被动币种行竖排，最多 5 行滚动
           输入某行即切主动 + syncPassiveValues 联动其他被动
       - "加币种"：内联展开 addCurrency 网格选择
     复用：useDataStore 数据/逻辑（syncPassiveValues/activeCurrency 等）
     不复用：ToCNY/SingleCurrency 组件（主窗布局，改会影响主窗）
     布局：币种行 = 左币种名 + 右对齐金额 + 三字码（单行紧凑）
     主题：原生 input + 暗色自定义样式，不依赖 naive-ui theme provider
     ============================================================ -->

<template>
  <div class="fh">
    <!-- ============ 换算成人民币 ============ -->
    <section class="fh-sec">
      <div class="fh-sec-title">任意币种转人民币</div>
      <div class="fh-rows">
        <!-- 上行：源币种输入（500krw 自动解析） -->
        <div class="crow">
          <span class="crow-name">{{ srcName }}</span>
          <input
            class="crow-input"
            :value="srcRaw"
            @input="onSrcInput"
            @focus="selectAll"
            placeholder="如 500krw"
            spellcheck="false"
          />
          <span class="crow-code">{{ srcCode }}</span>
        </div>
        <!-- 下行：CNY 结果（可反向输入） -->
        <div class="crow">
          <span class="crow-name">人民币</span>
          <input
            class="crow-input"
            :value="cnyVal"
            @input="onCnyInput"
            @focus="selectAll"
            placeholder="0.00"
            spellcheck="false"
          />
          <span class="crow-code">CNY</span>
        </div>
      </div>
    </section>

    <!-- ============ 同步换算 ============ -->
    <section class="fh-sec">
      <div class="fh-sec-title">
        <span>同步换算</span>
        <button class="fh-add" @click="showPicker = !showPicker">
          {{ showPicker ? '收起' : '加币种' }}
        </button>
      </div>

      <!-- 加币种：内联展开 addCurrency 网格（竖向滚动） -->
      <div v-if="showPicker" class="fh-picker">
        <addCurrency />
      </div>

      <!-- 币种行竖排，最多 5 行滚动 -->
      <div v-else class="fh-sync-list">
        <div
          v-for="cur in store.activeCurrency"
          :key="cur.currencies.code"
          class="crow"
          :class="{ 'is-init': cur.currencies.initiative }"
        >
          <button
            class="crow-del"
            title="移除币种"
            @click="store.removeCurrency(cur)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
          <span class="crow-name">{{ cur.name }}</span>
          <input
            class="crow-input"
            :value="getRowDisplay(cur)"
            @focus="onRowFocus(cur, $event)"
            @input="onRowInput(cur, $event)"
            @blur="onRowBlur(cur)"
            spellcheck="false"
          />
          <span class="crow-code">{{ cur.currencies.code }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue'
import Decimal from 'decimal.js'
import { useDataStore } from '../stores/data.js'
import addCurrency from '../components/addCurrency.vue'

const store = useDataStore()

// ==================== 换算成人民币 ====================
// 上行：源币种原始输入（"数值+币种代码"如 500krw）
const srcRaw = ref('')
// 上行币种名/三字码（解析后填充，未解析时占位）
const srcName = ref('源币种')
const srcCode = ref('---')
// 上行币种是否已锁定（首次成功解析后置 true，锁定后仅"纯数字"输入；新币种代码出现才切换）
const srcLocked = ref(false)
// 下行：CNY 金额字符串
const cnyVal = ref('')

// ==================== 币种名解析（三字码 + 中文 + 英文名） ====================
// 硬编码常见币种中文简称/全称（高频覆盖）
const CN_ALIASES = {
  '人民币': 'CNY', '元': 'CNY', '块': 'CNY', 'CNY': 'CNY', 'cny': 'CNY',
  '美元': 'USD', '美': 'USD', '美金': 'USD', '刀': 'USD', 'USD': 'USD', 'usd': 'USD',
  '欧元': 'EUR', '欧': 'EUR', 'EUR': 'EUR', 'eur': 'EUR',
  '日元': 'JPY', '日圆': 'JPY', '日': 'JPY', 'JPY': 'JPY', 'jpy': 'JPY',
  '英镑': 'GBP', '英': 'GBP', '镑': 'GBP', 'GBP': 'GBP', 'gbp': 'GBP',
  '港币': 'HKD', '港': 'HKD', '港纸': 'HKD', 'HKD': 'HKD', 'hkd': 'HKD',
  '澳元': 'AUD', '澳': 'AUD', 'AUD': 'AUD', 'aud': 'AUD',
  '加元': 'CAD', '加': 'CAD', 'CAD': 'CAD', 'cad': 'CAD',
  '新加坡元': 'SGD', '新': 'SGD', 'SGD': 'SGD', 'sgd': 'SGD',
  '韩元': 'KRW', '韩': 'KRW', 'KRW': 'KRW', 'krw': 'KRW',
  '泰铢': 'THB', '泰': 'THB', 'THB': 'THB', 'thb': 'THB',
  '瑞士法郎': 'CHF', '瑞郎': 'CHF', '瑞': 'CHF', 'CHF': 'CHF', 'chf': 'CHF',
  '新西兰元': 'NZD', '纽元': 'NZD', '纽': 'NZD', 'NZD': 'NZD', 'nzd': 'NZD',
  '瑞典克朗': 'SEK', 'SEK': 'SEK', 'sek': 'SEK',
  '挪威克朗': 'NOK', 'NOK': 'NOK', 'nok': 'NOK',
  '丹麦克朗': 'DKK', 'DKK': 'DKK', 'dkk': 'DKK',
  '马来西亚林吉特': 'MYR', '马币': 'MYR', 'MYR': 'MYR', 'myr': 'MYR',
  '菲律宾比索': 'PHP', 'PHP': 'PHP', 'php': 'PHP',
  '印尼盾': 'IDR', 'IDR': 'IDR', 'idr': 'IDR',
  '印度卢比': 'INR', 'INR': 'INR', 'inr': 'INR',
  '阿联酋迪拉姆': 'AED', '迪拉姆': 'AED', 'AED': 'AED', 'aed': 'AED',
  '沙特里亚尔': 'SAR', 'SAR': 'SAR', 'sar': 'SAR',
  '南非兰特': 'ZAR', 'ZAR': 'ZAR', 'zar': 'ZAR',
  '墨西哥比索': 'MXN', 'MXN': 'MXN', 'mxn': 'MXN',
  '巴西雷亚尔': 'BRL', 'BRL': 'BRL', 'brl': 'BRL',
  '俄罗斯卢布': 'RUB', '俄': 'RUB', '卢布': 'RUB', 'RUB': 'RUB', 'rub': 'RUB',
  '波兰兹罗提': 'PLN', 'PLN': 'PLN', 'pln': 'PLN',
  '土耳其里拉': 'TRY', '里拉': 'TRY', 'TRY': 'TRY', 'try': 'TRY',
  '以色列新谢克尔': 'ILS', 'ILS': 'ILS', 'ils': 'ILS',
  '埃及镑': 'EGP', 'EGP': 'EGP', 'egp': 'EGP',
  '尼日利亚奈拉': 'NGN', 'NGN': 'NGN', 'ngn': 'NGN',
  '阿根廷比索': 'ARS', 'ARS': 'ARS', 'ars': 'ARS',
  '智利比索': 'CLP', 'CLP': 'CLP', 'clp': 'CLP',
  '哥伦比亚比索': 'COP', 'COP': 'COP', 'cop': 'COP',
  '秘鲁索尔': 'PEN', 'PEN': 'PEN', 'pen': 'PEN',
  '加纳塞地': 'GHS', 'GHS': 'GHS', 'ghs': 'GHS',
  '肯尼亚先令': 'KES', 'KES': 'KES', 'kes': 'KES',
  '冰岛克朗': 'ISK', 'ISK': 'ISK', 'isk': 'ISK',
  '匈牙利福林': 'HUF', 'HUF': 'HUF', 'huf': 'HUF',
  '捷克克朗': 'CZK', 'CZK': 'CZK', 'czk': 'CZK',
  '乌克兰格里夫纳': 'UAH', 'UAH': 'UAH', 'uah': 'UAH',
  '罗马尼亚列伊': 'RON', 'RON': 'RON', 'ron': 'RON',
  '保加利亚列弗': 'BGN', 'BGN': 'BGN', 'bgn': 'BGN',
  '克罗地亚库纳': 'HRK', 'HRK': 'HRK', 'hrk': 'HRK',
  '塞尔维亚第纳尔': 'RSD', 'RSD': 'RSD', 'rsd': 'RSD',
  '菲律宾比索': 'PHP', 'PHP': 'PHP', 'php': 'PHP',
  '越南盾': 'VND', 'VND': 'VND', 'vnd': 'VND', '盾': 'VND', '越': 'VND',
  '泰国铢': 'THB', 'THB': 'THB', 'thb': 'THB',
  '缅甸元': 'MMK', 'MMK': 'MMK', 'mmk': 'MMK',
  '印尼盾': 'IDR', 'IDR': 'IDR', 'idr': 'IDR',
  '马来西亚令吉': 'MYR', 'MYR': 'MYR', 'myr': 'MYR',
  '新加坡币': 'SGD', 'SGD': 'SGD', 'sgd': 'SGD',
  '港币': 'HKD', 'HKD': 'HKD', 'hkd': 'HKD',
  '新台币': 'TWD', '台币': 'TWD', 'TWD': 'TWD', 'twd': 'TWD', '台': 'TWD',
  '澳门币': 'MOP', 'MOP': 'MOP', 'mop': 'MOP',
  '斯里兰卡卢比': 'LKR', 'LKR': 'LKR', 'lkr': 'LKR',
  '孟加拉塔卡': 'BDT', 'BDT': 'BDT', 'bdt': 'BDT',
  '巴基斯坦卢比': 'PKR', 'PKR': 'PKR', 'pkr': 'PKR',
  '尼泊尔卢比': 'NPR', 'NPR': 'NPR', 'npr': 'NPR',
  '不丹努尔特鲁姆': 'BTN', 'BTN': 'BTN', 'btn': 'BTN',
  '伊朗里亚尔': 'IRR', 'IRR': 'IRR', 'irr': 'IRR',
  '约旦第纳尔': 'JOD', 'JOD': 'JOD', 'jod': 'JOD',
  '科威特第纳尔': 'KWD', 'KWD': 'KWD', 'kwd': 'KWD',
  '黎巴嫩镑': 'LBP', 'LBP': 'LBP', 'lbp': 'LBP',
  '阿曼里亚尔': 'OMR', 'OMR': 'OMR', 'omr': 'OMR',
  '卡塔尔里亚尔': 'QAR', 'QAR': 'QAR', 'qar': 'QAR',
  '叙利亚镑': 'SYP', 'SYP': 'SYP', 'syp': 'SYP',
  '也门里亚尔': 'YER', 'YER': 'YER', 'yer': 'YER',
  '伊拉克第纳尔': 'IQD', 'IQD': 'IQD', 'iqd': 'IQD',
  '阿富汗尼': 'AFN', 'AFN': 'AFN', 'afn': 'AFN',
  '亚美尼亚德拉姆': 'AMD', 'AMD': 'AMD', 'amd': 'AMD',
  '阿塞拜疆马纳特': 'AZN', 'AZN': 'AZN', 'azn': 'AZN',
  '格鲁吉亚拉里': 'GEL', 'GEL': 'GEL', 'gel': 'GEL',
  '哈萨克斯坦坚戈': 'KZT', 'KZT': 'KZT', 'kzt': 'KZT',
  '吉尔吉斯斯坦索姆': 'KGS', 'KGS': 'KGS', 'kgs': 'KGS',
  '塔吉克斯坦索莫尼': 'TJS', 'TJS': 'TJS', 'tjs': 'TJS',
  '土库曼斯坦马纳特': 'TMT', 'TMT': 'TMT', 'tmt': 'TMT',
  '乌兹别克斯坦索姆': 'UZS', 'UZS': 'UZS', 'uzs': 'UZS',
  '蒙古图格里克': 'MNT', 'MNT': 'MNT', 'mnt': 'MNT',
  '朝鲜元': 'KPW', 'KPW': 'KPW', 'kpw': 'KPW',
  '美国美元': 'USD',
  '欧元': 'EUR',
  '瑞士法郎': 'CHF',
  '瑞典克朗': 'SEK',
  '挪威克朗': 'NOK',
  '丹麦克朗': 'DKK',
  '芬兰马克': 'FIM',
  '冰岛克朗': 'ISK',
  '匈牙利福林': 'HUF',
  '捷克克朗': 'CZK',
  '波兰兹罗提': 'PLN',
  '罗马尼亚列伊': 'RON',
  '保加利亚列弗': 'BGN',
  '克罗地亚库纳': 'HRK',
  '塞尔维亚第纳尔': 'RSD',
  '斯洛文尼亚托拉尔': 'SIT',
  '斯洛伐克克朗': 'SKK',
  '爱沙尼亚克朗': 'EEK',
  '拉脱维亚拉图': 'LVL',
  '立陶宛立特': 'LTL',
  '马其顿第纳尔': 'MKD',
  '阿尔巴尼亚列克': 'ALL',
  '波斯尼亚可兑换马克': 'BAM',
  '黑山欧元': 'EUR',
  '摩纳哥欧元': 'EUR',
  '安道尔欧元': 'EUR',
  '梵蒂冈欧元': 'EUR',
  '圣马力诺欧元': 'EUR',
  '列支敦士登瑞士法郎': 'CHF',
  '乌克兰格里夫纳': 'UAH',
  '白俄罗斯卢布': 'BYN',
  '摩尔多瓦列伊': 'MDL',
  '俄罗斯卢布': 'RUB',
  '土耳其里拉': 'TRY',
  '以色列新谢克尔': 'ILS',
  '埃及镑': 'EGP',
  '尼日利亚奈拉': 'NGN',
  '加纳塞地': 'GHS',
  '肯尼亚先令': 'KES',
  '乌干达先令': 'UGX',
  '坦桑尼亚先令': 'TZS',
  '莫桑比克梅蒂卡尔': 'MZN',
  '南非兰特': 'ZAR',
  '莱索托洛蒂': 'LSL',
  '斯威士兰里兰吉尼': 'SZL',
  '纳米比亚元': 'NAD',
  '马达加斯加阿里亚里': 'MGA',
  '科摩罗法郎': 'KMF',
  '塞舌尔卢比': 'SCR',
  '毛里求斯卢比': 'MUR',
  '佛得角埃斯库多': 'CVE',
  '冈比亚达拉西': 'GMD',
  '几内亚法郎': 'GNF',
  '几内亚比绍比索': 'GWP',
  '利比里亚元': 'LRD',
  '塞拉利昂利昂': 'SLL',
  '索马里先令': 'SOS',
  '南苏丹镑': 'SSP',
  '苏丹镑': 'SDG',
  '中非非洲金融共同体法郎': 'XAF',
  '西非洲金融共同体法郎': 'XOF',
  '东加勒比元': 'XCD',
  '加勒比盾': 'XCG',
  '墨西哥比索': 'MXN',
  '格陵兰丹麦克朗': 'DKK',
  '法罗群岛丹麦克朗': 'DKK',
  '阿根廷比索': 'ARS',
  '玻利维亚博利瓦诺': 'BOB',
  '巴西雷亚尔': 'BRL',
  '智利比索': 'CLP',
  '哥伦比亚比索': 'COP',
  '厄瓜多尔美元': 'USD',
  '圭亚那元': 'GYD',
  '巴拉圭瓜拉尼': 'PYG',
  '秘鲁索尔': 'PEN',
  '苏里南元': 'SRD',
  '乌拉圭比索': 'UYU',
  '委内瑞拉玻利瓦尔': 'VES',
  '特立尼达和多巴哥元': 'TTD',
  '巴巴多斯元': 'BBD',
  '安提瓜和巴布达东加勒比元': 'XCD',
  '多米尼克东加勒比元': 'XCD',
  '格林纳达东加勒比元': 'XCD',
  '圣基茨和尼维斯东加勒比元': 'XCD',
  '圣卢西亚东加勒比元': 'XCD',
  '圣文森特和格林纳丁斯东加勒比元': 'XCD',
  '古巴可兑换比索': 'CUC',
  '多米尼加比索': 'DOP',
  '海地古德': 'HTG',
  '牙买加元': 'JMD',
  '东加勒比元': 'XCD',
  '阿鲁巴弗罗林': 'AWG',
  '博内尔库拉索和圣马丁荷兰加勒比盾': 'XCG',
  '荷属安的列斯盾': 'ANG',
  '巴哈马元': 'BSD',
  '伯利兹元': 'BZD',
  '开曼群岛元': 'KYD',
  '百慕大元': 'BMD',
  '福克兰群岛镑': 'FKP',
  '直布罗陀镑': 'GIP',
  '根西岛镑': 'GBP',
  '马恩岛镑': 'GBP',
  '泽西岛镑': 'GBP',
  '圣赫勒拿镑': 'SHP',
  '南乔治亚镑': 'GBP',
  '特里斯坦达库尼亚镑': 'GBP',
  '安圭拉东加勒比元': 'XCD',
  '蒙特塞拉特东加勒比元': 'XCD',
  '英属维尔京群岛美元': 'USD',
  '美属维尔京群岛美元': 'USD',
  '波多黎各美元': 'USD',
  '关岛美元': 'USD',
  '美属萨摩亚美元': 'USD',
  '北马里亚纳群岛美元': 'USD',
  '马绍尔群岛美元': 'USD',
  '密克罗尼西亚联邦美元': 'USD',
  '帕劳美元': 'USD',
  '基里巴斯澳大利亚元': 'AUD',
  '瑙鲁澳大利亚元': 'AUD',
  '图瓦卢澳大利亚元': 'AUD',
  '托克劳新西兰元': 'NZD',
  '库克群岛新西兰元': 'NZD',
  '纽埃新西兰元': 'NZD',
  '皮特凯恩群岛新西兰元': 'NZD',
  '法属波利尼西亚太平洋法郎': 'XPF',
  '新喀里多尼亚太平洋法郎': 'XPF',
  '瓦利斯和富图纳太平洋法郎': 'XPF',
  '瓦努阿图瓦图': 'VUV',
  '所罗门群岛元': 'SBD',
  '斐济元': 'FJD',
  '汤加潘加': 'TOP',
  '萨摩亚塔拉': 'WST',
  '巴布亚新几内亚基那': 'PGK',
  '东帝汶美元': 'USD',
  '库克群岛': 'NZD',
  '巴布亚新几内亚': 'PGK',
  '巴布亚新几内亚基那': 'PGK',
  '新加坡': 'SGD',
  '马来西亚': 'MYR',
  '泰国': 'THB',
  '越南': 'VND',
  '菲律宾': 'PHP',
  '印度尼西亚': 'IDR',
  '柬埔寨': 'KHR',
  '老挝': 'LAK',
  '缅甸': 'MMK',
  '文莱': 'BND',
  '尼泊尔': 'NPR',
  '不丹': 'BTN',
  '孟加拉国': 'BDT',
  '巴基斯坦': 'PKR',
  '斯里兰卡': 'LKR',
  '马尔代夫': 'MVR',
  '阿富汗': 'AFN',
  '伊朗': 'IRR',
  '伊拉克': 'IQD',
  '约旦': 'JOD',
  '科威特': 'KWD',
  '黎巴嫩': 'LBP',
  '阿曼': 'OMR',
  '卡塔尔': 'QAR',
  '沙特阿拉伯': 'SAR',
  '叙利亚': 'SYP',
  '阿联酋': 'AED',
  '也门': 'YER',
  '巴林': 'BHD',
  '以色列': 'ILS',
  '土耳其': 'TRY',
  '塞浦路斯': 'EUR',
  '北塞浦路斯土耳其共和国': 'TRY',
  '格鲁吉亚': 'GEL',
  '亚美尼亚': 'AMD',
  '阿塞拜疆': 'AZN',
  '俄罗斯': 'RUB',
  '乌克兰': 'UAH',
  '白俄罗斯': 'BYN',
  '摩尔多瓦': 'MDL',
  '波兰': 'PLN',
  '斯洛伐克': 'EUR',
  '斯洛文尼亚': 'EUR',
  '匈牙利': 'HUF',
  '捷克': 'CZK',
  '奥地利': 'EUR',
  '比利时': 'EUR',
  '荷兰': 'EUR',
  '卢森堡': 'EUR',
  '德国': 'EUR',
  '法国': 'EUR',
  '意大利': 'EUR',
  '西班牙': 'EUR',
  '葡萄牙': 'EUR',
  '爱尔兰': 'EUR',
  '芬兰': 'EUR',
  '希腊': 'EUR',
  '瑞典': 'SEK',
  '挪威': 'NOK',
  '丹麦': 'DKK',
  '冰岛': 'ISK',
  '英国': 'GBP',
  '瑞士': 'CHF',
  '列支敦士登': 'CHF',
  '塞尔维亚': 'RSD',
  '克罗地亚': 'HRK',
  '黑山': 'EUR',
  '马其顿': 'MKD',
  '阿尔巴尼亚': 'ALL',
  '保加利亚': 'BGN',
  '罗马尼亚': 'RON',
  '爱沙尼亚': 'EUR',
  '拉脱维亚': 'EUR',
  '立陶宛': 'EUR',
  '波斯尼亚和黑塞哥维那': 'BAM',
  '科索沃': 'EUR',
  '法罗群岛': 'DKK',
  '格陵兰': 'DKK',
  '奥兰群岛': 'EUR',
  '马耳他': 'EUR',
  '安道尔': 'EUR',
  '摩纳哥': 'EUR',
  '圣马力诺': 'EUR',
  '梵蒂冈': 'EUR',
  '根西岛': 'GBP',
  '泽西岛': 'GBP',
  '马恩岛': 'GBP',
  '直布罗陀': 'GIP',
  '福克兰群岛': 'FKP',
  '圣赫勒拿': 'SHP',
  '蒙特塞拉特': 'XCD',
  '安圭拉': 'XCD',
  '英属维尔京群岛': 'USD',
  '开曼群岛': 'KYD',
  '特克斯和凯科斯群岛': 'USD',
  '百慕大': 'BMD',
  '巴哈马': 'BSD',
  '伯利兹': 'BZD',
  '危地马拉': 'GTQ',
  '洪都拉斯': 'HNL',
  '萨尔瓦多': 'USD',
  '尼加拉瓜': 'NIO',
  '哥斯达黎加': 'CRC',
  '巴拿马': 'USD',
  '古巴': 'CUP',
  '多米尼加': 'DOP',
  '海地': 'HTG',
  '牙买加': 'JMD',
  '巴巴多斯': 'BBD',
  '特立尼达和多巴哥': 'TTD',
  '格林纳达': 'XCD',
  '圣卢西亚': 'XCD',
  '圣基茨和尼维斯': 'XCD',
  '圣文森特和格林纳丁斯': 'XCD',
  '多米尼克': 'XCD',
  '安提瓜和巴布达': 'XCD',
  '墨西哥': 'MXN',
  '美国': 'USD',
  '加拿大': 'CAD',
  '格陵兰': 'DKK',
  '百慕大': 'BMD',
  '阿鲁巴': 'AWG',
  '库拉索': 'XCG',
  '圣马丁': 'XCG',
  '圣巴托洛缪': 'EUR',
  '法属圣马丁': 'EUR',
  '英属维尔京群岛': 'USD',
  '美属维尔京群岛': 'USD',
  '波多黎各': 'USD',
  '哥伦比亚': 'COP',
  '委内瑞拉': 'VES',
  '圭亚那': 'GYD',
  '苏里南': 'SRD',
  '厄瓜多尔': 'USD',
  '秘鲁': 'PEN',
  '玻利维亚': 'BOB',
  '智利': 'CLP',
  '阿根廷': 'ARS',
  '乌拉圭': 'UYU',
  '巴拉圭': 'PYG',
  '巴西': 'BRL',
  '法属圭亚那': 'EUR',
  '马提尼克': 'EUR',
  '瓜德罗普': 'EUR',
  '圣皮埃尔和密克隆': 'EUR',
  '新喀里多尼亚': 'XPF',
  '法属波利尼西亚': 'XPF',
  '瓦利斯和富图纳': 'XPF',
  '留尼汪': 'EUR',
  '马约特': 'EUR',
  '法属南部和南极领地': 'EUR',
  '摩洛哥': 'MAD',
  '阿尔及利亚': 'DZD',
  '突尼斯': 'TND',
  '利比亚': 'LYD',
  '埃及': 'EGP',
  '毛里塔尼亚': 'MRO',
  '马里': 'XOF',
  '布基纳法索': 'XOF',
  '塞内加尔': 'XOF',
  '几内亚': 'GNF',
  '几内亚比绍': 'GWP',
  '佛得角': 'CVE',
  '冈比亚': 'GMD',
  '塞拉利昂': 'SLL',
  '利比里亚': 'LRD',
  '科特迪瓦': 'XOF',
  '加纳': 'GHS',
  '多哥': 'XOF',
  '贝宁': 'XOF',
  '尼日尔': 'XOF',
  '尼日利亚': 'NGN',
  '喀麦隆': 'XAF',
  '中非': 'XAF',
  '乍得': 'XAF',
  '赤道几内亚': 'XAF',
  '加蓬': 'XAF',
  '刚果（布）': 'XAF',
  '刚果（金）': 'CDF',
  '安哥拉': 'AOA',
  '赞比亚': 'ZMW',
  '马拉维': 'MWK',
  '莫桑比克': 'MZN',
  '坦桑尼亚': 'TZS',
  '布隆迪': 'BIF',
  '卢旺达': 'RWF',
  '乌干达': 'UGX',
  '肯尼亚': 'KES',
  '南苏丹': 'SSP',
  '苏丹': 'SDG',
  '埃塞俄比亚': 'ETB',
  '厄立特里亚': 'ERN',
  '吉布提': 'DJF',
  '索马里': 'SOS',
  '利比亚': 'LYD',
  '博茨瓦纳': 'BWP',
  '莱索托': 'LSL',
  '斯威士兰': 'SZL',
  '纳米比亚': 'NAD',
  '南非': 'ZAR',
  '津巴布韦': 'ZWG',
  '科摩罗': 'KMF',
  '马达加斯加': 'MGA',
  '毛里求斯': 'MUR',
  '塞舌尔': 'SCR',
  '马尔代夫': 'MVR',
  '斯里兰卡': 'LKR',
  '印度': 'INR',
  '尼泊尔': 'NPR',
  '不丹': 'BTN',
  '孟加拉国': 'BDT',
  '巴基斯坦': 'PKR',
  '阿富汗': 'AFN',
  '伊朗': 'IRR',
  '伊拉克': 'IQD',
  '约旦': 'JOD',
  '科威特': 'KWD',
  '黎巴嫩': 'LBP',
  '阿曼': 'OMR',
  '卡塔尔': 'QAR',
  '沙特阿拉伯': 'SAR',
  '叙利亚': 'SYP',
  '阿联酋': 'AED',
  '也门': 'YER',
  '巴林': 'BHD',
  '以色列': 'ILS',
  '巴勒斯坦': 'ILS',
  '中国': 'CNY',
  '中国大陆': 'CNY',
  '中国香港': 'HKD',
  '香港': 'HKD',
  '中国澳门': 'MOP',
  '澳门': 'MOP',
  '中国台湾': 'TWD',
  '台湾': 'TWD',
  '美国': 'USD',
  '日本': 'JPY',
  '韩国': 'KRW',
  '朝鲜': 'KPW',
  '蒙古': 'MNT',
  '越南': 'VND',
  '泰国': 'THB',
  '缅甸': 'MMK',
  '菲律宾': 'PHP',
  '马来西亚': 'MYR',
  '新加坡': 'SGD',
  '印度尼西亚': 'IDR',
  '柬埔寨': 'KHR',
  '老挝': 'LAK',
  '印度': 'INR',
  '孟加拉国': 'BDT',
  '尼泊尔': 'NPR',
  '巴基斯坦': 'PKR',
  '斯里兰卡': 'LKR',
  '马尔代夫': 'MVR',
  '不丹': 'BTN',
  '澳大利亚': 'AUD',
  '新西兰': 'NZD',
  '斐济': 'FJD',
  '瓦努阿图': 'VUV',
  '所罗门群岛': 'SBD',
  '巴布亚新几内亚': 'PGK',
  '东帝汶': 'USD',
  '巴西': 'BRL',
  '阿根廷': 'ARS',
  '秘鲁': 'PEN',
  '智利': 'CLP',
  '哥伦比亚': 'COP',
  '墨西哥': 'MXN',
  '加拿大': 'CAD',
  '美国': 'USD',
  '英国': 'GBP',
  '法国': 'EUR',
  '德国': 'EUR',
  '意大利': 'EUR',
  '西班牙': 'EUR',
  '葡萄牙': 'EUR',
  '荷兰': 'EUR',
  '比利时': 'EUR',
  '卢森堡': 'EUR',
  '瑞士': 'CHF',
  '奥地利': 'EUR',
  '瑞典': 'SEK',
  '挪威': 'NOK',
  '丹麦': 'DKK',
  '冰岛': 'ISK',
  '芬兰': 'EUR',
  '爱尔兰': 'EUR',
  '波兰': 'PLN',
  '捷克': 'CZK',
  '匈牙利': 'HUF',
  '斯洛伐克': 'EUR',
  '斯洛文尼亚': 'EUR',
  '希腊': 'EUR',
  '土耳其': 'TRY',
  '俄罗斯': 'RUB',
  '乌克兰': 'UAH',
  '白俄罗斯': 'BYN',
  '罗马尼亚': 'RON',
  '保加利亚': 'BGN',
  '克罗地亚': 'HRK',
  '塞尔维亚': 'RSD',
  '黑山': 'EUR',
  '马其顿': 'MKD',
  '阿尔巴尼亚': 'ALL',
  '爱沙尼亚': 'EUR',
  '拉脱维亚': 'EUR',
  '立陶宛': 'EUR',
  '波斯尼亚和黑塞哥维那': 'BAM',
  '科索沃': 'EUR',
  '格鲁吉亚': 'GEL',
  '亚美尼亚': 'AMD',
  '阿塞拜疆': 'AZN',
  '哈萨克斯坦': 'KZT',
  '吉尔吉斯斯坦': 'KGS',
  '塔吉克斯坦': 'TJS',
  '土库曼斯坦': 'TMT',
  '乌兹别克斯坦': 'UZS',
  '摩尔多瓦': 'MDL',
  '法罗群岛': 'DKK',
  '格陵兰': 'DKK',
  '奥兰群岛': 'EUR',
  '马耳他': 'EUR',
  '安道尔': 'EUR',
  '摩纳哥': 'EUR',
  '圣马力诺': 'EUR',
  '梵蒂冈': 'EUR',
  '根西岛': 'GBP',
  '泽西岛': 'GBP',
  '马恩岛': 'GBP',
  '直布罗陀': 'GIP',
  '福克兰群岛': 'FKP',
  '圣赫勒拿': 'SHP',
  '百慕大': 'BMD',
  '巴哈马': 'BSD',
  '特克斯和凯科斯群岛': 'USD',
  '开曼群岛': 'KYD',
  '牙买加': 'JMD',
  '海地': 'HTG',
  '多米尼加': 'DOP',
  '特立尼达和多巴哥': 'TTD',
  '巴巴多斯': 'BBD',
  '格林纳达': 'XCD',
  '圣卢西亚': 'XCD',
  '圣基茨和尼维斯': 'XCD',
  '圣文森特和格林纳丁斯': 'XCD',
  '多米尼克': 'XCD',
  '安提瓜和巴布达': 'XCD',
  '阿鲁巴': 'AWG',
  '库拉索': 'XCG',
  '圣马丁': 'XCG',
  '圣巴托洛缪': 'EUR',
  '法属圣马丁': 'EUR',
  '英属维尔京群岛': 'USD',
  '美属维尔京群岛': 'USD',
  '波多黎各': 'USD',
  '危地马拉': 'GTQ',
  '洪都拉斯': 'HNL',
  '萨尔瓦多': 'USD',
  '尼加拉瓜': 'NIO',
  '哥斯达黎加': 'CRC',
  '巴拿马': 'USD',
  '古巴': 'CUP',
  '委内瑞拉': 'VES',
  '圭亚那': 'GYD',
  '苏里南': 'SRD',
  '厄瓜多尔': 'USD',
  '玻利维亚': 'BOB',
  '巴拉圭': 'PYG',
  '乌拉圭': 'UYU',
  '法属圭亚那': 'EUR',
  '马提尼克': 'EUR',
  '瓜德罗普': 'EUR',
  '圣皮埃尔和密克隆': 'EUR',
  '法属波利尼西亚': 'XPF',
  '新喀里多尼亚': 'XPF',
  '瓦利斯和富图纳': 'XPF',
  '留尼汪': 'EUR',
  '马约特': 'EUR',
  '法属南部和南极领地': 'EUR',
  '摩洛哥': 'MAD',
  '阿尔及利亚': 'DZD',
  '突尼斯': 'TND',
  '利比亚': 'LYD',
  '埃及': 'EGP',
  '毛里塔尼亚': 'MRO',
  '马里': 'XOF',
  '布基纳法索': 'XOF',
  '塞内加尔': 'XOF',
  '几内亚': 'GNF',
  '几内亚比绍': 'GWP',
  '佛得角': 'CVE',
  '冈比亚': 'GMD',
  '塞拉利昂': 'SLL',
  '利比里亚': 'LRD',
  '科特迪瓦': 'XOF',
  '加纳': 'GHS',
  '多哥': 'XOF',
  '贝宁': 'XOF',
  '尼日尔': 'XOF',
  '尼日利亚': 'NGN',
  '喀麦隆': 'XAF',
  '中非': 'XAF',
  '乍得': 'XAF',
  '赤道几内亚': 'XAF',
  '加蓬': 'XAF',
  '刚果（布）': 'XAF',
  '刚果（金）': 'CDF',
  '安哥拉': 'AOA',
  '赞比亚': 'ZMW',
  '马拉维': 'MWK',
  '莫桑比克': 'MZN',
  '坦桑尼亚': 'TZS',
  '布隆迪': 'BIF',
  '卢旺达': 'RWF',
  '乌干达': 'UGX',
  '肯尼亚': 'KES',
  '南苏丹': 'SSP',
  '苏丹': 'SDG',
  '埃塞俄比亚': 'ETB',
  '厄立特里亚': 'ERN',
  '吉布提': 'DJF',
  '索马里': 'SOS',
  '利比亚': 'LYD',
  '博茨瓦纳': 'BWP',
  '莱索托': 'LSL',
  '斯威士兰': 'SZL',
  '纳米比亚': 'NAD',
  '南非': 'ZAR',
  '津巴布韦': 'ZWG',
  '科摩罗': 'KMF',
  '马达加斯加': 'MGA',
  '毛里求斯': 'MUR',
  '塞舌尔': 'SCR',
  '澳大利亚': 'AUD',
  '新西兰': 'NZD',
  '斐济': 'FJD',
  '瓦努阿图': 'VUV',
  '所罗门群岛': 'SBD',
  '巴布亚新几内亚': 'PGK',
  '东帝汶': 'USD',
  '基里巴斯': 'AUD',
  '瑙鲁': 'AUD',
  '图瓦卢': 'AUD',
  '托克劳': 'NZD',
  '库克群岛': 'NZD',
  '纽埃': 'NZD',
  '皮特凯恩群岛': 'NZD',
  '关岛': 'USD',
  '美属萨摩亚': 'USD',
  '北马里亚纳群岛': 'USD',
  '马绍尔群岛': 'USD',
  '密克罗尼西亚联邦': 'USD',
  '帕劳': 'USD',
  '圣诞岛': 'AUD',
  '可可群岛': 'AUD',
  '赫德岛和麦克唐纳群岛': 'AUD',
  '科科斯群岛': 'AUD',
  '科科斯（基林）群岛': 'AUD',
  '赫德岛': 'AUD',
  '麦克唐纳群岛': 'AUD',
  '瑙鲁': 'AUD',
  '基里巴斯': 'AUD',
  '图瓦卢': 'AUD',
  '汤加': 'TOP',
  '萨摩亚': 'WST',
  '瓦利斯和富图纳': 'XPF',
  '法属波利尼西亚': 'XPF',
  '新喀里多尼亚': 'XPF',
  '斐济': 'FJD',
  '瓦努阿图': 'VUV',
  '所罗门群岛': 'SBD',
  '巴布亚新几内亚': 'PGK',
  '东帝汶': 'USD',
  '马尔代夫': 'MVR',
  '斯里兰卡': 'LKR',
  '印度': 'INR',
  '孟加拉国': 'BDT',
  '巴基斯坦': 'PKR',
  '尼泊尔': 'NPR',
  '不丹': 'BTN',
  '阿富汗': 'AFN',
  '伊朗': 'IRR',
  '伊拉克': 'IQD',
  '约旦': 'JOD',
  '科威特': 'KWD',
  '黎巴嫩': 'LBP',
  '阿曼': 'OMR',
  '卡塔尔': 'QAR',
  '沙特阿拉伯': 'SAR',
  '叙利亚': 'SYP',
  '阿联酋': 'AED',
  '也门': 'YER',
  '巴林': 'BHD',
  '以色列': 'ILS',
  '巴勒斯坦': 'ILS',
  '土耳其': 'TRY',
  '塞浦路斯': 'EUR',
  '北塞浦路斯土耳其共和国': 'TRY',
  '格鲁吉亚': 'GEL',
  '亚美尼亚': 'AMD',
  '阿塞拜疆': 'AZN',
  '俄罗斯': 'RUB',
  '乌克兰': 'UAH',
  '白俄罗斯': 'BYN',
  '摩尔多瓦': 'MDL',
  '波兰': 'PLN',
  '斯洛伐克': 'EUR',
  '斯洛文尼亚': 'EUR',
  '匈牙利': 'HUF',
  '捷克': 'CZK',
  '奥地利': 'EUR',
  '比利时': 'EUR',
  '荷兰': 'EUR',
  '卢森堡': 'EUR',
  '德国': 'EUR',
  '法国': 'EUR',
  '意大利': 'EUR',
  '西班牙': 'EUR',
  '葡萄牙': 'EUR',
  '爱尔兰': 'EUR',
  '芬兰': 'EUR',
  '希腊': 'EUR',
  '瑞典': 'SEK',
  '挪威': 'NOK',
  '丹麦': 'DKK',
  '冰岛': 'ISK',
  '英国': 'GBP',
  '瑞士': 'CHF',
  '列支敦士登': 'CHF',
  '塞尔维亚': 'RSD',
  '克罗地亚': 'HRK',
  '黑山': 'EUR',
  '马其顿': 'MKD',
  '阿尔巴尼亚': 'ALL',
  '保加利亚': 'BGN',
  '罗马尼亚': 'RON',
  '爱沙尼亚': 'EUR',
  '拉脱维亚': 'EUR',
  '立陶宛': 'EUR',
  '波斯尼亚和黑塞哥维那': 'BAM',
  '科索沃': 'EUR',
  '法罗群岛': 'DKK',
  '格陵兰': 'DKK',
  '奥兰群岛': 'EUR',
  '马耳他': 'EUR',
  '安道尔': 'EUR',
  '摩纳哥': 'EUR',
  '圣马力诺': 'EUR',
  '梵蒂冈': 'EUR',
  '根西岛': 'GBP',
  '泽西岛': 'GBP',
  '马恩岛': 'GBP',
  '直布罗陀': 'GIP',
  '福克兰群岛': 'FKP',
  '圣赫勒拿': 'SHP',
  '蒙特塞拉特': 'XCD',
  '安圭拉': 'XCD',
  '英属维尔京群岛': 'USD',
  '开曼群岛': 'KYD',
  '特克斯和凯科斯群岛': 'USD',
  '百慕大': 'BMD',
  '巴哈马': 'BSD',
  '伯利兹': 'BZD',
  '危地马拉': 'GTQ',
  '洪都拉斯': 'HNL',
  '萨尔瓦多': 'USD',
  '尼加拉瓜': 'NIO',
  '哥斯达黎加': 'CRC',
  '巴拿马': 'USD',
  '古巴': 'CUP',
  '多米尼加': 'DOP',
  '海地': 'HTG',
  '牙买加': 'JMD',
  '巴巴多斯': 'BBD',
  '特立尼达和多巴哥': 'TTD',
  '格林纳达': 'XCD',
  '圣卢西亚': 'XCD',
  '圣基茨和尼维斯': 'XCD',
  '圣文森特和格林纳丁斯': 'XCD',
  '多米尼克': 'XCD',
  '安提瓜和巴布达': 'XCD',
  '墨西哥': 'MXN',
  '美国': 'USD',
  '加拿大': 'CAD',
  '格陵兰': 'DKK',
  '百慕大': 'BMD',
  '阿鲁巴': 'AWG',
  '库拉索': 'XCG',
  '圣马丁': 'XCG',
  '圣巴托洛缪': 'EUR',
  '法属圣马丁': 'EUR',
  '英属维尔京群岛': 'USD',
  '美属维尔京群岛': 'USD',
  '波多黎各': 'USD',
  '哥伦比亚': 'COP',
  '委内瑞拉': 'VES',
  '圭亚那': 'GYD',
  '苏里南': 'SRD',
  '厄瓜多尔': 'USD',
  '秘鲁': 'PEN',
  '玻利维亚': 'BOB',
  '智利': 'CLP',
  '阿根廷': 'ARS',
  '乌拉圭': 'UYU',
  '巴拉圭': 'PYG',
  '巴西': 'BRL',
  '法属圭亚那': 'EUR',
  '马提尼克': 'EUR',
  '瓜德罗普': 'EUR',
  '圣皮埃尔和密克隆': 'EUR',
  '新喀里多尼亚': 'XPF',
  '法属波利尼西亚': 'XPF',
  '瓦利斯和富图纳': 'XPF',
  '留尼汪': 'EUR',
  '马约特': 'EUR',
  '法属南部和南极领地': 'EUR',
  '摩洛哥': 'MAD',
  '阿尔及利亚': 'DZD',
  '突尼斯': 'TND',
  '利比亚': 'LYD',
  '埃及': 'EGP',
  '毛里塔尼亚': 'MRO',
  '马里': 'XOF',
  '布基纳法索': 'XOF',
  '塞内加尔': 'XOF',
  '几内亚': 'GNF',
  '几内亚比绍': 'GWP',
  '佛得角': 'CVE',
  '冈比亚': 'GMD',
  '塞拉利昂': 'SLL',
  '利比里亚': 'LRD',
  '科特迪瓦': 'XOF',
  '加纳': 'GHS',
  '多哥': 'XOF',
  '贝宁': 'XOF',
  '尼日尔': 'XOF',
  '尼日利亚': 'NGN',
  '喀麦隆': 'XAF',
  '中非': 'XAF',
  '乍得': 'XAF',
  '赤道几内亚': 'XAF',
  '加蓬': 'XAF',
  '刚果（布）': 'XAF',
  '刚果（金）': 'CDF',
  '安哥拉': 'AOA',
  '赞比亚': 'ZMW',
  '马拉维': 'MWK',
  '莫桑比克': 'MZN',
  '坦桑尼亚': 'TZS',
  '布隆迪': 'BIF',
  '卢旺达': 'RWF',
  '乌干达': 'UGX',
  '肯尼亚': 'KES',
  '南苏丹': 'SSP',
  '苏丹': 'SDG',
  '埃塞俄比亚': 'ETB',
  '厄立特里亚': 'ERN',
  '吉布提': 'DJF',
  '索马里': 'SOS',
  '利比亚': 'LYD',
  '博茨瓦纳': 'BWP',
  '莱索托': 'LSL',
  '斯威士兰': 'SZL',
  '纳米比亚': 'NAD',
  '南非': 'ZAR',
  '津巴布韦': 'ZWG',
  '科摩罗': 'KMF',
  '马达加斯加': 'MGA',
  '毛里求斯': 'MUR',
  '塞舌尔': 'SCR',
  '马尔代夫': 'MVR',
  '斯里兰卡': 'LKR',
  '印度': 'INR',
  '尼泊尔': 'NPR',
  '不丹': 'BTN',
  '孟加拉国': 'BDT',
  '巴基斯坦': 'PKR',
  '阿富汗': 'AFN',
  '伊朗': 'IRR',
  '伊拉克': 'IQD',
  '约旦': 'JOD',
  '科威特': 'KWD',
  '黎巴嫩': 'LBP',
  '阿曼': 'OMR',
  '卡塔尔': 'QAR',
  '沙特阿拉伯': 'SAR',
  '叙利亚': 'SYP',
  '阿联酋': 'AED',
  '也门': 'YER',
  '巴林': 'BHD',
  '以色列': 'ILS',
  '巴勒斯坦': 'ILS',
  '土耳其': 'TRY',
  '塞浦路斯': 'EUR',
  '北塞浦路斯土耳其共和国': 'TRY',
  '格鲁吉亚': 'GEL',
  '亚美尼亚': 'AMD',
  '阿塞拜疆': 'AZN',
  '俄罗斯': 'RUB',
  '乌克兰': 'UAH',
  '白俄罗斯': 'BYN',
  '摩尔多瓦': 'MDL',
  '波兰': 'PLN',
  '斯洛伐克': 'EUR',
  '斯洛文尼亚': 'EUR',
  '匈牙利': 'HUF',
  '捷克': 'CZK',
  '奥地利': 'EUR',
  '比利时': 'EUR',
  '荷兰': 'EUR',
  '卢森堡': 'EUR',
  '德国': 'EUR',
  '法国': 'EUR',
  '意大利': 'EUR',
  '西班牙': 'EUR',
  '葡萄牙': 'EUR',
  '爱尔兰': 'EUR',
  '芬兰': 'EUR',
  '希腊': 'EUR',
  '瑞典': 'SEK',
  '挪威': 'NOK',
  '丹麦': 'DKK',
  '冰岛': 'ISK',
  '英国': 'GBP',
  '瑞士': 'CHF',
  '列支敦士登': 'CHF',
  '塞尔维亚': 'RSD',
  '克罗地亚': 'HRK',
  '黑山': 'EUR',
  '马其顿': 'MKD',
  '阿尔巴尼亚': 'ALL',
  '保加利亚': 'BGN',
  '罗马尼亚': 'RON',
  '爱沙尼亚': 'EUR',
  '拉脱维亚': 'EUR',
  '立陶宛': 'EUR',
  '波斯尼亚和黑塞哥维那': 'BAM',
  '科索沃': 'EUR',
  '法罗群岛': 'DKK',
  '格陵兰': 'DKK',
  '奥兰群岛': 'EUR',
  '马耳他': 'EUR',
  '安道尔': 'EUR',
  '摩纳哥': 'EUR',
  '圣马力诺': 'EUR',
  '梵蒂冈': 'EUR',
  '根西岛': 'GBP',
  '泽西岛': 'GBP',
  '马恩岛': 'GBP',
  '直布罗陀': 'GIP',
  '福克兰群岛': 'FKP',
  '圣赫勒拿': 'SHP',
  '蒙特塞拉特': 'XCD',
  '安圭拉': 'XCD',
  '英属维尔京群岛': 'USD',
  '开曼群岛': 'KYD',
  '特克斯和凯科斯群岛': 'USD',
  '百慕大': 'BMD',
  '巴哈马': 'BSD',
  '伯利兹': 'BZD',
  '危地马拉': 'GTQ',
  '洪都拉斯': 'HNL',
  '萨尔瓦多': 'USD',
  '尼加拉瓜': 'NIO',
  '哥斯达黎加': 'CRC',
  '巴拿马': 'USD',
  '古巴': 'CUP',
  '多米尼加': 'DOP',
  '海地': 'HTG',
  '牙买加': 'JMD',
  '巴巴多斯': 'BBD',
  '特立尼达和多巴哥': 'TTD',
  '格林纳达': 'XCD',
  '圣卢西亚': 'XCD',
  '圣基茨和尼维斯': 'XCD',
  '圣文森特和格林纳丁斯': 'XCD',
  '多米尼克': 'XCD',
  '安提瓜和巴布达': 'XCD',
  '阿鲁巴': 'AWG',
  '库拉索': 'XCG',
  '圣马丁': 'XCG',
  '圣巴托洛缪': 'EUR',
  '法属圣马丁': 'EUR',
  '英属维尔京群岛': 'USD',
  '美属维尔京群岛': 'USD',
  '波多黎各': 'USD',
  '哥伦比亚': 'COP',
  '委内瑞拉': 'VES',
  '圭亚那': 'GYD',
  '苏里南': 'SRD',
  '厄瓜多尔': 'USD',
  '秘鲁': 'PEN',
  '玻利维亚': 'BOB',
  '智利': 'CLP',
  '阿根廷': 'ARS',
  '乌拉圭': 'UYU',
  '巴拉圭': 'PYG',
  '巴西': 'BRL',
  '法属圭亚那': 'EUR',
  '马提尼克': 'EUR',
  '瓜德罗普': 'EUR',
  '圣皮埃尔和密克隆': 'EUR',
  '新喀里多尼亚': 'XPF',
  '法属波利尼西亚': 'XPF',
  '瓦利斯和富图纳': 'XPF',
  '留尼汪': 'EUR',
  '马约特': 'EUR',
  '法属南部和南极领地': 'EUR',
  '摩洛哥': 'MAD',
  '阿尔及利亚': 'DZD',
  '突尼斯': 'TND',
  '利比亚': 'LYD',
  '埃及': 'EGP',
  '毛里塔尼亚': 'MRO',
  '马里': 'XOF',
  '布基纳法索': 'XOF',
  '塞内加尔': 'XOF',
  '几内亚': 'GNF',
  '几内亚比绍': 'GWP',
  '佛得角': 'CVE',
  '冈比亚': 'GMD',
  '塞拉利昂': 'SLL',
  '利比里亚': 'LRD',
  '科特迪瓦': 'XOF',
  '加纳': 'GHS',
  '多哥': 'XOF',
  '贝宁': 'XOF',
  '尼日尔': 'XOF',
  '尼日利亚': 'NGN',
  '喀麦隆': 'XAF',
  '中非': 'XAF',
  '乍得': 'XAF',
  '赤道几内亚': 'XAF',
  '加蓬': 'XAF',
  '刚果（布）': 'XAF',
  '刚果（金）': 'CDF',
  '安哥拉': 'AOA',
  '赞比亚': 'ZMW',
  '马拉维': 'MWK',
  '莫桑比克': 'MZN',
  '坦桑尼亚': 'TZS',
  '布隆迪': 'BIF',
  '卢旺达': 'RWF',
  '乌干达': 'UGX',
  '肯尼亚': 'KES',
  '南苏丹': 'SSP',
  '苏丹': 'SDG',
  '埃塞俄比亚': 'ETB',
  '厄立特里亚': 'ERN',
  '吉布提': 'DJF',
  '索马里': 'SOS',
  '利比亚': 'LYD',
  '博茨瓦纳': 'BWP',
  '莱索托': 'LSL',
  '斯威士兰': 'SZL',
  '纳米比亚': 'NAD',
  '南非': 'ZAR',
  '津巴布韦': 'ZWG',
  '科摩罗': 'KMF',
  '马达加斯加': 'MGA',
  '毛里求斯': 'MUR',
  '塞舌尔': 'SCR',
  '马尔代夫': 'MVR',
  '斯里兰卡': 'LKR',
  '印度': 'INR',
  '尼泊尔': 'NPR',
  '不丹': 'BTN',
  '孟加拉国': 'BDT',
  '巴基斯坦': 'PKR',
  '阿富汗': 'AFN',
  '伊朗': 'IRR',
  '伊拉克': 'IQD',
  '约旦': 'JOD',
  '科威特': 'KWD',
  '黎巴嫩': 'LBP',
  '阿曼': 'OMR',
  '卡塔尔': 'QAR',
  '沙特阿拉伯': 'SAR',
  '叙利亚': 'SYP',
  '阿联酋': 'AED',
  '也门': 'YER',
  '巴林': 'BHD',
  '以色列': 'ILS',
  '巴勒斯坦': 'ILS',
  '土耳其': 'TRY',
  '塞浦路斯': 'EUR',
  '北塞浦路斯土耳其共和国': 'TRY',
  '格鲁吉亚': 'GEL',
  '亚美尼亚': 'AMD',
  '阿塞拜疆': 'AZN',
  '俄罗斯': 'RUB',
  '乌克兰': 'UAH',
  '白俄罗斯': 'BYN',
  '摩尔多瓦': 'MDL',
  '波兰': 'PLN',
  '斯洛伐克': 'EUR',
  '斯洛文尼亚': 'EUR',
  '匈牙利': 'HUF',
  '捷克': 'CZK',
  '奥地利': 'EUR',
  '比利时': 'EUR',
  '荷兰': 'EUR',
  '卢森堡': 'EUR',
  '德国': 'EUR',
  '法国': 'EUR',
  '意大利': 'EUR',
  '西班牙': 'EUR',
  '葡萄牙': 'EUR',
  '爱尔兰': 'EUR',
  '芬兰': 'EUR',
  '希腊': 'EUR',
  '瑞典': 'SEK',
  '挪威': 'NOK',
  '丹麦': 'DKK',
  '冰岛': 'ISK',
  '英国': 'GBP',
  '瑞士': 'CHF',
  '列支敦士登': 'CHF',
  '塞尔维亚': 'RSD',
  '克罗地亚': 'HRK',
  '黑山': 'EUR',
  '马其顿': 'MKD',
  '阿尔巴尼亚': 'ALL',
  '保加利亚': 'BGN',
  '罗马尼亚': 'RON',
  '爱沙尼亚': 'EUR',
  '拉脱维亚': 'EUR',
  '立陶宛': 'EUR',
  '波斯尼亚和黑塞哥维那': 'BAM',
  '科索沃': 'EUR',
  '法罗群岛': 'DKK',
  '格陵兰': 'DKK',
  '奥兰群岛': 'EUR',
  '马耳他': 'EUR',
  '安道尔': 'EUR',
  '摩纳哥': 'EUR',
  '圣马力诺': 'EUR',
  '梵蒂冈': 'EUR',
  '根西岛': 'GBP',
  '泽西岛': 'GBP',
  '马恩岛': 'GBP',
  '直布罗陀': 'GIP',
  '福克兰群岛': 'FKP',
  '圣赫勒拿': 'SHP',
  '蒙特塞拉特': 'XCD',
  '安圭拉': 'XCD',
  '英属维尔京群岛': 'USD',
  '开曼群岛': 'KYD',
  '特克斯和凯科斯群岛': 'USD',
  '百慕大': 'BMD',
  '巴哈马': 'BSD',
  '伯利兹': 'BZD',
  '危地马拉': 'GTQ',
  '洪都拉斯': 'HNL',
  '萨尔瓦多': 'USD',
  '尼加拉瓜': 'NIO',
  '哥斯达黎加': 'CRC',
  '巴拿马': 'USD',
  '古巴': 'CUP',
  '多米尼加': 'DOP',
  '海地': 'HTG',
  '牙买加': 'JMD',
  '巴巴多斯': 'BBD',
  '特立尼达和多巴哥': 'TTD',
  '格林纳达': 'XCD',
  '圣卢西亚': 'XCD',
  '圣基茨和尼维斯': 'XCD',
  '圣文森特和格林纳丁斯': 'XCD',
  '多米尼克': 'XCD',
  '安提瓜和巴布达': 'XCD',
  '阿鲁巴': 'AWG',
  '库拉索': 'XCG',
  '圣马丁': 'XCG',
  '圣巴托洛缪': 'EUR',
  '法属圣马丁': 'EUR',
  '英属维尔京群岛': 'USD',
  '美属维尔京群岛': 'USD',
  '波多黎各': 'USD',
  '哥伦比亚': 'COP',
  '委内瑞拉': 'VES',
  '圭亚那': 'GYD',
  '苏里南': 'SRD',
  '厄瓜多尔': 'USD',
  '秘鲁': 'PEN',
  '玻利维亚': 'BOB',
  '智利': 'CLP',
  '阿根廷': 'ARS',
  '乌拉圭': 'UYU',
  '巴拉圭': 'PYG',
  '巴西': 'BRL',
  '法属圭亚那': 'EUR',
  '马提尼克': 'EUR',
  '瓜德罗普': 'EUR',
  '圣皮埃尔和密克隆': 'EUR',
  '新喀里多尼亚': 'XPF',
  '法属波利尼西亚': 'XPF',
  '瓦利斯和富图纳': 'XPF',
  '留尼汪': 'EUR',
  '马约特': 'EUR',
  '法属南部和南极领地': 'EUR',
  '摩洛哥': 'MAD',
  '阿尔及利亚': 'DZD',
  '突尼斯': 'TND',
  '利比亚': 'LYD',
  '埃及': 'EGP',
  '毛里塔尼亚': 'MRO',
  '马里': 'XOF',
  '布基纳法索': 'XOF',
  '塞内加尔': 'XOF',
  '几内亚': 'GNF',
  '几内亚比绍': 'GWP',
  '佛得角': 'CVE',
  '冈比亚': 'GMD',
  '塞拉利昂': 'SLL',
  '利比里亚': 'LRD',
  '科特迪瓦': 'XOF',
  '加纳': 'GHS',
  '多哥': 'XOF',
  '贝宁': 'XOF',
  '尼日尔': 'XOF',
  '尼日利亚': 'NGN',
  '喀麦隆': 'XAF',
  '中非': 'XAF',
  '乍得': 'XAF',
  '赤道几内亚': 'XAF',
  '加蓬': 'XAF',
  '刚果（布）': 'XAF',
  '刚果（金）': 'CDF',
  '安哥拉': 'AOA',
  '赞比亚': 'ZMW',
  '马拉维': 'MWK',
  '莫桑比克': 'MZN',
  '坦桑尼亚': 'TZS',
  '布隆迪': 'BIF',
  '卢旺达': 'RWF',
  '乌干达': 'UGX',
  '肯尼亚': 'KES',
  '南苏丹': 'SSP',
  '苏丹': 'SDG',
  '埃塞俄比亚': 'ETB',
  '厄立特里亚': 'ERN',
  '吉布提': 'DJF',
  '索马里': 'SOS',
  '利比亚': 'LYD',
  '博茨瓦纳': 'BWP',
  '莱索托': 'LSL',
  '斯威士兰': 'SZL',
  '纳米比亚': 'NAD',
  '南非': 'ZAR',
  '津巴布韦': 'ZWG',
  '科摩罗': 'KMF',
  '马达加斯加': 'MGA',
  '毛里求斯': 'MUR',
  '塞舌尔': 'SCR',
  '马尔代夫': 'MVR',
  '斯里兰卡': 'LKR',
  '印度': 'INR',
  '尼泊尔': 'NPR',
  '不丹': 'BTN',
  '孟加拉国': 'BDT',
  '巴基斯坦': 'PKR',
  '阿富汗': 'AFN',
  '伊朗': 'IRR',
  '伊拉克': 'IQD',
  '约旦': 'JOD',
  '科威特': 'KWD',
  '黎巴嫩': 'LBP',
  '阿曼': 'OMR',
  '卡塔尔': 'QAR',
  '沙特阿拉伯': 'SAR',
  '叙利亚': 'SYP',
  '阿联酋': 'AED',
  '也门': 'YER',
  '巴林': 'BHD',
  '以色列': 'ILS',
  '巴勒斯坦': 'ILS',
  '土耳其': 'TRY'
}

// 从 store.currencies_list 动态构建所有可搜索字符串 → code 的映射
// 优先级：code（原始） > translations.zho（中文官方名） > currencies.name（币种英文名） > name（国家英文名）
function buildCodeIndex() {
  const idx = {}
  for (const item of store.currencies_list) {
    const code = item.currencies?.code
    if (!code) continue
    // 1. code 本身（大写 + 小写）
    idx[code] = code
    idx[code.toLowerCase()] = code
    // 2. translations.zho.official / common（restcountries 中文名）
    const zh = item.translations?.zho
    if (zh) {
      if (zh.official) idx[zh.official] = code
      if (zh.common) idx[zh.common] = code
    }
    // 3. currencies.name（币种英文名，如 "US Dollar"）
    if (item.currencies?.name) idx[item.currencies.name] = code
    // 4. name / officialName（国家英文名，如 "United States"）
    if (item.name) idx[item.name] = code
    if (item.officialName) idx[item.officialName] = code
  }
  // 5. 硬编码 CN_ALIASES 兜底（覆盖中文名/简称/地区名的写法）
  for (const [alias, c] of Object.entries(CN_ALIASES)) {
    // 硬编码不覆盖 store 里已有的（store 数据更新后更准确）
    if (!idx[alias]) idx[alias] = c
  }
  return idx
}

// 解析"数值+币种标识"。币种标识可以是：三字码、中文名、英文名、简称
// 返回 { amount, code(大写), rawCode }，非法返回 null
function parseSrcInput(input) {
  const raw = (input ?? '').trim()
  if (!raw) return null
  // 先尝试"数值 + 任意非空尾巴"：尾巴可能是字母 code、中文币种名或英文币种名
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(.+)$/)
  if (!match) return null
  const amount = match[1]
  const tail = match[2].trim()
  if (!tail) return null

  const idx = buildCodeIndex()
  // 精确匹配优先（code 或完整中文名）
  if (idx[tail]) {
    const code = idx[tail]
    return { amount, code, rawCode: tail }
  }
  // 包含匹配：如果尾巴是 "美"、"欧"、"日" 这种单字简称，做最长匹配
  // 按长度降序遍历所有 key，匹配 tail 开头的 key
  const sortedKeys = Object.keys(idx).sort((a, b) => b.length - a.length)
  for (const k of sortedKeys) {
    if (tail.startsWith(k)) {
      return { amount, code: idx[k], rawCode: tail }
    }
  }
  return null
}

// 查源币种与 CNY 的 rate（rate = 1USD 兑该币种数量）
function findCurrencies(code) {
  const src = store.currencies_list.find(
    i => i.currencies.code.toUpperCase() === code
  )
  const cny = store.currencies_list.find(
    i => i.currencies.code.toUpperCase() === 'CNY'
  )
  if (!src || !cny) return null
  const srcRate = src.currencies.rate
  const cnyRate = cny.currencies.rate
  if (!srcRate || !cnyRate) return null
  return { src, cny, srcRate, cnyRate }
}

// 输入框聚焦自动全选：便于直接输入覆盖旧值
function selectAll(e) {
  e.target.select()
}

// 上行输入：
//   - 空 → 解除锁定，清空状态
//   - "数值+3字母"格式 → 查币种：
//       · 有效币种 ≠ 当前锁定 → 切换锁定
//       · 有效币种 = 当前锁定 → 只更新数值（保持锁定）
//       · 未知币种 → 非锁定态显示"未知"；锁定态忽略
//   - 纯数字 → 锁定态下只更新数值部分；非锁定态不处理
function onSrcInput(e) {
  srcRaw.value = e.target.value
  const raw = srcRaw.value.trim()
  if (!raw) {
    srcLocked.value = false
    srcName.value = '源币种'
    srcCode.value = '---'
    cnyVal.value = ''
    return
  }

  const parsed = parseSrcInput(raw)
  if (!parsed) {
    // 无币种代码：锁定态下只接受纯数字（单独改数值部分），其他格式忽略
    if (srcLocked.value && /^[\d.]+$/.test(raw)) {
      updateCnyWithAmount(raw)
    }
    return
  }

  // 有币种代码 → 查有效性
  const r = findCurrencies(parsed.code)
  if (!r) {
    // 未知币种：只有非锁定态才切到"未知"
    if (!srcLocked.value) {
      srcName.value = '未知币种'
      srcCode.value = parsed.rawCode.toUpperCase()
      cnyVal.value = ''
    }
    return
  }

  // 有效币种 → 切换锁定 + 更新显示
  const switched = !srcLocked.value || srcCode.value !== r.src.currencies.code
  if (switched) {
    srcLocked.value = true
    srcName.value = r.src.name
    srcCode.value = r.src.currencies.code
  }
  try {
    cnyVal.value = new Decimal(parsed.amount).times(r.cnyRate).div(r.srcRate).toFixed(2)
  } catch {
    cnyVal.value = ''
  }
}

// 锁定态下纯数字输入时，用已锁定币种算 CNY
function updateCnyWithAmount(amountStr) {
  const r = findCurrencies(srcCode.value)
  if (!r) return
  try {
    cnyVal.value = new Decimal(amountStr).times(r.cnyRate).div(r.srcRate).toFixed(2)
  } catch {
    cnyVal.value = ''
  }
}

// 下行输入：反向算源币种（只替换数值，币种代码跟随已锁定的 srcCode）
function onCnyInput(e) {
  cnyVal.value = e.target.value
  const raw = (cnyVal.value ?? '').trim()
  if (!raw) return
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return
  // 锁定态用 srcCode；非锁定态用当前 srcRaw 里解析的 code
  const effectiveCode = srcLocked.value ? srcCode.value : (parseSrcInput(srcRaw.value)?.code ?? srcCode.value)
  const r = findCurrencies(effectiveCode)
  if (!r) return
  try {
    const srcAmount = new Decimal(raw).times(r.srcRate).div(r.cnyRate)
    // 锁定态：只回填纯数值（保持"锁定后只输数字"的契约）
    // 非锁定态：回填"数值+code"（用户能看到当前币种）
    srcRaw.value = srcLocked.value
      ? srcAmount.toFixed(2)
      : `${srcAmount.toFixed(2)}${effectiveCode}`
  } catch {
    // 反算失败不回填
  }
}

// ==================== 同步换算 ====================
// 加币种选择面板展开状态
const showPicker = ref(false)
// 当前正在编辑的币种 code（避免被动刷新覆盖正在编辑的输入框）
let editingCode = null
// 正在编辑的行的用户原始输入值（key = code，用户聚焦输入时缓存，失焦时清空）
// 用户聚焦期间：input :value 显示此缓存值，完全由用户掌控，不被 toFixed 打断
const editingBuffer = ref({})

// 行显示值：正在编辑的行显示用户原始输入；其他行显示 toFixed(2)
function getRowDisplay(cur) {
  const code = cur.currencies.code
  if (editingBuffer.value[code] != null) {
    return editingBuffer.value[code]
  }
  const v = cur.currencies.value ?? 0
  return Number(v).toFixed(2)
}

// 行获得焦点：切为主动 + 存 editingBuffer
function onRowFocus(cur, e) {
  editingCode = cur.currencies.code
  becomeInitiative(cur)
  // 聚焦后本行显示 editingBuffer（初始为当前值的 toFixed 字符串），与 Vue 渲染同步
  editingBuffer.value[cur.currencies.code] = getRowDisplay(cur)
  nextTick(() => {
    if (e && e.target) e.target.select()
  })
}

// 行输入：更新 editingBuffer + 写 store + 同步其他被动
function onRowInput(cur, e) {
  const raw = (e.target.value ?? '').trim()
  // 任何输入（包括空、纯数字、非法格式）都先缓存——让输入框完全由用户掌控
  editingBuffer.value[cur.currencies.code] = raw
  becomeInitiative(cur)
  if (!raw) {
    cur.currencies.value = 0
    store.syncPassiveValues()
    return
  }
  if (/^-?\d+\.?\d*$/.test(raw)) {
    cur.currencies.value = Number(raw)
    store.syncPassiveValues()
  }
}

// 行失焦：清 editingBuffer，恢复 toFixed(2) 显示
function onRowBlur(cur) {
  editingCode = null
  delete editingBuffer.value[cur.currencies.code]
}

// 设为主动：清零其他 initiative，置当前为主动
function becomeInitiative(cur) {
  if (cur.currencies.initiative) return
  store.activeCurrency.forEach(item => {
    item.currencies.initiative = false
  })
  cur.currencies.initiative = true
}

// ==================== 初始化 ====================
// 复用 Home 的初始化逻辑：拉数据 + 种入默认 CNY/USD（store 有 guard，重复调用幂等）
onMounted(async () => {
  const today = new Date().toISOString().substring(0, 10)
  if (store.currencies_list.length === 0) {
    await store.load_all_countries_list()
  }
  if (store.syncDate !== today) {
    await store.updata_exchangeRates()
  }
  store.seedDefaultCurrencies()
})
</script>

<style scoped>
/* 壳：纵向栈，紧凑间距 */
.fh {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 6px;
  color: #fff;
  font-size: 12px;
}

/* 区块 */
.fh-sec {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fh-sec-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.62);
  letter-spacing: 0.04em;
  user-select: none;
}
.fh-add {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.85);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.fh-add:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

/* 行容器 */
.fh-rows,
.fh-sync-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 同步换算列表：最多 5 行（每行 30px + gap 4px ≈ 166px），超出滚动 */
.fh-sync-list {
  max-height: 166px;
  overflow-y: auto;
}
/* 加币种选择面板：自身不滚动，交给 addCurrency 内部列表滚动（--currency-list-max-h 约束列表高度） */
.fh-picker {
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  --currency-list-max-h: 150px;
}

/* 币种行：左删除 + 币种名 + 右对齐金额 + 三字码（单行紧凑） */
.crow {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  box-sizing: border-box;
  transition: background 0.12s, border-color 0.12s;
}
/* 主动币种（换算锚点）：仅保留左侧 2px 青绿锚点条。
   不使用整块青绿背景/青绿边框——那套"选中卡"视觉只属于加币种列表
   （.currency-item.is-selected），避免选中态观感"透传"到同步换算列表。
   正在编辑哪一行由输入框 :focus 的青色呼吸闪烁表达，背景/边框维持默认灰白。 */
.crow.is-init {
  border-left: 2px solid rgba(99, 226, 183, 0.85);
  padding-left: 7px;
}
/* 删除按钮：默认半透明，hover 提亮变红 */
.crow-del {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.35);
  cursor: pointer;
  border-radius: 3px;
  transition: color 0.12s, background 0.12s;
}
.crow-del:hover {
  color: rgba(255, 90, 90, 0.95);
  background: rgba(255, 90, 90, 0.12);
}
.crow-del svg {
  width: 10px;
  height: 10px;
  display: block;
  pointer-events: none;
}
.crow-name {
  flex: 0 0 auto;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 70px;
  user-select: none;
}
.crow-input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: #39ff14;
  font-size: 12px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 4px rgba(57, 255, 20, 0.35);
}
.crow-input::placeholder {
  color: rgba(255, 255, 255, 0.3);
}
.crow-code {
  flex: 0 0 auto;
  font-size: 10px;
  color: #39ff14;
  letter-spacing: 0.04em;
  user-select: none;
}

/* 选中的输入框：荧光「亮度高低」呼吸闪烁（青色 + 0.8s ease-in-out，
   亮度随文字颜色 + 荧光光晕同步起伏，节奏加快仍柔和） */
.crow-input:focus {
  animation: fh-flash 0.8s ease-in-out infinite;
}
@keyframes fh-flash {
  0%, 100% {
    color: #00ffff;
    text-shadow: 0 0 8px rgba(0, 255, 255, 0.8);
  }
  50% {
    color: rgba(0, 255, 255, 0.35);
    text-shadow: none;
  }
}

/* 滚动条暗色（4px 宽，半透明 thumb，透明 track——与 .currency-list / .floating-content 统一） */
.fh-sync-list::-webkit-scrollbar {
  width: 4px;
}
.fh-sync-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}
.fh-sync-list::-webkit-scrollbar-track {
  background: transparent;
}
</style>
