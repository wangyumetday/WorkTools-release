// ============================================================
// 机场三字码 → 城市三字码 转换
//
// 数据来源：IATA Resolution 011c（2021 年 10 月 Passenger Standards Conference 通过）
// 官方定义了 41 个多机场城市（MAC），共 89 个机场
// 大多数机场码 = 城市码（如 NKG 既是机场码也是城市码）
// 仅多机场城市的机场码 ≠ 城市码（如 PVG 机场 → SHA 城市）
//
// 设计：
//   1. 只存"机场码 ≠ 城市码"的 67 条映射，不存相同的（省内存）
//   2. 查不到时回退为机场码本身（覆盖所有非 MAC 机场）
//   3. 模块级常量，进程加载即驻留，O(1) 查询
// ============================================================

const MAC_MAPPING = {
  // AE 迪拜
  DWC: 'DXB',
  // AR 布宜诺斯艾利斯
  AEP: 'BUE', EZE: 'BUE',
  // AU 墨尔本
  AVV: 'MEL',
  // BE 布鲁塞尔
  CRL: 'BRU',
  // BR 贝洛奥里藏特
  CNF: 'BHZ', PLU: 'BHZ',
  // BR 里约热内卢
  GIG: 'RIO', SDU: 'RIO',
  // BR 圣保罗
  CGH: 'SAO', GRU: 'SAO', VCP: 'SAO',
  // CA 多伦多
  YTZ: 'YTO', YYZ: 'YTO',
  // CN 北京
  PEK: 'BJS', PKX: 'BJS',
  // CN 上海
  PVG: 'SHA',
  // ES 特内里费
  TFN: 'TCI', TFS: 'TCI',
  // FR 巴黎
  CDG: 'PAR', ORY: 'PAR',
  // GB 贝尔法斯特
  BHD: 'BFS',
  // GB 伦敦
  LCY: 'LON', LGW: 'LON', LHR: 'LON', LTN: 'LON', STN: 'LON',
  // ID 雅加达
  CGK: 'JKT', HLP: 'JKT',
  // ID 日惹
  YIA: 'JOG',
  // IR 德黑兰
  IKA: 'THR',
  // IS 雷克雅未克
  KEF: 'REK', RKV: 'REK',
  // IT 米兰
  BGY: 'MIL', LIN: 'MIL', MXP: 'MIL',
  // IT 罗马
  CIA: 'ROM', FCO: 'ROM',
  // JP 名古屋
  NKM: 'NGO',
  // JP 大阪
  ITM: 'OSA', KIX: 'OSA', UKB: 'OSA',
  // JP 札幌
  CTS: 'SPK', OKD: 'SPK',
  // JP 东京
  HND: 'TYO', NRT: 'TYO',
  // KR 首尔
  GMP: 'SEL', ICN: 'SEL',
  // SL 圣卢西亚
  UVF: 'SLU',
  // NO 奥斯陆
  TRF: 'OSL',
  // RU 莫斯科
  DME: 'MOW', SVO: 'MOW', VKO: 'MOW',
  // SE 斯德哥尔摩
  ARN: 'STO', BMA: 'STO',
  // SN 达喀尔
  DSS: 'DKR',
  // TH 曼谷
  DMK: 'BKK',
  // TR 安卡拉
  ESB: 'ANK',
  // TR 伊斯坦布尔
  ISL: 'IST', SAW: 'IST',
  // TW 台北
  TSA: 'TPE',
  // UA 基辅
  KBP: 'IEV',
  // US 芝加哥
  MDW: 'CHI', ORD: 'CHI',
  // US 达拉斯
  DAL: 'DFW',
  // US 休斯顿
  IAH: 'HOU',
  // US 纽约
  JFK: 'NYC', LGA: 'NYC',
  // US 华盛顿
  DCA: 'WAS', IAD: 'WAS',
  // ZA 约翰内斯堡
  HLA: 'JNB',
}

/**
 * 机场三字码 → 城市三字码
 * @param {string} airportCode  IATA 机场三字码（如 'PVG'）
 * @returns {string}  城市三字码（如 'SHA'）；查不到则返回原始机场码
 */
export function airportToCity(airportCode) {
  if (!airportCode) return airportCode
  return MAC_MAPPING[airportCode] ?? airportCode
}

export default { airportToCity }
