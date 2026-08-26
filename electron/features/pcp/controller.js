// ============================================================
// PCP Controller - IPC handlers 注册器
// 职责：把渲染层的 IPC 请求分发给对应的 manager 业务方法
//
// IPC 命名空间：pcp:task:* / pcp:file:* / pcp:credential:* / pcp:config:* / pcp:pipeline:*
//   - pcp:task:progress / pcp:task:allComplete 是主进程主动推送给渲染层
//   - pcp:pipeline:state / pcp:pipeline:gateFail 也是主进程主动推送
//     （在 main.js 实例化 TaskManager/Pipeline 时通过回调注入）
//
// 调用方式：main.js 在 registerIpcHandlers 阶段调一次
//   registerPcpController({ mainWindow, taskManager, fileManager, credentialManager, configManager, pipeline })
// ============================================================

import { ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 注册 PCP feature 的全部 IPC handlers
 * @param {object} deps 依赖注入
 *   - mainWindow:        BrowserWindow 实例（用于 dialog 和事件推送）
 *   - taskManager:       TaskManager 实例
 *   - fileManager:       FileManager 实例
 *   - credentialManager: CredentialManager 实例
 *   - configManager:     ConfigManager 实例
 *   - pipeline:          Pipeline 实例（步骤流编排器，阶段3）
 */
export function registerPcpController({ mainWindow, taskManager, fileManager, credentialManager, configManager, pipeline }) {
  // ========== Task IPC ==========
  ipcMain.handle('pcp:task:add', (_event, task) => taskManager.addTask(task))
  ipcMain.handle('pcp:task:delete', (_event, taskId) => taskManager.deleteTask(taskId))
  ipcMain.handle('pcp:task:clear', () => taskManager.clearAll())
  ipcMain.handle('pcp:task:start', (_event, stage) => taskManager.start(stage))
  ipcMain.handle('pcp:task:pause', () => taskManager.pause())
  ipcMain.handle('pcp:task:getState', () => taskManager.getState())
  // 设置并发数（运行时也可调，会立刻唤醒额外 worker）
  ipcMain.handle('pcp:task:setConcurrency', (_event, n) => taskManager.setConcurrency(n))

  // 注：pcp:task:addBatchByStage 已删除（死代码，前端通过 pipelineStart/pipelineTriggerStep 走 pipeline._invokeAddBatchByStage）

  // ========== File IPC ==========

  // 弹文件选择对话框，选 xlsx 后解析为 a1 数据
  //   - defaultPath 用 lastDirectory：上次选过文件的话，直接打开同文件夹
  //   - 没记录时不传 defaultPath，Electron 用 OS 默认路径（一般也是桌面/文档）
  //   - 选完后更新 lastDirectory，下次延续
  ipcMain.handle('pcp:file:uploadXlsx', async () => {
    const lastDir = fileManager.getLastDirectory()
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Excel文件', extensions: ['xlsx', 'xls'] }],
      defaultPath: lastDir || undefined
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    // 选完后更新 lastDirectory，下次打开默认定位到该文件夹
    fileManager.setLastDirectory(path.dirname(result.filePaths[0]))
    return fileManager.parseXlsx(result.filePaths[0])
  })

  ipcMain.handle('pcp:file:getA1', () => fileManager.getA1())
  ipcMain.handle('pcp:file:getA2', () => fileManager.getA2())
  ipcMain.handle('pcp:file:getA3', () => fileManager.getA3())

  // 获取当前下载目录（前端 onMounted 调用，显示当前目录路径）
  ipcMain.handle('pcp:file:getDownloadDir', () => ({ dir: fileManager.getDownloadDir() }))

  // 选择下载目录：用户在步骤4点「选择下载目录」时调用
  //   - 选完后持久化，下次启动仍记得
  //   - defaultPath 用当前 downloadDir，方便用户在已选目录基础上微调
  ipcMain.handle('pcp:file:selectDownloadDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载目录',
      properties: ['openDirectory'],
      defaultPath: fileManager.getDownloadDir() || undefined
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    const dir = result.filePaths[0]
    fileManager.setDownloadDir(dir)
    return { success: true, dir }
  })

  // 打开下载目录（可选传文件路径定位到该文件）：
  //   - 传 filePath → shell.showItemInFolder：打开所在文件夹并选中该文件
  //   - 不传 filePath → shell.openPath：只打开下载目录（原逻辑不变）
  ipcMain.handle('pcp:file:openDownloadDir', async (_event, filePath) => {
    const dir = fileManager.getDownloadDir()
    if (!dir) {
      return { success: false, error: '未设置下载目录' }
    }
    if (filePath) {
      // 定位到文件：打开文件夹并选中
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在:' + filePath }
      }
      shell.showItemInFolder(filePath)
      return { success: true, dir }
    }
    // 文件不存在/未传路径 → 回退到只打开目录
    const err = await shell.openPath(dir)
    if (err) {
      return { success: false, error: err }
    }
    return { success: true, dir }
  })

  /**
   * 下载结果文件（步骤4点「下载结果Excel」按钮触发）
   *   - 不再弹 showSaveDialog，下载目录由用户预先通过 selectDownloadDir 选定
   *   - exportResult 内部用 getUniqueFilePath 处理同名序号，不会覆盖已有文件
   *   - 通过 onProgress 回调 + webContents.send 推送进度事件，前端按钮按进度填充颜色
   */
  ipcMain.handle('pcp:file:downloadResult', async () => {
    // ★ 用"阶段状态"做门控（替代原来的 a3.count===0 判断）
    //   a3_merge.completed + 至少一个O平台completed → 可下载，哪怕 a3.count=0
    const gate = pipeline ? pipeline.canExport() : { can: false, reason: '请先完成 O 平台比价阶段' }
    if (!gate.can) {
      return { success: false, error: gate.reason || '请先完成 O 平台比价阶段' }
    }
    const dir = fileManager.getDownloadDir()
    if (!dir) {
      return { success: false, error: '未设置下载目录，请先点击「选择下载目录」' }
    }
    // onProgress 回调：把 0/30/60/100 推送给渲染层，渲染层据此填充按钮颜色
    // platformsToInclude：0 条数据时也为每个 completed 的 O 平台生成表头文件
    return fileManager.exportResult(dir, 'result.xlsx', (progress) => {
      mainWindow?.webContents.send('pcp:file:downloadProgress', { progress })
    }, { platformsToInclude: gate.platformsToExport || [] })
  })

  // ========== Credential IPC ==========
  // 设计：真实步骤流进行中（jxgj/OTA/a3_merge 执行/等待/暂停）禁止修改任何基础配置（含账号）
  // list 只读永远放行；add/delete/select/update 写操作必须 isInProgress===false
  function failIfInProgress(actionName) {
    const pipelineRunning = pipeline?.isInProgress()
    const taskRunning = taskManager?.getState()?.isRunning ||
      taskManager?.scheduler?.isRunning ||
      false
    if (pipelineRunning || taskRunning) {
      throw new Error(`步骤流/任务进行中，禁止「${actionName}」。请先完成步骤流（结束或终止）后再操作。`)
    }
  }
  ipcMain.handle('pcp:credential:list', () => credentialManager.list())
  ipcMain.handle('pcp:credential:add', (_event, credential) => {
    failIfInProgress('添加账号')
    return credentialManager.add(credential)
  })
  ipcMain.handle('pcp:credential:delete', (_event, id) => {
    failIfInProgress('删除账号')
    return credentialManager.delete(id)
  })
  ipcMain.handle('pcp:credential:select', (_event, id) => {
    failIfInProgress('切换账号选中')
    return credentialManager.select(id)
  })
  ipcMain.handle('pcp:credential:update', (_event, credential) => {
    failIfInProgress('修改账号')
    return credentialManager.update(credential)
  })

  // ========== Config IPC ==========
  // 设计：get/getSchema 只读永远放行；set(保存平台配置/启用开关) 必须 isInProgress===false
  ipcMain.handle('pcp:config:get', () => configManager.get())
  ipcMain.handle('pcp:config:getSchema', () => configManager.getSchema())
  /**
   * 用户在前端点启用 → 保存配置 → 立刻刷新运行时配置栈
   * "一条路径"保证：保存动作完成后，taskManager.compiledConfigs 已同步为新值。
   * ★ 真实步骤流进行中（running/waiting_next/paused）直接抛错：流程中禁用保存配置，
   *   确保任务执行用的配置栈不被中途替换（否则已生成的任务结果和底价公式前后不一致）。
   */
  ipcMain.handle('pcp:config:set', (_event, config) => {
    failIfInProgress('保存平台配置/启用平台')
    const merged = configManager.set(config)
    const runtimeInfo = taskManager.reloadRuntimeConfigs('save')
    console.log(`[pcp:config:set] saved + runtime refreshed: revision=${runtimeInfo.revision}`)
    return { merged, runtimeInfo }
  })

  // ========== Pipeline IPC（阶段3：步骤流编排，收回主进程）==========
  // auto 模式：开始 → 门禁 → 跑到底（jxgj → o_combo → done）
  // dev 模式：triggerStep 触发单步，完成后停在 waiting_next
  ipcMain.handle('pcp:pipeline:start', async () => pipeline.start())
  ipcMain.handle('pcp:pipeline:triggerStep', async (_event, step) => pipeline.triggerStep(step))
  ipcMain.handle('pcp:pipeline:setMode', (_event, mode) => pipeline.setMode(mode))
  ipcMain.handle('pcp:pipeline:pause', async () => pipeline.pause())
  // 终止（硬中断）：立即打断当前流程，进度条冻在当前值，下次 start 从头跑
  ipcMain.handle('pcp:pipeline:abort', () => pipeline.abort())
  ipcMain.handle('pcp:pipeline:getState', () => pipeline.getState())
  // 重置流程到初始态：清空 a1/a2/a3 + 任务队列 + pipeline 状态（下载后调，便于下一轮）
  ipcMain.handle('pcp:pipeline:reset', () => pipeline.reset())
}
