// ============================================================
// PCP Controller - IPC handlers 注册器
// 职责：把渲染层的 IPC 请求分发给对应的 manager 业务方法
//
// IPC 命名空间：pcp:task:* / pcp:file:* / pcp:credential:* / pcp:config:*
//   - pcp:task:progress / pcp:task:allComplete 是主进程主动推送给渲染层
//     （在 main.js 实例化 TaskManager 时通过 onProgress / onAllComplete 回调注入）
//
// 调用方式：main.js 在 registerIpcHandlers 阶段调一次
//   registerPcpController({ mainWindow, taskManager, fileManager, credentialManager, configManager })
// ============================================================

import { ipcMain, dialog, shell } from 'electron'
import path from 'node:path'

/**
 * 注册 PCP feature 的全部 IPC handlers
 * @param {object} deps 依赖注入
 *   - mainWindow:        BrowserWindow 实例（用于 dialog 和事件推送）
 *   - taskManager:       TaskManager 实例
 *   - fileManager:       FileManager 实例
 *   - credentialManager: CredentialManager 实例
 *   - configManager:     ConfigManager 实例
 */
export function registerPcpController({ mainWindow, taskManager, fileManager, credentialManager, configManager }) {
  // ========== Task IPC ==========
  ipcMain.handle('pcp:task:add', (_event, task) => taskManager.addTask(task))
  ipcMain.handle('pcp:task:delete', (_event, taskId) => taskManager.deleteTask(taskId))
  ipcMain.handle('pcp:task:clear', () => taskManager.clearAll())
  ipcMain.handle('pcp:task:start', (_event, stage) => taskManager.start(stage))
  ipcMain.handle('pcp:task:pause', () => taskManager.pause())
  ipcMain.handle('pcp:task:getState', () => taskManager.getState())
  // 设置并发数（运行时也可调，会立刻唤醒额外 worker）
  ipcMain.handle('pcp:task:setConcurrency', (_event, n) => taskManager.setConcurrency(n))

  /**
   * 按阶段批量添加任务
   *   - stage='jxgj'    从 a1 数据源为每条生成一个 jxgj 任务（锦绣国际）
   *   - stage='o_combo' 从 a2 数据源按 date_obj 每个日期生成一个 o_combo 任务（TRIP+O2+O3）
   */
  ipcMain.handle('pcp:task:addBatchByStage', (_event, stage) => {
    const stageMap = {
      jxgj: { source: () => fileManager.getA1().data, type: 'jxgj' },
      o_combo: { source: () => fileManager.getA2().data, type: 'o_combo' }
    }

    const config = stageMap[stage]
    if (!config) {
      return { success: false, message: '未知的阶段' }
    }

    const sourceData = config.source()
    if (sourceData.length === 0) {
      return { success: false, message: '数据源为空，请先完成上一阶段' }
    }

    // o_combo 阶段：TRIP/O2/O3 三个平台都没选中账号时直接拦截，不添加任务
    //   executeOComboTask 内部会跳过没账号的平台，三个全没时调用毫无意义
    //   提前在添加任务前拦截，避免用户看到任务全失败一头雾水
    if (stage === 'o_combo' && credentialManager) {
      const hasAnyO = ['trip', 'o2', 'o3'].some(p => credentialManager.getSelected(p))
      if (!hasAnyO) {
        return { success: false, message: '未选择平台，请先在「账号管理」里为至少一个 O 平台选中账号' }
      }
    }

    taskManager.clearAll()

    let tasks
    if (stage === 'o_combo') {
      // O 平台组合任务：遍历每个 a2 项的 date_obj，为每个日期属性生成一个任务
      //   date_obj 形如 { "2026-08-15": [], "2026-08-21": [] }
      //   任务 data 携带：原 a2 项(source)、日期键(dateKey)、日期值(dateValue)
      //   这样下游平台请求能同时拿到航线上下文和当天的数据
      tasks = []
      for (const item of sourceData) {
        const dateObj = item && typeof item.date_obj === 'object' && item.date_obj !== null
          ? item.date_obj
          : null
        if (!dateObj) {
          // 该项没有 date_obj：退回整项一个任务，避免数据缺失时卡住流程
          tasks.push({
            type: config.type,
            data: { id: item.id, source: item, dateKey: null, dateValue: null }
          })
          continue
        }
        for (const [dateKey, dateValue] of Object.entries(dateObj)) {
          tasks.push({
            type: config.type,
            data: {
              id: `${item.id}__${dateKey}`,
              source: item,
              dateKey,
              dateValue
            }
          })
        }
      }
    } else {
      tasks = sourceData.map(item => ({
        type: config.type,
        data: item
      }))
    }
    const added = taskManager.addBatch(tasks)

    return {
      success: true,
      count: added.length,
      tasks: added
    }
  })

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

  // 打开下载目录：在系统文件管理器中打开（Windows 资源管理器 / macOS Finder / Linux）
  //   shell.openPath 跨平台，返回非空字符串表示出错
  ipcMain.handle('pcp:file:openDownloadDir', async () => {
    const dir = fileManager.getDownloadDir()
    if (!dir) {
      return { success: false, error: '未设置下载目录' }
    }
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
    const a3 = fileManager.getA3()
    if (a3.count === 0) {
      return { success: false, error: '没有结果数据，请先完成O平台阶段' }
    }
    const dir = fileManager.getDownloadDir()
    if (!dir) {
      return { success: false, error: '未设置下载目录，请先点击「选择下载目录」' }
    }
    // onProgress 回调：把 0/30/60/100 推送给渲染层，渲染层据此填充按钮颜色
    return fileManager.exportResult(dir, 'result.xlsx', (progress) => {
      mainWindow?.webContents.send('pcp:file:downloadProgress', { progress })
    })
  })

  // ========== Credential IPC ==========
  ipcMain.handle('pcp:credential:list', () => credentialManager.list())
  ipcMain.handle('pcp:credential:add', (_event, credential) => credentialManager.add(credential))
  ipcMain.handle('pcp:credential:delete', (_event, id) => credentialManager.delete(id))
  ipcMain.handle('pcp:credential:select', (_event, id) => credentialManager.select(id))
  ipcMain.handle('pcp:credential:update', (_event, credential) => credentialManager.update(credential))

  // ========== Config IPC ==========
  ipcMain.handle('pcp:config:get', () => configManager.get())
  ipcMain.handle('pcp:config:set', (_event, config) => configManager.set(config))
}
