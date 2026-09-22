// ============================================================
// PCP ConfigManager - 平台配置管理器（schema 驱动重构）
// 职责：管理各平台（JXGJ/TRIP/O2/O3）的异构配置
//
// 重构要点（阶段1）：
//   - 默认配置不再硬编码，运行时从 registry 各 adapter.defaults 构建
//   - 每平台配置项异构（JXGJ 公式 / TRIP 时间段+一整套 / O2-O3 简单）
//   - getPlatformConfig(key) 返回该平台合并后的配置（defaults + 用户保存值）
//   - enabled 字段供前置门禁检查
//
// 持久化：userData/config/platformConfig.json
//   - 加载时与 defaults 合并，兼容老用户配置缺字段
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { all as allPlatforms } from './platforms/registry.js'
import { POLICY_FIELD_VARS } from './policyFieldResolver.js'

/**
 * 「锦绣政策字段配置」字段元数据（单一事实来源）
 *   新格式政策导入文件里标注「由锦绣政策字段配置传入」的 12 项（11 个文本字段 + 1 个开关）：
 *   用户在 PCP 独立配置板块填写，支持 ${变量} 拼接，导出时逐行替换。
 *   default 取示例值原样（用户首次进入时的初始值，可自行改为变量拼接）。
 *   数字列（Y优先级/OTAConfigID/数据有效期End/创建人id）导出时由 adapter numPf 转 Number。
 *   「主行参与」开关（默认关闭）不写入政策文件，只在比价时生效：
 *     关闭 → 主行只作套餐公用信息来源，仅匹配到携程报价的套餐各生成一条政策行；
 *     开启 → 主行参与比价并产出政策行。
 */
export const POLICY_FIELDS_SCHEMA = [
  { key: 'Name', label: 'Name', default: 'XQ/AYT-HAJ/U/直飞/王宇' },
  { key: 'Remark', label: 'Remark', default: '出官网-王宇。用美元支。\n有付费行李，和套餐对比出。' },
  { key: 'Y优先级', label: 'Y优先级', default: 90 },
  { key: 'OTAConfigID', label: 'OTAConfigID', default: 11 },
  { key: '航程类型', label: '航程类型', default: '单程' },
  { key: '数据有效期End', label: '数据有效期End', default: 45 },
  { key: '航司名', label: '航司名', default: 'XQ' },
  { key: '销售天数', label: '销售天数', default: '2-999' },
  { key: '座位数', label: '座位数', default: '2-999' },
  { key: '爬虫名', label: '爬虫名', default: 'XQ' },
  { key: '创建人id', label: '创建人id', default: 139 },
  { key: '主行参与', label: '主行参与', type: 'switch', default: false }
]

/** 从 schema 构建默认 policyFields（首次进入或字段缺失时回退） */
function buildDefaultPolicyFields() {
  const out = {}
  for (const f of POLICY_FIELDS_SCHEMA) out[f.key] = f.default
  return out
}

/**
 * 从 registry 各 adapter.defaults 构建默认配置（schema 驱动，不再硬编码）
 * 新增平台只需在 platforms/ 下建目录 + register，configManager 自动适配
 */
function buildDefaultConfig() {
  const cfg = {}
  for (const adapter of allPlatforms()) {
    cfg[adapter.key] = { ...(adapter.defaults || {}) }
  }
  return cfg
}

export class ConfigManager {
  constructor(userDataPath) {
    this.configDir = path.join(userDataPath, 'config')
    this.configFile = path.join(this.configDir, 'platformConfig.json')
    this.policyFieldsFile = path.join(this.configDir, 'policyFields.json')
    this.ensureConfigDir()
    this.defaultConfig = buildDefaultConfig()
    this.config = this.loadConfig()
    this.policyFields = this.loadPolicyFields()
  }

