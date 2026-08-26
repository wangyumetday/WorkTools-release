// ============================================================
// PCP TaskManager - 任务管理器 facade（唯一"运行时配置栈"持有者）
// 职责：
//   1. 队列/并发调度（TaskScheduler）
//   2. 平台任务执行（PlatformRunner）
//   3. ★ 运行时配置栈 compiledConfigs：前端点启用后 & 任务开始前 统一从文件加载+预编译进
//      compiledConfigs 内存对象，后续任何需要配置的地方（门禁/底价公式/其他字段）
//      都只从 compiledConfigs 取，不再读磁盘，保证"一条路径"使用。
// ============================================================

import * as registry from './platforms/registry.js'
import { TaskScheduler } from './taskScheduler.js'
import { PlatformRunner } from './platformRunner.js'

/** 深拷贝（配置仅 JSON 可序列化字段） */
function deepClone(obj) {
  if (obj === undefined || obj === null) return obj
  return JSON.parse(JSON.stringify(obj))
}

export class TaskManager {
  constructor({ onProgress, onAllComplete, credentialManager, configManager }) {
    this.credentialManager = credentialManager || null
    this.configManager = configManager || null

    /**
     * ★ 运行时配置栈（唯一使用路径）：
     * {
     *   jxgj: { enabled:true, floorPriceFormula:fn, floorPrice:{compute, debugInfo}, (用户保存的其他字段)... }
     *   trip: { enabled:true, (trip 平台各字段)... },
     *   o2:   { ... }, o3: { ... }
     * }
     * 刷新时机：
     *   a) TaskManager 构造后立刻加载一次（App 启动就有默认/上次保存值可用）
     *   b) 用户在前端点启用触发 IPC `pcp:config:set` → ConfigManager 存文件后，controller 立刻调 reloadRuntimeConfigs()
     *   c) start(stage) 开始任务前 再 reload 一次（兜底，确保和磁盘一致）
     */
    this.compiledConfigs = {}
    this._runtimeRevision = 0   // 单调递增版本号，前后端日志对齐用

    // 队列 + 并发池
    this.scheduler = new TaskScheduler({ onProgress, onAllComplete })

    // runner 从 getter 拿 compiledConfigs — 每次任务执行时读到最新的 reload 结果
    this.runner = new PlatformRunner({
      credentialManager,
      getCompiledConfigs: () => this.compiledConfigs
    })

    // ★ App 启动时立刻把配置文件 → 内存栈（保证"一条路径"立即可用，门禁/启动判断都走这）
    this.reloadRuntimeConfigs('init')
  }

  // ========== facade 转发：队列/并发/状态 ==========
  setConcurrency(n) { return this.scheduler.setConcurrency(n) }
  serializeProgress(t) { return this.scheduler.serializeProgress(t) }
  addTask(task) { return this.scheduler.addTask(task) }
  addBatch(tasks) { return this.scheduler.addBatch(tasks) }
  deleteTask(taskId) { return this.scheduler.deleteTask(taskId) }
  clearAll() { return this.scheduler.clearAll() }
  pause() { return this.scheduler.pause() }
  abort() { return this.scheduler.abort() }
  getState() { return this.scheduler.getState() }

  // ========== 一条路径 · 运行时配置栈 ==========
  /**
   * 把 ConfigManager 内存里的用户配置（已落盘的那份）
   * 做每个平台 adapter.compileConfig → 写入 compiledConfigs 内存栈。
   * @param {string} reason 日志标记：init(构造初始化)/start(任务开始)/save(用户保存)
   * @returns {{ revision: number, summary: object }}
   */
  reloadRuntimeConfigs(reason = 'manual') {
    const before = this._runtimeRevision
    this.compiledConfigs = {}
    if (!this.configManager) {
      console.warn(`[TaskManager:reloadRuntimeConfigs reason=${reason}] 未注入 ConfigManager，保持空栈`)
      return { revision: this._runtimeRevision, summary: {} }
    }
    for (const adapter of registry.all()) {
      const rawConfig = this.configManager.getPlatformConfig(adapter.key)
      this.compiledConfigs[adapter.key] = adapter.compileConfig(rawConfig)
    }
    this._runtimeRevision++
    // 只打非敏感信息：版本号 + 各平台 enabled + jxgj 公式字符串摘要
    const summary = {}
    for (const k of Object.keys(this.compiledConfigs)) {
      const c = this.compiledConfigs[k] || {}
      summary[k] = { enabled: !!c.enabled }
      if (k === 'jxgj') {
        // floorPrice.debugInfo() 是 jxgj 独立模块暴露的快照；包含全局公式+区间行编译状态
        if (typeof c.floorPrice?.debugInfo === 'function') {
          const d = c.floorPrice.debugInfo()
          summary[k].fpVersion = d.version
          summary[k].globalFormula = d.globalFormula?.formulaStr || ''
          summary[k].rangeCount = d.rangeCount || 0
          summary[k].globalCompileType = d.globalFormula?.compileType || ''
        } else if (typeof c.floorPriceFormula === 'function') {
          summary[k].globalFormula = '<function>'
        } else {
          summary[k].globalFormula = String(c.floorPriceFormula || '')
        }
      }
    }
    console.log(
      `[TaskManager:reloadRuntimeConfigs] revision ${before} → ${this._runtimeRevision} (reason=${reason})`,
      `\n  enabled:`, JSON.stringify(Object.keys(summary).filter(k => summary[k].enabled)),
      `\n  summary =`, summary
    )
    return { revision: this._runtimeRevision, summary }
  }

  /** 从运行时配置栈取某平台配置（深拷贝，避免调用方改到内存栈本身） */
  getRuntimeConfig(platform) {
    const c = this.compiledConfigs[platform]
    return c ? deepClone(c) : {}
  }

  /** 某平台是否启用（直接从运行时栈取，不再走 ConfigManager） */
  isRuntimeEnabled(platform) {
    return !!(this.compiledConfigs[platform]?.enabled)
  }

  /** 所有启用的平台 key（从运行时栈取，统一） */
  getRuntimeEnabledPlatforms() {
    return Object.keys(this.compiledConfigs).filter(k => this.compiledConfigs[k]?.enabled)
  }

  // ========== 业务编排 ==========
  start(stage = null) {
    if (this.scheduler.isRunning) return { success: false, message: '任务已在运行中' }
    const pendingTasks = this.scheduler.tasks.filter(t => t.status === 'pending' || t.status === 'paused')
    if (pendingTasks.length === 0) return { success: false, message: '没有待执行的任务' }

    // ★ 任务开始前再 reload 一次（兜底：确保此时内存栈和磁盘最新保存一致；revision+1）
    this.reloadRuntimeConfigs(`start-${stage || 'all'}`)

    const credCheck = this.checkStageCredentials(stage)
    if (!credCheck.success) return credCheck

    return this.scheduler.start({
      stage,
      execute: (task, { onStep }) => this.runner.runByType(task.type, task.data, { onStep })
    })
  }

  checkStageCredentials(stage) {
    if (!this.credentialManager) return { success: true }

    if (stage === 'jxgj') {
      if (this.credentialManager.getSelected('jxgj')) return { success: true }
      return {
        success: false,
        message: '锦绣国际未配置账号，请先在「账号管理」里为锦绣国际选中一个账号'
      }
    }

    if (stage === 'o_combo') {
      const hasAny = registry.O_PLATFORM_KEYS.some(p => this.credentialManager.getSelected(p))
      if (hasAny) return { success: true }
      return {
        success: false,
        message: '未选择平台，请先在「账号管理」里为至少一个 O 平台选中账号'
      }
    }

    return { success: true }
  }
}
