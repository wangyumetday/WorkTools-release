// ============================================================
// O2 平台配置 schema + 默认值（模板，未实现，预留位置）
// 未配置（enabled=false）不参与流程；接入真实接口时补全字段
// ============================================================

export const configSchema = {
  enabled: {
    type: 'boolean', label: '启用 O2', default: false, required: true,
    help: '未实现，预留位置。接入真实接口时补全配置项'
  }
}

export const defaults = { enabled: false }

export default { configSchema, defaults }
