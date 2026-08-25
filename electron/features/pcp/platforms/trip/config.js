// ============================================================
// TRIP（携程 OTA 低价看板）平台配置 schema + 默认值
// O1_DEFAULTS 上移为 defaults，配置项全部可配
// 业务员信息（agentName/agentRemark）写入导出 xlsx 的 Name/Remark 列
// 修改配置项：调整此文件 schema/defaults，配置页与门禁自动适配
// ============================================================

export const configSchema = {
  enabled: {
    type: 'boolean', label: '启用 TRIP（携程 OTA）', default: true, required: true,
    help: '作为 O 平台之一，至少启用一个 O 平台才会进入步骤4'
  },
  baseURL: {
    type: 'string', label: '服务地址', default: 'https://intlresource-exchdata.ctrip.com/api/lowPriceSearch',
    help: '生产 / 测试二选一'
  },
  language: { type: 'string', label: '语言', default: 'zh_CN' },
  tripType: { type: 'string', label: '行程类型（OW/RT/MT）', default: 'OW' },
  travelerCount: { type: 'number', label: '成人人数（1-9）', default: 1 },
  seatGrade: { type: 'string', label: '舱等（Y/C/F）', default: 'Y' },
  channel: {
    type: 'string', label: '主渠道', default: 'EnglishSite',
    help: 'FlightIntlOnline / EnglishSite / Mobile'
  },
  subChannel: { type: 'number', label: '子渠道（主站传 0）', default: 0 },
  specialParam: { type: 'string', label: '特殊参数', default: 'SpecialSupply-特价产品' },
  validatingCarrier: { type: 'string', label: '开票航司二字码', default: '' },
  childTravelerCount: { type: 'number', label: '儿童人数', default: 0 },
  timeout: { type: 'number', label: '请求超时(ms)', default: 10000 },
  agentName: { type: 'string', label: '业务员名（写入政策 Name 列）', default: '' },
  agentRemark: { type: 'string', label: '业务员备注（写入政策 Remark 列）', default: '' }
}

export const defaults = {
  enabled: true,
  baseURL: 'https://intlresource-exchdata.ctrip.com/api/lowPriceSearch',
  language: 'zh_CN',
  tripType: 'OW',
  travelerCount: 1,
  seatGrade: 'Y',
  channel: 'EnglishSite',
  subChannel: 0,
  specialParam: 'SpecialSupply-特价产品',
  validatingCarrier: '',
  childTravelerCount: 0,
  timeout: 10000,
  agentName: '',
  agentRemark: ''
}

export default { configSchema, defaults }