  // ========== 锦绣政策字段配置（独立于平台配置，单独文件持久化）==========
  // 职责：管理新格式政策导入文件里 12 项「锦绣配置」字段（11 文本 + 1 主行参与开关）的用户填写值
  //   - 加载时与 POLICY_FIELDS_SCHEMA 默认值合并（兼容老用户缺字段 + 新增字段）
  //   - 只保留 schema 定义的键：废弃字段自动剔除
  //   - 导出时由 ExcelExporter 注入 ctx.policyFields，逐行 resolvePolicyField 替换变量
  loadPolicyFields() {
    const defaults = buildDefaultPolicyFields()
    if (fs.existsSync(this.policyFieldsFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.policyFieldsFile, 'utf-8'))
        const cleaned = {}
        for (const k of Object.keys(defaults)) {
          cleaned[k] = (k in saved && saved[k] !== undefined) ? saved[k] : defaults[k]
        }
        return cleaned
      } catch {
        return { ...defaults }
      }
    }
    return { ...defaults }
  }

  /** 取政策字段配置（含 schema 元数据 + 可用变量列表，供渲染层列出输入框 + 变量参考） */
  getPolicyFields() {
    return {
      fields: { ...this.policyFields },
      schema: POLICY_FIELDS_SCHEMA,
      vars: POLICY_FIELD_VARS.map(v => ({ name: v.name, desc: v.desc }))
    }
  }

  /** 保存政策字段配置（与默认值合并后落盘，只保留 schema 定义的键） */
  setPolicyFields(fields) {
    const defaults = buildDefaultPolicyFields()
    const cleaned = {}
    for (const k of Object.keys(defaults)) {
      cleaned[k] = (fields && k in fields && fields[k] !== undefined) ? fields[k] : defaults[k]
    }
    this.policyFields = cleaned
    this.savePolicyFields()
    return { ...this.policyFields }
  }

  savePolicyFields() {
    fs.writeFileSync(this.policyFieldsFile, JSON.stringify(this.policyFields, null, 2), 'utf-8')
  }

  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
  }

  // 从磁盘加载配置，与 defaultConfig 合并以兼容老用户数据
  loadConfig() {
    if (fs.existsSync(this.configFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'))
        return this.mergeConfig(this.defaultConfig, saved)
      } catch {
        return { ...this.defaultConfig }
      }
    }
    return { ...this.defaultConfig }
  }

  // 把 savedConfig 合并到 defaultConfig 之上（按平台对象浅合并）
  // 只保留 defaults 定义的键：老配置里的废弃字段（如 trip 曾有的 baseURL/validatingCarrier/agentName 等）自动剔除
  mergeConfig(defaultConfig, savedConfig) {
    const merged = {}
    for (const key of Object.keys(defaultConfig)) {
      const d = defaultConfig[key]
      const s = savedConfig[key] || {}
      const cleaned = {}
      for (const k of Object.keys(d)) {
        cleaned[k] = (k in s && s[k] !== undefined) ? s[k] : d[k]
      }
      merged[key] = cleaned
    }
    return merged
  }

  saveConfig() {
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf-8')
  }

  // 获取全部平台配置（浅拷贝）
  get() {
    return { ...this.config }
  }

  // 获取全部平台配置 schema（供渲染层 PlatformConfigForm schema 驱动渲染）
  //   每个 adapter 暴露 configSchema，新增平台/字段只改 platforms/<key>/config.js
  getSchema() {
    const schema = {}
    for (const adapter of allPlatforms()) {
      schema[adapter.key] = adapter.configSchema || {}
    }
    return schema
  }

  // 更新配置（与现有配置合并后落盘）
  set(config) {
    this.config = this.mergeConfig(this.config, config)
    this.saveConfig()
    return { ...this.config }
  }

  // 获取指定平台的配置（adapter.compileConfig 预编译时调用）
  getPlatformConfig(platform) {
    return { ...(this.config[platform] || {}) }
  }

  // 前置门禁辅助：某平台是否启用
  isEnabled(platform) {
    return !!(this.config[platform]?.enabled)
  }

  // 前置门禁辅助：所有启用的平台 key
  enabledPlatforms() {
    return Object.keys(this.config).filter(k => this.config[k]?.enabled)
  }
}
