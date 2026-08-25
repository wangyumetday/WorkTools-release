// ============================================================
// PCP ConfigManager - 平台配置管理器
// 职责：管理 4 个平台（JXGJ/TRIP/O2/O3）的数据生成配置（底价公式、上浮比例、启用开关）
//
// 配置结构（代码 key 用简称）：
//   {
//     jxgj: { floorPriceFormula: 'cost * 1.1', markupPercent: 5, enabled: true },
//     trip: { ... }, o2: { ... }, o3: { ... }
//   }
//
// 持久化：userData/config/platformConfig.json
//   - 加载时与 DEFAULT_CONFIG 合并，避免老用户配置缺字段时崩
//   - 金额精度由 decimal.js 统一管理（默认 2 位小数，货币标准精度），不再开放配置
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

// 平台数据生成配置：步骤2/3 数据处理时使用的规则（底价公式、上浮比例等）
// 金额精度由 decimal.js 统一管理（默认 2 位小数，货币标准精度），不再开放配置
const DEFAULT_CONFIG = {
  jxgj: {
    floorPriceFormula: '',   // 底价公式，处理数据时按此计算底价
    markupPercent: 0,        // 报价上浮比例（%）
    enabled: true            // 是否启用该平台规则
  },
  trip: {
    floorPriceFormula: '',
    markupPercent: 0,
    enabled: true
  },
  o2: {
    floorPriceFormula: '',
    markupPercent: 0,
    enabled: true
  },
  o3: {
    floorPriceFormula: '',
    markupPercent: 0,
    enabled: true
  }
}

export class ConfigManager {
  constructor(userDataPath) {
    this.configDir = path.join(userDataPath, 'config')
    this.configFile = path.join(this.configDir, 'platformConfig.json')
    this.ensureConfigDir()
    this.config = this.loadConfig()
  }

  // 确保 config 目录存在
  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
  }

  // 从磁盘加载配置，与 DEFAULT_CONFIG 合并以兼容老用户数据
  loadConfig() {
    if (fs.existsSync(this.configFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'))
        return this.mergeConfig(DEFAULT_CONFIG, saved)
      } catch {
        return { ...DEFAULT_CONFIG }
      }
    }
    return { ...DEFAULT_CONFIG }
  }

  // 把 savedConfig 合并到 defaultConfig 之上（按平台对象浅合并）
  mergeConfig(defaultConfig, savedConfig) {
    const merged = {}
    for (const key of Object.keys(defaultConfig)) {
      merged[key] = { ...defaultConfig[key], ...(savedConfig[key] || {}) }
    }
    return merged
  }

  // 保存配置到磁盘
  saveConfig() {
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf-8')
  }

  // 获取全部平台配置（浅拷贝，防止外部误改内部状态）
  get() {
    return { ...this.config }
  }

  // 更新配置（与现有配置合并后落盘）
  set(config) {
    this.config = this.mergeConfig(this.config, config)
    this.saveConfig()
    return { ...this.config }
  }

  // 获取指定平台的配置（TaskManager 预编译时调用）
  getPlatformConfig(platform) {
    return { ...(this.config[platform] || {}) }
  }
}
