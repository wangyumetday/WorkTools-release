// ============================================================
// TRIP（携程 OTA 低价看板）平台配置 schema + 默认值
// 只保留用户真正可配的两项：启用开关 + 每分钟请求上限（限流）
// 其余请求参数（服务地址/语言/行程类型/人数/舱等/渠道/特殊参数/超时等）
// 是原 o1.js 写在请求里的固定值，硬编码在 adapter.js 的 REQUEST_CONST，不进配置
// 业务员信息（王宇）同样写死在 adapter.js 导出模板的 Name/Remark 列
// 修改配置项：调整此文件 schema/defaults，配置页与门禁自动适配
// ============================================================

export const configSchema = {
  enabled: {
    type: 'boolean', label: '启用 TRIP（携程 OTA）', default: true, required: true,
    help: '作为 O 平台之一，至少启用一个 O 平台才会进入步骤4'
  },
  rateLimitPerMin: {
    type: 'number', label: '每分钟请求上限', default: 200, required: true,
    help: '携程 API 阈值（默认 200/分钟）。超量会触发 429 封禁，限流器会自动排队等待'
  }
}

export const defaults = {
  enabled: true,
  rateLimitPerMin: 200
}

export default { configSchema, defaults }