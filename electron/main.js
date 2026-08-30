// ============================================================
// 主进程入口
// 职责：
//   1. 创建主窗口（含 webPreferences 安全配置）
//   2. 注册快捷键（F12 开关 DevTools，Ctrl+R 刷新）
//   3. dev 模式开启 Node Inspector，便于 VS Code attach 调试
//   4. 初始化各 features 的 managers（注入依赖、创建单例）
//   5. 注册各 features 的 IPC handlers（命名空间：pcp:* / erc:* / floating:*）
//   6. 配置自动更新（electron-updater）：启动后 5s 检查 + 原生对话框确认 + 静默增量更新
//
// 架构说明：
//   - 每个 feature 的业务代码隔离在 electron/features/<key>/ 下
//   - 主进程入口只负责"装配"：创建窗口、注入依赖、注册 controller
//   - features 之间互不引用，改一个不会影响另一个
//   - 共用基础设施在 electron/shared/ 下
// ============================================================

import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { open as openInspector } from 'node:inspector'
import { autoUpdater } from 'electron-updater'

// PCP feature：4 个 manager + controller
import { FileManager } from './features/pcp/fileManager.js'
import { CredentialManager } from './features/pcp/credentialManager.js'
import { ConfigManager } from './features/pcp/configManager.js'
import { TaskManager } from './features/pcp/taskManager.js'
import { Pipeline } from './features/pcp/pipeline.js'
import { registerPcpController } from './features/pcp/controller.js'
// ERC feature：controller（无状态服务，无需 manager）
import { registerErcController } from './features/erc/controller.js'
// Floating：悬浮窗管理 + IPC 注册（shared 基础设施，跨 feature 复用）
import { registerFloatingController } from './shared/floatingWindow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ───────────────────────────────────────────────────────────────
// dev 模式自动开启 Node Inspector，便于 VS Code / Chrome DevTools attach 调试主进程
//   使用方式：
//   ① npm run dev 启动后，终端会打印 [debug] Electron 主进程 inspector 已开启
//   ② 在 VS Code 侧边栏"运行和调试"面板选择 "Attach to Electron Main" 配置，按 F5
//   ③ 在源码（electron/**/*.js）里打断点（编辑器行号左侧红点）
//   ④ 触发任务执行，代码会停在断点处，可看变量/调用栈/watch 表达式
//   也可用 Chrome 打开 chrome://inspect → Configure → 添加 localhost:9229 → inspect
// ───────────────────────────────────────────────────────────────
if (!app.isPackaged) {
  try {
    openInspector(9229, '127.0.0.1')
    // console.log('[debug] Electron 主进程 inspector 已开启 → ws://127.0.0.1:9229 （VS Code F5 选 "Attach to Electron Main" 或 Chrome 打开 chrome://inspect）')
  } catch (err) {
    console.warn('[debug] inspector 开启失败（端口可能被占用）:', err.message)
  }
}

// 主窗口引用（用于 IPC 推送事件给渲染层、dialog 父窗口）
let mainWindow = null
// PCP 各 manager 单例（initFeatures 实例化，registerIpcHandlers 注入 controller）
let taskManager, fileManager, credentialManager, configManager, pipeline

