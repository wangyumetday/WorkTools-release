// ============================================================
// PCP 字段名常量集中定义
// 职责：把 a1/a2/a3 阶段数据 + 各平台响应中跨模块硬编码的字段名
//       集中到一处，改字段名时只改这里，调用方自动跟随。
//
// 使用约定：
//   - 对象 key 用合法标识符（含中文），value 是真实字段名字符串
//   - 访问数据字段时用 bracket 形式：item[A3_FIELDS.C出发机场]
//   - JSDoc typedef 里的字段名是文档，不引用这里的常量
//   - 对象字面量里的属性声明（{ CF_jichang: ... }）保持标识符形式不改
// ============================================================

// a1 阶段字段：parseXlsx 产出的原始行（id/CF_jichang/DD_jichang/CH_city/DD_city/hangsi/cangwei_str）
export const A1_FIELDS = {
  id: 'id',
  CF_jichang: 'CF_jichang',
  DD_jichang: 'DD_jichang',
  CH_city: 'CH_city',
  DD_city: 'DD_city',
  hangsi: 'hangsi',
  cangwei_str: 'cangwei_str'
}

// a2 阶段字段：jxgj 增强后追加的字段（date_obj/cangwei_arr + 舱位项里的价/底价）
export const A2_FIELDS = {
  date_obj: 'date_obj',
  cangwei_arr: 'cangwei_arr',
  C成人总票价_CNY_INT: 'C成人总票价_CNY_INT',
  dijia: 'dijia',
  TuoYunXingLi:'TuoYunXingLi'
}

// a3 阶段字段 / HR（「底价检查」人看）字段：O 平台比价结果行
export const A3_FIELDS = {
  _platform: '_platform',
  _floorMeta: '_floorMeta',
  // 比价结果标记：'won'（可以胜出）/ 'lost'（无法胜出）
  //   仅供导入政策文件过滤用，不写入任何 xlsx 列
  _outcome: '_outcome',
  H航班号: 'H航班号',
  H航司名: 'H航司名',
  C出发机场: 'C出发机场',
  D到达机场: 'D到达机场',
  C出发城市: 'C出发城市',
  D到达城市: 'D到达城市',
  C舱位: 'C舱位',
  C出发时间_Date: 'C出发时间_Date',
  D到达时间_Date: 'D到达时间_Date',
  仓等: '仓等',
  C成人总票价_CNY: 'C成人总票价_CNY',
  XC_dijia: 'XC_dijia',
  CUT_VALUE: 'CUT_VALUE',
  TuoYunXingLi:'TuoYunXingLi',
  isOwn:'isOwn'
}

// trip（携程低价看板）响应字段：flights[] / lowPrices[].prices[] 里的字段
export const TRIP_RESPONSE_FIELDS = {
  flightNo: 'flightNo',
  departAirport: 'departAirport',
  arriveAirport: 'arriveAirport',
  takeOffDateTime: 'takeOffDateTime',
  flightId: 'flightId',
  flightRefs: 'flightRefs',
  prices: 'prices',
  baggage: 'baggage',
  seatClass:'seatClass',
  showState: 'showState',
  isOwn: 'isOwn',
  sortIndicator: 'sortIndicator'
}

// jxgj（锦绣国际）响应字段：Content.List[] 航班项里的字段
export const JXGJ_RESPONSE_FIELDS = {
  C成人总票价_CNY: 'C成人总票价_CNY',
  C出发时间_Date: 'C出发时间_Date',
  C出发日期: 'C出发日期'
}

export default {
  A1_FIELDS, A2_FIELDS, A3_FIELDS, TRIP_RESPONSE_FIELDS, JXGJ_RESPONSE_FIELDS
}
