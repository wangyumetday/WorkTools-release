// PCP ConfigManager - 航司私有配置管理器（航司私有化重构）
// 职责：管理「按航司二字码」的私有配置（平台配置 + 锦绣政策字段配置）
//
// 重构要点（航司私有化）：
//   - 配置不再按「平台」全局存储，改为按「航司二字码」私有存储
//   - 每个航司一份：{ platform: { jxgj/trip/reserved }, policyFields: {...} }
//   - 默认值不硬编码，运行时从 registry 各 adapter.defaults + POLICY_FIELDS_SCHEMA 构建
//   - getAirlineConfig(code) 幂等物化：命中返回已存配置；未命中用默认值新建并落盘
//
// 持久化：userData/config/airlineConfigs.json
//   - 加载时与默认值合并，剔除废弃字段（兼容老用户配置缺字段）

import fs from 'node:fs'
import path from 'node:path'
import { all as allPlatforms } from './platforms/registry.js'
import { POLICY_FIELD_VARS } from './policyFieldResolver.js'

/**
 * 「锦绣政策字段配置」字段元数据（单一事实来源）
 *   新格式政策导入文件里标注「由锦绣政策字段配置传入」的 14 项（13 个文本字段 + 1 个开关）：
 *   用户在 PCP 航司配置板块填写，支持 ${变量} 拼接，导出时逐行替换。
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
  { key: '数据有效期End', label: '数据有效期End', default: 45 },
  // 「航司名」「爬虫名」（2026-09-23 起不再配置）：导出列自动取锦绣数据 H航司名（爬虫名与航司同名）
  { key: '销售天数', label: '销售天数', default: '2-999' },
  { key: '座位数', label: '座位数', default: '2-999' },
  { key: '创建人id', label: '创建人id', default: 139 },
  // 「去哪飞猪携程nationalityType」「去哪飞猪携程nationality」（2026-09-24 起配置化）：
  //   不填=空，默认也是空（原固定值 '2'/'TR' 已废弃，改由用户配置）
  { key: '去哪飞猪携程nationalityType', label: '去哪飞猪携程nationalityType', default: '' },
  { key: '去哪飞猪携程nationality', label: '去哪飞猪携程nationality', default: '' },
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
 * 返回 { jxgj: {...}, trip: {...}, reserved: {...} }
 * 新增平台只需在 platforms/ 下建目录 + register，configManager 自动适配
 */
function buildDefaultConfig() {
  const cfg = {}
  for (const adapter of allPlatforms()) {
    cfg[adapter.key] = { ...(adapter.defaults || {}) }
  }
  return cfg
}

/** 航司二字码归一化：trim + 大写（与 file 解析出的 hangsi 口径一致） */
function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase()
}