// ============================================================
// 创建主窗口
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // 启动体验：窗口先隐藏，渲染层合成第一帧（ready-to-show）后再 show，消灭白屏
    show: false,
    // 显式锁定窗口标题为 "Work Tools"，不依赖 package.json 的 name（小写 work-tools）衍生标题
    title: 'Work Tools',
    // 首帧绘制前的兜底背景色，与 index.html 启动遮罩背景一致，避免任何白闪
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // ---- 简化架构开关（内部工具场景，保留基本安全底线） ----
      // 1) 关 contextIsolation：preload 与页面共享同一个 window 对象，
      //    preload 直接 window.api = {...} 赋值即可，不用再理解 contextBridge 抽象（数据流更直观）。
      // 2) 关 sandbox：纯 Chromium 渲染进程沙箱，对内部工具收益极低，关闭后运行时更稳定、
      //    preload 里也不会被 sandbox allowlist 限制能力。
      // 3) 保留 nodeIntegration = false（基本安全底线）：渲染进程 JS 无法直接 require Node API，
      //    只能通过 preload 暴露的 window.api 白名单调用 IPC。
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false
    }
  })

  // 锁定标题：阻止页面 <title> 覆盖窗口标题，彻底消除"小写 work tools → 大写 Work Tools"切换
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault()
  })

  // 渲染层首帧合成完成后再显示窗口：用户从看到窗口的第一眼起就有内容（启动遮罩），无白屏
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 移除默认菜单栏（File / Edit / View / Window），整个应用不再显示系统菜单
  // （快捷键 F12/Ctrl+R 等通过 before-input-event 单独注册，不受影响）
  Menu.setApplicationMenu(null)

  // F12 打开/关闭 DevTools，Ctrl+R 刷新
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && !input.control && !input.meta && !input.alt) {
      if (input.key === 'F12') {
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools()
        } else {
          mainWindow.webContents.openDevTools()
        }
      }
    }
    if (input.type === 'keyDown' && (input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload()
    }
  })

  // 打包模式：渲染层页面完全加载好（did-finish-load）后 2s 做一次版本检查
  //   - 此时 Vue onMounted、Pinia、路由、监听器全部就绪，收到 update:state 事件不会丢
  //   - 整个应用生命周期只做这一次，不会循环检查
  if (app.isPackaged) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
          console.error('[updater] checkForUpdates failed:', err?.message || err)
        })
      }, 2000)
    })
  }

  // 关键：electron-vite v5 注入的环境变量名是 ELECTRON_RENDERER_URL（不是 VITE_DEV_SERVER_URL）。
  // 用官方推荐的 app.isPackaged() 判断开发态，dev 模式加载 Vite Dev Server URL → 自动开启 HMR；
  // 打包后加载本地 index.html。
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    // 注：dev 模式不再自动打开 DevTools，避免启动时弹窗打扰
    //   调试时手动按 F12 打开/关闭（见上方 before-input-event 监听）
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ============================================================
// 进度推送合批器（C2 方案：16ms 窗口 + 按 id 去重合并）
//
// 为什么做这个：
//   10 并发 × 每任务 300ms 定时器 = 每秒约 30 次独立 onProgress 调用
//   → 每条单独走 IPC = 30 次结构化克隆序列化 + 渲染层 30 次响应式更新
//   → 16ms 合批后降为 ~60 次/秒上限，且同任务同帧更新只保留最后一条
//   → 1~2 千条任务下，响应式开销下降 90%+，UI 不卡顿
// ============================================================
function createBatchedProgressSender(getWindow) {
  const WINDOW_MS = 16        // ≈ 浏览器一帧，体感零延迟
  let batch = new Map()      // id → task，天然做"同任务同帧只留最后一条"的去重
  let timer = null

  function flush() {
    timer = null
    if (batch.size === 0) return
    const win = getWindow()
    if (!win || win.isDestroyed()) { batch.clear(); return }
    const payload = Array.from(batch.values())
    batch.clear()
    try {
      // 以数组形式发出，前端 onTaskProgress 需要兼容"单个对象 or 数组"
      win.webContents.send('pcp:task:progress', payload)
    } catch (e) {
      console.warn('[main] batched progress flush skipped:', e?.message)
    }
  }

  return function emit(taskOrTasks) {
    const items = Array.isArray(taskOrTasks) ? taskOrTasks : [taskOrTasks]
    for (const t of items) { if (t && t.id) batch.set(t.id, t) }
    if (timer === null) {
      timer = setTimeout(flush, WINDOW_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
  }
}

// ============================================================
// 初始化各 features 的 managers（注入依赖、创建单例）
// 职责：实例化 PCP 的 taskManager/fileManager/credentialManager/configManager
// 说明：ERC 是无状态 API 调用，无需 manager；悬浮窗在 Todo 5 实现
// ============================================================
function initFeatures() {
  const userDataPath = app.getPath('userData')
  // PCP：实例化 4 个 manager，互相注入依赖
  //   - configManager/credentialManager 只需 userDataPath，先建（fileManager 要注入 configManager）
  //   - fileManager 需要 userDataPath + desktopPath + configManager（导出时取平台配置）
  //   - taskManager 依赖 credentialManager + configManager，并通过回调把进度/完成事件推给渲染层
  //   - pipeline 接管 taskManager 的 onAllComplete（步骤流收回主进程，移除渲染层 autoChain）
  configManager = new ConfigManager(userDataPath)
  credentialManager = new CredentialManager(userDataPath)
  fileManager = new FileManager(userDataPath, app.getPath('desktop'), configManager)

  // ★ 先用合批器包一层，再注入 TaskManager
  const batchedEmitProgress = createBatchedProgressSender(() => mainWindow)

  // taskManager 的 onAllComplete 占位，Pipeline 构造时会接管为 pipeline.handleStageComplete
  taskManager = new TaskManager({
    credentialManager,
    configManager,
    onProgress: batchedEmitProgress,
    onAllComplete: () => {}
  })

  // ★ Pipeline：步骤流编排器，收回主进程（阶段3）
  //   构造时接管 taskManager.scheduler.onAllComplete → pipeline.handleStageComplete
  //   内部做：saveStageResults + 推 pcp:task:allComplete + 根据 mode 决定下一步衔接
  pipeline = new Pipeline({
    taskManager,
    fileManager,
    configManager,
    credentialManager,
    getMainWindow: () => mainWindow, // getter 保证重建窗口后引用不失效
    userDataPath
  })
}

// ============================================================
// 注册 IPC handlers
//   - 自动更新：主进程原生对话框联动 autoUpdater，渲染层 0 改动就能体验自动更新
//   - 同时给渲染层暴露 api.update.*（以后做"关于 / 手动检查更新"按钮时直接用）
// ============================================================
function registerIpcHandlers() {
  registerPcpController({ mainWindow, taskManager, fileManager, credentialManager, configManager, pipeline })
  registerErcController()
  registerFloatingController(mainWindow)

  // ============== 自动更新 IPC（渲染层扩展用，不写也能用原生对话框） ==============
  function sendUpdate(type, data) {
    mainWindow?.webContents.send('update:state', { type, data })
  }

  ipcMain.handle('update:checkNow', async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      sendUpdate('error', { message: err.message })
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('update:downloadNow', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      sendUpdate('error', { message: err.message })
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('update:quitAndInstall', () => {
    autoUpdater.quitAndInstall(true, true)
  })

  // ============== 自动更新配置：只在打包后生效（dev 模式不检查） ==============
  if (!app.isPackaged) return // 开发态跳过，省得每次启动都去请求 Gitee 超时

  autoUpdater.logger = {
    info: (...a) => console.log('[updater]', ...a),
    warn: (...a) => console.warn('[updater]', ...a),
    error: (...a) => console.error('[updater]', ...a),
    debug: (...a) => console.debug('[updater]', ...a)
  }
  autoUpdater.autoDownload = true                // 查到新版本直接后台下载，不再先问用户
  autoUpdater.autoInstallOnAppQuit = true        // 用户主动关软件时，若更新包已下载则静默装完再退出

  autoUpdater.on('checking-for-update', () => sendUpdate('checking'))

  autoUpdater.on('update-available', (info) => {
    sendUpdate('available', info)
    // 不再弹原生对话框：交给渲染层内部弹窗提示"发现新版本，后台下载中"
  })

  autoUpdater.on('update-not-available', (info) => {
    sendUpdate('not-available', info)
    // 已是最新版本 → 静默不提示（避免每次启动都弹）
  })

  autoUpdater.on('download-progress', (prog) => {
    sendUpdate('downloading', prog)
    // 任务栏显示下载进度（用户不用切到窗口也能看到）
    if (mainWindow && typeof prog.percent === 'number') {
      mainWindow.setProgressBar(Math.max(0, Math.min(1, prog.percent / 100)))
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdate('downloaded', info)
    if (mainWindow) mainWindow.setProgressBar(-1)
    // 不再弹原生对话框：交给渲染层弹 Naive UI 的内部确认框，由用户决定是否现在重启安装
  })

  autoUpdater.on('error', (err) => {
    sendUpdate('error', { message: err?.message || String(err) })
    if (mainWindow) mainWindow.setProgressBar(-1)
    // 网络错误 / Gitee 连不上 → 只打日志，不弹窗（否则每次启动都吓用户）
    console.warn('[updater] error:', err?.message || err)
  })
}

app.whenReady().then(() => {
  // 顺序说明：先创建窗口（mainWindow 赋值），再初始化 manager、注册 IPC
  //   - 这样 PCP controller 注册时 mainWindow 已存在，dialog.showOpenDialog(mainWindow) 能正常模态附着
  //   - 页面 onMounted 触发调 IPC 时，handler 已注册（loadURL 异步加载，onMounted 晚于同步的 registerIpcHandlers）
  createWindow()
  initFeatures()
  registerIpcHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 捕获未处理的异常，方便调试
process.on('uncaughtException', (error) => {
  console.error('[Main Process] uncaughtException:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Main Process] unhandledRejection:', reason)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
