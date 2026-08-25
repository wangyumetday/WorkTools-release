// ============================================================
// PCP TaskManager - 任务管理器 facade（阶段2 拆分后）
// 职责：组合 TaskScheduler（队列+并发池）+ PlatformRunner（登录+三步执行）
//   对外保持阶段1 接口不变（addTask/addBatch/deleteTask/clearAll/
//   start/pause/getState/setConcurrency/serializeProgress）
//   内部把请求转发到 scheduler 或 runner
//
// 拆分前（阶段1）：单文件含队列+并发+登录+三步执行+进度模拟
// 拆分后（阶段2）：
//   - taskScheduler.js  负责队列/并发/runNextTask 自驱/进度推送
//   - platformRunner.js 负责账密读取/登录/prepareRequest/request/mergeResult/真实进度
//   - taskManager.js    facade：注入依赖、start 时预编译配置+门禁检查+组合二者
//
// 依赖：
//   - credentialManager: 注入，按平台取该平台当前选中的账密
//   - configManager:     注入，按平台取该平台的字符串配置（公式等）
//   - platforms/registry.js: 各平台 adapter（login/prepareRequest/request/mergeResult/compileConfig）
// ============================================================

import * as registry from './platforms/registry.js'
import { TaskScheduler } from './taskScheduler.js'
import { PlatformRunner } from './platformRunner.js'

/**
 * 中文说明：
 *   业务需求里，锦绣国际(JXGJ) / 携程OTA(TRIP) / O2 / O3 四个平台**各自都有自己的账号密码**，
 *   请求锦绣国际时必须使用"锦绣国际当前选中的账密"去登录，
 *   请求 O 组合（o_combo）时需要同时使用 TRIP、O2、O3 各自的选中账密分别登录。
 *
 *   因此 TaskManager 不再靠"全局唯一的 selectedId"，
 *   而是通过构造参数拿到 credentialManager 引用，
 *   在执行对应平台任务前，用 getSelected(platform) 拿到**该平台**的账密。
 */
export class TaskManager {
  constructor({ onProgress, onAllComplete, credentialManager, configManager }) {
    this.credentialManager = credentialManager || null
    this.configManager = configManager || null
    // 预编译后的平台配置缓存（floorPriceFormula 已是函数）
    this.compiledConfigs = {}

    // ★ scheduler 持有队列+并发，回调注入
    this.scheduler = new TaskScheduler({ onProgress, onAllComplete })

    // ★ runner 持有平台执行逻辑
    //   compiledConfigs 通过 getter 注入：保证 start() 时预编译后，runner 能拿到最新值
    this.runner = new PlatformRunner({
      credentialManager,
      getCompiledConfigs: () => this.compiledConfigs
    })
  }

  // ========== facade 转发：队列/并发/状态 ==========
  setConcurrency(n) { return this.scheduler.setConcurrency(n) }
  serializeProgress(t) { return this.scheduler.serializeProgress(t) }
  addTask(task) { return this.scheduler.addTask(task) }
  addBatch(tasks) { return this.scheduler.addBatch(tasks) }
  deleteTask(taskId) { return this.scheduler.deleteTask(taskId) }
  clearAll() { return this.scheduler.clearAll() }
  pause() { return this.scheduler.pause() }
  /** 终止（硬中断）：转发到 scheduler.abort() */
  abort() { return this.scheduler.abort() }
  getState() { return this.scheduler.getState() }

  // ========== 业务编排 ==========
  start(stage = null) {
    if (this.scheduler.isRunning) return { success: false, message: '任务已在运行中' }
    const pendingTasks = this.scheduler.tasks.filter(t => t.status === 'pending' || t.status === 'paused')
    if (pendingTasks.length === 0) return { success: false, message: '没有待执行的任务' }

    this.precompilePlatformConfigs()

    const credCheck = this.checkStageCredentials(stage)
    if (!credCheck.success) return credCheck

    return this.scheduler.start({
      stage,
      execute: (task, { onStep }) => this.runner.runByType(task.type, task.data, { onStep })
    })
  }

  /**
   * 预编译所有平台的字符串配置 → 函数版配置，缓存到 this.compiledConfigs
   * 重构后：通过 registry.all() 遍历各 adapter.compileConfig，不再用硬编码映射表
   */
  precompilePlatformConfigs() {
    this.compiledConfigs = {}
    if (!this.configManager) {
      console.warn('[TaskManager] 未注入 ConfigManager，跳过平台配置预编译')
      return
    }
    for (const adapter of registry.all()) {
      const rawConfig = this.configManager.getPlatformConfig(adapter.key)
      this.compiledConfigs[adapter.key] = adapter.compileConfig(rawConfig)
    }
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
      const hasAny = ['trip', 'o2', 'o3'].some(p => this.credentialManager.getSelected(p))
      if (hasAny) return { success: true }
      return {
        success: false,
        message: '未选择平台，请先在「账号管理」里为至少一个 O 平台选中账号'
      }
    }

    return { success: true }
  }
}
