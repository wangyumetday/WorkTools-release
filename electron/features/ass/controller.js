// ============================================================
// ASS Feature 主进程 IPC Controller
//
// 职责：注册 ass:* 命名空间的 ipc handlers + 事件推送
//   - 文件选择：ass:batch:pickFile（调 Electron 原生 dialog）
//   - 启动任务：ass:batch:start（先检查/等待登录，再调 runAssTask，异步跑 + 期间推送 onBatchProgress）
//   - 查询状态：ass:batch:getState
//   - 会话相关：ass:session:getStatus / ass:login:open / ass:session:logout
//
// 注入：registerAssController({ mainWindow, userDataPath })
//   mainWindow 用于推送进度事件 + dialog 模态附着
//   userDataPath 用于 ass_outputs 目录 + SessionManager 本地文件
// ============================================================

import { ipcMain, dialog, app, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { runAssTask } from './queryEngine.js'
import { AssSessionManager } from './sessionManager.js'
import { QueryPageBrowser } from './queryPageBrowser.js'
import { setQueryBrowser } from './tripClient.js'
import { clear as clearTjStats, snapshot as tjStatsSnapshot } from './tjStats.js'

/**
 * 获取 ass_outputs 目录（优先桌面；若桌面路径取不到则回落 userDataPath/ass_outputs）
 * 这样用户找文件最直观。
 */
function resolveOutputDir(userDataPath) {
  try {
    const desktop = app.getPath('desktop')
    return path.join(desktop, 'ass_outputs')
  } catch {
    return path.join(userDataPath, 'ass_outputs')
  }
}

/** 全局任务状态（暂只允许跑一个任务；§8 多任务/停止不做，简单够用） */
const state = {
  running: false,
  lastResult: null,       // 上一次完成的 runAssTask result
  lastError: null,        // 上一次任务失败的错误摘要
}

/**
 * 注册 ASS IPC handlers（由 main.js 调用一次）
 */
export function registerAssController({ mainWindow, userDataPath }) {
  const getMainWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

  // ============== SessionManager：携程会话管理 ==============
  const sessMgr = new AssSessionManager(userDataPath, getMainWindow)

  // ============== QueryPageBrowser：低价政策查询窗口（单账号 = 单窗口，与登录窗口同 partition）==============
  const qBrowser = new QueryPageBrowser(getMainWindow)
  // 注入到 tripClient 模块（seam setter 方式，无需改动 queryEngine.js 调用链）
  setQueryBrowser(qBrowser)

  const emitProgress = (payload) => {
    const win = getMainWindow()
    if (!win) return
    try { win.webContents.send('ass:batch:progress', payload) } catch { /* ignore */ }
  }
  // NOTE: ass:session:changed 推送由 sessMgr.pushStatusChanged() 内部负责

  // ============== 文件选择：.xlsx ==============
  ipcMain.handle('ass:batch:pickFile', async () => {
    const win = getMainWindow()
    const res = await dialog.showOpenDialog(win, {
      title: '选择航线 Excel 文件',
      properties: ['openFile'],
      filters: [{ name: 'Excel Files', extensions: ['xlsx', 'xls'] }],
    })
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    return { ok: true, filePath: res.filePaths[0] }
  })

  // ============== 启动任务 ==============
  // options: { filePath, airline?, startDate, endDate }
  ipcMain.handle('ass:batch:start', async (_event, options = {}) => {
    if (state.running) {
      return { ok: false, error: '已有任务正在运行，请等待完成' }
    }
    const { filePath, airline, startDate, endDate } = options
    if (!filePath)  return { ok: false, error: '未选择 Excel 文件' }
    if (!startDate) return { ok: false, error: '未选择开始日期' }
    if (!endDate)   return { ok: false, error: '未选择结束日期' }

    // ---------- 登录前置检查：进入 Phase 2 之前必须有携程登录态 ----------
    const before = sessMgr.getStatus()
    if (!before.loggedIn) {
      emitProgress({ type: 'LOGIN_REQUIRED', message: '检测到未登录携程，已弹出登录窗口，请完成登录后继续。' })
      const ok = await sessMgr.waitForLogin(10 * 60 * 1000) // 最多等 10 分钟
      if (!ok) {
        return { ok: false, error: '未完成携程登录，任务已取消（可点击右上角"登录携程"或重新开始）' }
      }
      emitProgress({ type: 'LOGIN_OK', status: sessMgr.getStatus() })
    }

    // ---------- 预打开查询窗口（若尚未创建）+ 等待"页面就绪" + 标记"任务运行中"防误关 ----------
    // 关键时序：**在 Phase 1 跑锦绣（约 1-2 秒）之前就把携程查询窗口加载好**，
    // 这样在 Phase 1 执行期间，用户有几十秒时间在查询窗口里自由晃鼠标，
    // 产生真实 isTrusted=true 的 UBT bee/collect 行为样本，Phase 2 开始时画像已经很"人"。
    //
    // waitForReady(30s) 里内置了 10s 宽容期 + auto reload + Phase B 第二轮宽容，
    // 足以消化 partition localStorage 冷加载竞态，不会再出现"10 条 P2 瞬时全 LOGIN_REQUIRED"。
    try {
      await qBrowser.open(true) // 此处在登录前置检查通过之后 → 已登录，应用视觉缩放 0.25
      emitProgress({
        type: 'INFO',
        kind: 'info',
        message: '已打开携程查询窗口（此期间你可在该窗口里自由晃鼠标、滚屏，会作为真实用户行为计入 UBT 样本）',
      })
      try {
        // 30s 超时足够页面冷启动 + 首次加载 c-sec/rms.js/wasm + SPA 路由回稳
        // 若 waitForReady 最终真的因 LOGIN_REQUIRED 抛错（= 用户从未登录过且本地 ass-session.json 也没），
        // 这里会回落，被前面的 sessMgr.waitForLogin 已处理过（因为 START 已做登录检查不会走到这，除非本地缓存异常）
        await qBrowser.waitForReady(30_000, 10_000)
      } catch (readyErr) {
        const msg = String(readyErr?.message || readyErr)
        // 真 LOGIN_REQUIRED → 强制再弹一次登录，阻塞等
        if (msg === 'LOGIN_REQUIRED' || msg.includes('LOGIN_REQUIRED')) {
          emitProgress({ type: 'LOGIN_REQUIRED', message: '携程查询窗口仍处于未登录状态，已弹出登录窗口。' })
          const ok2 = await sessMgr.waitForLogin(10 * 60 * 1000)
          if (!ok2) {
            return { ok: false, error: '查询窗口登录未完成，任务已取消。' }
          }
          emitProgress({ type: 'LOGIN_OK', status: sessMgr.getStatus() })
          // 重新登录后再给一次 waitForReady（SPA 需要重新读 token）
          try { await qBrowser.waitForReady(30_000, 8_000) } catch (_e) {}
        }
        // 其他就绪错误（DOM 没渲染完等）→ 不阻断，Phase 2 首次 query 内部会再 waitForReady 一次
      }
    } catch (openErr) {
      console.warn('[ass] 预打开查询窗口失败（将回落至 Phase 2 首次查询再开）：', openErr?.message)
    }
    qBrowser.setTaskRunning(true)

    state.running = true
    state.lastResult = null
    state.lastError = null

    const outputDir = resolveOutputDir(userDataPath)

    // requestLogin 回调：若未来真实 tripQuery 内部检测到未登录/登录失效，
    // 调用它触发"请用户重新登录"窗口，直到用户完成登录或取消。
    const requestLogin = async () => {
      const ok = await sessMgr.waitForLogin(10 * 60 * 1000)
      if (ok) {
        // 登录完成后，需要让查询窗口重新加载（token 已经在 partition 里，页面刷新就能读到 localStorage.token）
        // 并恢复"已登录"视觉缩放 0.25
        try { await qBrowser.open(true) } catch {}
        return true
      }
      emitProgress({ type: 'LOGIN_CANCELLED', message: '登录窗口已关闭/超时，Phase 2 将把该查询记为 ERROR。' })
      return false
    }

    try {
      emitProgress({ type: 'START', outputDir, options })
      const result = await runAssTask({
        filePath,
        airline,
        startDate,
        endDate,
        outputDir,
        onProgress: emitProgress,
        requestLogin,
        session: sessMgr.getStatus(), // 透传给 tripClient → 供登录快照检查
      })
      state.lastResult = result
      emitProgress({ type: 'DONE', result })
      return { ok: true, result }
    } catch (err) {
      const errInfo = { name: err?.name || 'Error', message: err?.message || String(err) }
      state.lastError = errInfo
      emitProgress({ type: 'FATAL', error: errInfo })
      return { ok: false, error: errInfo.message }
    } finally {
      state.running = false
      // 任务结束：解除"关闭=hide"锁；如果窗口之前被 hide 了，会重新 show 出来
      qBrowser.setTaskRunning(false)
    }
  })

  // ============== 当前任务状态查询 ==============
  ipcMain.handle('ass:batch:getState', () => {
    return {
      running: state.running,
      lastResult: state.lastResult,
      lastError: state.lastError,
      outputDir: resolveOutputDir(userDataPath),
      stats: tjStatsSnapshot(), // 航班统计排行榜快照（供页面刷新/初次加载）
    }
  })

  // ============== 清空航班统计（tjarr）==============
  ipcMain.handle('ass:stats:clear', () => {
    clearTjStats()
    emitProgress({ type: 'STATS', entries: tjStatsSnapshot() })
    return { ok: true }
  })

  // ============== 打开输出目录 / 定位到具体文件 ==============
  //   - 传 filePath（存在的文件）→ 资源管理器打开所在目录并选中该文件
  //   - 不传 filePath → 直接打开输出目录
  ipcMain.handle('ass:output:open', async (_event, { dir, filePath } = {}) => {
    if (filePath) {
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `文件不存在：${filePath}` }
      }
      shell.showItemInFolder(filePath)
      return { ok: true }
    }
    const target = dir || resolveOutputDir(userDataPath)
    try {
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
    } catch { /* 创建失败则交给 openPath 报错 */ }
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  })

  // ============== Pause / Stop：§8 不做，返回占位 ==============
  ipcMain.handle('ass:batch:pause', () => {
    return { ok: false, error: '暂停功能（§8-10）暂未实现' }
  })
  ipcMain.handle('ass:batch:stop', () => {
    return { ok: false, error: '停止功能（§8-10）暂未实现，请等待当前任务自然结束' }
  })

  // ============== 会话 / 登录：真实实现（基于 AssSessionManager）==============
  ipcMain.handle('ass:session:getStatus', () => {
    return sessMgr.getStatus()
  })

  ipcMain.handle('ass:login:open', async () => {
    // 只打开窗口并立即返回；UI 可订阅 onSessionChanged 知道什么时候登录完成
    sessMgr.openLoginWindow()
    return { ok: true, message: '登录窗口已打开，请手动完成携程登录；完成后窗口将自动关闭。' }
  })

  ipcMain.handle('ass:session:logout', async () => {
    if (state.running) {
      return { ok: false, error: '任务执行中不能注销，请等待任务结束或重启应用' }
    }
    // 先销毁查询窗口（避免销毁 cookies 后页面里的 SDK 还在发送过期 token 的请求）
    try { qBrowser.destroy() } catch {}
    // 再清空本地会话 + 分区存储
    await sessMgr.logout()
    return { ok: true }
  })
}

export default { registerAssController }
