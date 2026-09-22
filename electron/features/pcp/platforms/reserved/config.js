// ============================================================
// 预留拓展位 平台配置 schema + 默认值（模板，未实现）
// 未配置（enabled=false）不参与流程；接入真实平台时复制本目录改为新平台 key
// ============================================================

export const configSchema = {
  enabled: {
    type: 'boolean', label: '启用 预留拓展位', default: false, required: true,
    help: '未实现，预留扩展位置。接入真实平台时补全配置项'
  }
}

export const defaults = { enabled: false }

export default { configSchema, defaults }
