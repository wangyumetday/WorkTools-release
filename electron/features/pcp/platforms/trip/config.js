// TRIP（携程 OTA 低价看板）平台配置 schema + 默认值
// 只保留用户真正可配的四项：启用开关 + 每分钟请求上限（限流）+ 比携程低多少元（调价口径）+ 渠道（channel）
// 其余请求参数（服务地址/语言/行程类型/人数/舱等/子渠道/特殊参数/超时等）
// 是原 o1.js 写在请求里的固定值，硬编码在 adapter.js 的 REQUEST_CONST，不进配置
// 业务员信息（王宇）同样写死在 adapter.js 导出模板的 Name/Remark 列
// ★ channel（2026-09-24 起配置化）：不同渠道返回的报价集不同——
//   实测我方未外显报价（isOwn=true）只在主渠道（FlightIntlOnline/Mobile/不传）返回，
//   EnglishSite 渠道查不到我方投放 → 统计恒 0；默认不传（携程侧按全量主渠道返回）
// 修改配置项：调整此文件 schema/defaults，配置页与门禁自动适配

export const configSchema = {
  enabled: {
    type: 'boolean', label: '启用 TRIP（携程 OTA）', default: true, required: true,
    help: '作为 O 平台之一，至少启用一个 O 平台才会进入步骤4'
  },
  rateLimitPerMin: {
    type: 'number', label: '每分钟请求上限', default: 200, required: true,
    help: '携程 API 阈值（默认 200/分钟）。超量会触发 429 封禁，限流器会自动排队等待'
  },
  cutOffset: {
    type: 'number', label: '比携程低多少元', default: 1, required: true,
    help: '我方报价相对携程价的让利幅度（整数）。写入「调价固定加减钱」= 向下取整(携程价 − 官网价) − 本值；' +
      '默认 1（比携程价低 1 元）。填 2 即比携程价低 2 元'
  },
  channels: {
    type: 'multiselect', label: '携程请求渠道', default: ['FlightIntlOnline', 'EnglishSite'],
    options: [
      { label: '不传（默认主渠道）', value: '', group: '主渠道（选一个即可，可多选）' },
      { label: 'FlightIntlOnline（主站）', value: 'FlightIntlOnline', group: '主渠道（选一个即可，可多选）' },
      { label: 'Mobile', value: 'Mobile', group: '主渠道（选一个即可，可多选）' },
      { label: 'EnglishSite', value: 'EnglishSite', group: 'EnglishSite（独立口径·建议必勾）' }
    ],
    help: '低价看板查询渠道。实测（RS/FA/XQ 三航司，2026-09-27）：主渠道组内各值返回集完全一致（选一个即可；主渠道组全不选=请求体不携带 channel 字段）；EnglishSite 是独立口径、与主渠道互有独有报价（建议必勾，XQ 尤其依赖）。每勾一项发一次请求（并发）、结果合并去重；默认组合 = 主站主渠道 + EnglishSite（2 个请求）'
  }
}

export const defaults = {
  enabled: true,
  rateLimitPerMin: 200,
  cutOffset: 1,
  channels: ['FlightIntlOnline', 'EnglishSite']
}

export default { configSchema, defaults }