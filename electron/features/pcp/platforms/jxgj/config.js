// ============================================================
// JXGJ（锦绣国际）平台配置 schema + 默认值
// configSchema 驱动 PlatformConfig 页自动渲染 + 前置门禁 enabled 检查
// 修改配置项：调整此文件 schema/defaults，配置页与门禁自动适配
// ============================================================

export const configSchema = {
  enabled: {
    type: 'boolean',
    label: '启用 JXGJ（锦绣国际）',
    default: true,
    required: true,
    help: '作为源数据平台，必须启用才会进入步骤3'
  },
  floorPriceFormula: {
    type: 'formula',
    label: '底价公式（变量 cost = 成人总票价 CNY）',
    default: 'cost',
    required: true,
    help: '仅可用 + - * / 和括号，如 cost*1.1+50 / cost*(1-0.02)-20。得到"我们能接受的最低出价"'
  },
  // markupPercent: {
  //   type: 'number',
  //   label: '加成百分比（预留）',
  //   default: 0,
  //   show: false,
  //   help: '预留字段，当前未参与计算'
  // },
  // PriceRange: {
  //   type: 'PriceRange',
  //   label: '票价区间',
  //   default: [],
  //   show: false,
  //   required: true,
  //   help: '票价区间，格式为 [min, max,drop]，min 为最小票价，max 为最大票价，drop 减价金额，单位为 CNY'
  // },

}

export const defaults = {
  enabled: true,
  floorPriceFormula: 'cost',
  markupPercent: 0
}

export default { configSchema, defaults }
