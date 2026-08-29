// ============================================================
// PCP 业务模式注册表（单一事实来源）
//
// 「业务模式」= 这次流程要产出什么：
//   policy     （政策导入） 生成政策导入文件（本轮唯一实现的数据产出）
//   floorCheck （底价检查） 生成底价检查文件（本轮先不关注其文件生成逻辑，数据流与 policy 共用）
//
// 与「运行模式」区分：
//   pipeline.mode:  'auto' | 'dev'   —— 跑法（自动跑到底 / 每步手动触发），可持久化
//   businessMode:   'policy' | 'floorCheck'
//                       —— 产什么，不持久化，每次启动回到默认
//
// 注意：两种业务模式共用同一条数据流（jxgj 舱位级行携带套餐信息 → trip 比价富化），
//       差异只发生在导出阶段；新增模式只需在 EXPORT 分支按 key 区分，不改 adapter。
// ============================================================

export const BUSINESS_MODES = [
  { key: 'policy', label: '政策导入' },
  { key: 'floorCheck', label: '底价检查' }
]

export const DEFAULT_BUSINESS_MODE = 'policy'

/** 校验业务模式 key 是否合法（不合法返回 null） */
export function isValidBusinessMode(key) {
  return BUSINESS_MODES.some(m => m.key === key) ? key : null
}

/** 取模式显示名（未知 key 回退到 key 本身，不做兜底业务赋值） */
export function businessModeLabel(key) {
  const m = BUSINESS_MODES.find(x => x.key === key)
  return m ? m.label : key
}