export class ConfigManager {
  constructor(userDataPath) {
    this.configDir = path.join(userDataPath, 'config')
    this.airlineConfigsFile = path.join(this.configDir, 'airlineConfigs.json')
    this.ensureConfigDir()
    this.defaultConfig = buildDefaultConfig()
    this.defaultPolicyFields = buildDefaultPolicyFields()
    this.airlineConfigs = this.loadAirlineConfigs()
  }

  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
  }

  // ========== 持久化 ==========

  // 从磁盘加载航司私有配置，与默认值合并（剔除废弃字段、归一化二字码）
  loadAirlineConfigs() {
    if (fs.existsSync(this.airlineConfigsFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.airlineConfigsFile, 'utf-8'))
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
          const out = {}
          for (const code of Object.keys(saved)) {
            const key = normalizeCode(code)
            if (!key) continue
            const entry = saved[code] || {}
            out[key] = {
              platform: this._mergePlatform(entry.platform),
              policyFields: this._mergePolicyFields(entry.policyFields)
            }
          }
          return out
        }
      } catch { /* 解析失败回退空表 */ }
    }
    return {}
  }

  saveAirlineConfigs() {
    fs.writeFileSync(this.airlineConfigsFile, JSON.stringify(this.airlineConfigs, null, 2), 'utf-8')
  }

  // ========== 合并/清理（与默认值合并，剔除废弃键）==========

  // 平台配置：只保留 defaults 定义的键（老配置废弃字段自动剔除）
  _mergePlatform(saved = {}) {
    const merged = {}
    for (const key of Object.keys(this.defaultConfig)) {
      const d = this.defaultConfig[key]
      const s = (saved && saved[key]) || {}
      const cleaned = {}
      for (const k of Object.keys(d)) {
        cleaned[k] = (k in s && s[k] !== undefined) ? s[k] : d[k]
      }
      merged[key] = cleaned
    }
    return merged
  }

  // 政策字段：只保留 schema 定义的键
  _mergePolicyFields(saved = {}) {
    const cleaned = {}
    for (const k of Object.keys(this.defaultPolicyFields)) {
      cleaned[k] = (saved && k in saved && saved[k] !== undefined) ? saved[k] : this.defaultPolicyFields[k]
    }
    return cleaned
  }

  _buildDefaultEntry() {
    return {
      platform: JSON.parse(JSON.stringify(this.defaultConfig)),
      policyFields: { ...this.defaultPolicyFields }
    }
  }

  // ========== 对外 API ==========

  /** 全部航司列表（含各自 platform + policyFields），供前端左栏渲染 */
  listAirlines() {
    return Object.keys(this.airlineConfigs).map(code => ({
      code,
      platform: { ...this.airlineConfigs[code].platform },
      policyFields: { ...this.airlineConfigs[code].policyFields }
    }))
  }

  /**
   * 取某航司配置（幂等物化）
   *   命中返回已存配置；未命中用默认值新建并落盘，created=true。
   *   运行时（TaskManager）与界面侧共用此入口，保证「未配置航司」也不打断运行。
   */
  getAirlineConfig(code) {
    const key = normalizeCode(code)
    if (!key) throw new Error('航司二字码为空')
    let created = false
    if (!this.airlineConfigs[key]) {
      this.airlineConfigs[key] = this._buildDefaultEntry()
      created = true
      this.saveAirlineConfigs()
    }
    return {
      code: key,
      platform: { ...this.airlineConfigs[key].platform },
      policyFields: { ...this.airlineConfigs[key].policyFields },
      created
    }
  }

  /** 显式新增航司（+ 按钮）：与 getAirlineConfig 同语义，幂等 */
  addAirline(code) {
    return this.getAirlineConfig(code)
  }

  /** 保存某航司配置（不存在则先建默认再合并覆盖） */
  saveAirlineConfig(code, { platform, policyFields } = {}) {
    const key = normalizeCode(code)
    if (!key) throw new Error('航司二字码为空')
    if (!this.airlineConfigs[key]) this.airlineConfigs[key] = this._buildDefaultEntry()
    this.airlineConfigs[key].platform = this._mergePlatform(platform)
    this.airlineConfigs[key].policyFields = this._mergePolicyFields(policyFields)
    this.saveAirlineConfigs()
    return {
      code: key,
      platform: { ...this.airlineConfigs[key].platform },
      policyFields: { ...this.airlineConfigs[key].policyFields }
    }
  }

  /** 删除某航司配置 */
  deleteAirline(code) {
    const key = normalizeCode(code)
    if (!key) return { success: false, error: '航司二字码为空' }
    if (!this.airlineConfigs[key]) return { success: false, error: '该航司不存在' }
    delete this.airlineConfigs[key]
    this.saveAirlineConfigs()
    return { success: true }
  }

  // ========== schema（全局，不随航司变化）==========

  /** 各平台配置 schema（供渲染层 schema 驱动渲染） */
  getSchema() {
    const schema = {}
    for (const adapter of allPlatforms()) {
      schema[adapter.key] = adapter.configSchema || {}
    }
    return schema
  }

  /** 政策字段 schema（label + default + type，载启动前端渲染用） */
  getPolicyFieldsSchema() {
    return POLICY_FIELDS_SCHEMA
  }

  /** 政策字段可用变量列表（name + desc，供 ${变量} 参考） */
  getPolicyFieldVars() {
    return POLICY_FIELD_VARS.map(v => ({ name: v.name, desc: v.desc }))
  }
}