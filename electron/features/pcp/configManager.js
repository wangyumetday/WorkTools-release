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
    this.ensureConfigDir()
    this.defaultConfig = buildDefaultConfig()
    this.config = this.loadConfig()
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
  // 兼容老结构：老 jxgj 只有 floorPriceFormula/markupPercent/enabled，新 defaults 会补全缺失字段
  mergeConfig(defaultConfig, savedConfig) {
    const merged = {}
    for (const key of Object.keys(defaultConfig)) {
      merged[key] = { ...defaultConfig[key], ...(savedConfig[key] || {}) }
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
