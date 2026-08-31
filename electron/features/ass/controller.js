// ============================================================
// ASS Controller - IPC handlers 注册器
// 职责：把渲染层的 IPC 请求分发给 sessionManager / batchRunner
//
// IPC 命名空间：ass:*
//   - ass:session:getStatus  查询登录状态（渲染层 onMounted 拉取初值）
//   - ass:login:open         打开携程登录页窗口（用户手动登录）
//   - ass:session:logout     退出登录（清分区存储 + 本地会话文件）
//   - ass:batch:pickFile     选择数据文件并预览提取条数
//   - ass:batch:start        开始/继续批处理（并发数 + 请求间隔）
//   - ass:batch:pause        暂停（完成在途请求后停下）
//   - ass:batch:stop         停止（剩余任务记为跳过）
//   - ass:batch:getState     拉取当前批处理状态
//   - ass:session:changed   主进程主动推送（登录成功/取消/退出）
//   - ass:batch:progress    主进程主动推送（批处理进度）
//
// 调用方式：main.js 在 registerIpcHandlers 阶段调一次
//   registerAssController({ mainWindow, userDataPath })
// ============================================================

import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'
import { AssSessionManager } from './sessionManager.js'
import { AssQueryClient } from './queryClient.js'
import { AssBatchRunner } from './batchRunner.js'

export function registerAssController({ mainWindow, userDataPath }) {
  const sessionManager = new AssSessionManager(userDataPath, () => mainWindow)
  const queryClient = new AssQueryClient()
  const batchRunner = new AssBatchRunner({
    getMainWindow: () => mainWindow,
    queryClient
  })

  // ---------- 会话 ----------

  ipcMain.handle('ass:session:getStatus', () => sessionManager.getStatus())

  ipcMain.handle('ass:login:open', () => {
    sessionManager.openLoginWindow()
    return { ok: true }
  })

  ipcMain.handle('ass:session:logout', async () => {
    await sessionManager.logout()
    return { ok: true }
  })

  // ---------- 批处理 ----------

  /**
   * 选择数据文件：
   *   - Excel(xlsx/xls)：xlsx 库解析为 rows（第一张表的对象数组）
   *   - csv/txt/其它：读为原始 text
   *   选完立即调用一次 userHooks.extractQueries 给界面预览条数
   */
  ipcMain.handle('ass:batch:pickFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择查询数据文件',
      properties: ['openFile'],
      filters: [{ name: '数据文件', extensions: ['xlsx', 'xls', 'csv', 'txt'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    const filePath = result.filePaths[0]
    const parsed = readFileContent(filePath)
    if (parsed.error) return parsed
    return batchRunner.setSource(parsed.content)
  })

  ipcMain.handle('ass:batch:start', (_event, options) => {
    // 登录门禁：未登录直接拒绝，避免发出必然失败/暴露身份的请求
    if (!sessionManager.getStatus().loggedIn) {
      return { ok: false, code: 'NOT_LOGGED_IN', error: '尚未登录，请先打开登录页完成登录' }
    }
    return batchRunner.start(options ?? {})
  })

  ipcMain.handle('ass:batch:pause', () => {
    batchRunner.pause()
    return { ok: true }
  })

  ipcMain.handle('ass:batch:stop', () => {
    batchRunner.stop()
    return { ok: true }
  })

  ipcMain.handle('ass:batch:getState', () => batchRunner.getState())
}

/**
 * 读取文件内容（弹出选择 → 解析为统一结构）
 * @returns {{ ok:true, content } | { ok:false, error }}
 */
function readFileContent(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase().slice(1)
    if (ext === 'xlsx' || ext === 'xls') {
      const workbook = XLSX.readFile(filePath, { cellDates: true })
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = firstSheet ? XLSX.utils.sheet_to_json(firstSheet) : []
      return {
        ok: true,
        content: { filePath, fileName: path.basename(filePath), ext, rows, text: null }
      }
    }
    const text = fs.readFileSync(filePath, 'utf-8')
    return {
      ok: true,
      content: { filePath, fileName: path.basename(filePath), ext, rows: null, text }
    }
  } catch (err) {
    return { ok: false, error: `读取文件失败: ${err?.message || err}` }
  }
}