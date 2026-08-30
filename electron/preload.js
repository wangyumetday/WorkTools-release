// ============================================================
// Preload：渲染层与主进程的 IPC 桥接层
//
// 架构说明（contextIsolation=false + nodeIntegration=false 简化版）：
//   ┌──────────────┐         window.api（本文件直接赋值）
//   │  Vue 组件    │ ───────────────────────────────────┐
//   │  (渲染进程)  │    调用 api.pcp.taskAdd() 等        ▼
//   └──────────────┘                              ┌──────────────┐
//                                                 │  preload.js │
//                                                 └──────┬───────┘
//                                                        │ ipcRenderer.invoke / on
//                                                        ▼
//                                                 ┌──────────────┐
//                                                 │  main.js 的  │
//                                                 │ ipcMain handlers │
//                                                 └──────────────┘
//
// nodeIntegration 保持为 false，渲染进程 JS 无法直接 require Node/Electron 模块，
// 只能调用本文件暴露的白名单方法（本质上还是 IPC，只是暴露方式更简单）。
//
// 命名空间划分（每个 feature 一个对象，互不踩踏）：
//   - api.pcp.*       PriceComparisonPolicy（数据处理）feature 的 IPC
//   - api.erc.*       ExchangeRateConversion（汇率转换）feature 的 IPC
//   - api.floating.*  悬浮窗的 IPC
// ============================================================

import { ipcRenderer } from 'electron'

const api = {
  // ---------- PCP feature：数据处理 ----------
  pcp: {
    // Task：任务队列（添加/删除/清空/启动/暂停/查状态/设并发数）
    taskAdd:             (task)              => ipcRenderer.invoke('pcp:task:add', task),
    taskDelete:          (taskId)            => ipcRenderer.invoke('pcp:task:delete', taskId),
    taskClear:           ()                  => ipcRenderer.invoke('pcp:task:clear'),
    taskStart:           (stage)             => ipcRenderer.invoke('pcp:task:start', stage),
    taskPause:           ()                  => ipcRenderer.invoke('pcp:task:pause'),
    taskGetState:        ()                  => ipcRenderer.invoke('pcp:task:getState'),
    taskSetConcurrency:  (n)                 => ipcRenderer.invoke('pcp:task:setConcurrency', n),
    // 订阅型：任务进度推送 / 全部完成推送
    onTaskProgress:      (callback)          => ipcRenderer.on('pcp:task:progress',    (_event, data) => callback(data)),
    onTaskAllComplete:   (callback)          => ipcRenderer.on('pcp:task:allComplete', (_event, data) => callback(data)),
    // 订阅型：任务错误推送（BUG-2：失败任务的错误按内容分组推送，前端弹 notification 不自动关闭）
    onTaskError:         (callback)          => ipcRenderer.on('pcp:task:error',       (_event, data) => callback(data)),
    // 订阅型：任务列表完整状态推送（addBatch 后 / stage 切换时主进程主动推，渲染层据此刷新列表 + 重建 id 索引）
    onTaskState:         (callback)          => ipcRenderer.on('pcp:task:state', (_event, data) => callback(data)),

    // File：Excel 上传/读取 a1/a2/a3/下载结果
    fileUploadXlsx:      ()                  => ipcRenderer.invoke('pcp:file:uploadXlsx'),
    fileGetA1:           ()                  => ipcRenderer.invoke('pcp:file:getA1'),
    fileGetA2:           ()                  => ipcRenderer.invoke('pcp:file:getA2'),
    fileGetA3:           ()                  => ipcRenderer.invoke('pcp:file:getA3'),
    fileDownloadResult:  ()                  => ipcRenderer.invoke('pcp:file:downloadResult'),
    // 下载目录：获取 / 选择 / 在系统文件管理器中打开
    fileGetDownloadDir:    ()                => ipcRenderer.invoke('pcp:file:getDownloadDir'),
    fileSelectDownloadDir: ()                => ipcRenderer.invoke('pcp:file:selectDownloadDir'),
    // 打开下载目录；传 filePath 时定位到该文件（打开所在文件夹并选中）
    fileOpenDownloadDir:   (filePath)        => ipcRenderer.invoke('pcp:file:openDownloadDir', filePath),
    // 订阅型：下载进度推送（payload: { progress: 0~100 | -1 }）
    onFileDownloadProgress: (callback)       => ipcRenderer.on('pcp:file:downloadProgress', (_event, data) => callback(data)),

    // Credential：账号管理（多平台多账号）
    credentialList:      ()                  => ipcRenderer.invoke('pcp:credential:list'),
    credentialAdd:       (credential)        => ipcRenderer.invoke('pcp:credential:add', credential),
    credentialDelete:    (id)                => ipcRenderer.invoke('pcp:credential:delete', id),
    credentialSelect:    (id)                => ipcRenderer.invoke('pcp:credential:select', id),
    credentialUpdate:    (credential)        => ipcRenderer.invoke('pcp:credential:update', credential),

    // Config：平台配置（底价公式等）
    configGet:           ()                  => ipcRenderer.invoke('pcp:config:get'),
    configGetSchema:     ()                  => ipcRenderer.invoke('pcp:config:getSchema'),
    configSet:           (config)            => ipcRenderer.invoke('pcp:config:set', config),

    // Pipeline：步骤流编排（阶段3：auto/dev 模式 + 前置门禁 + 步骤触发）
    pipelineStart:        ()                 => ipcRenderer.invoke('pcp:pipeline:start'),
    pipelineTriggerStep:  (step)             => ipcRenderer.invoke('pcp:pipeline:triggerStep', step),
    pipelineSetMode:      (mode)             => ipcRenderer.invoke('pcp:pipeline:setMode', mode),
    pipelineSetBusinessMode: (mode)          => ipcRenderer.invoke('pcp:pipeline:setBusinessMode', mode),
    pipelinePause:        ()                 => ipcRenderer.invoke('pcp:pipeline:pause'),
    pipelineAbort:        ()                 => ipcRenderer.invoke('pcp:pipeline:abort'),
    pipelineGetState:     ()                 => ipcRenderer.invoke('pcp:pipeline:getState'),
    pipelineReset:        ()                 => ipcRenderer.invoke('pcp:pipeline:reset'),
    // 订阅型：流程状态变化（mode/status/step）+ 门禁失败（含 missing，渲染层据此闪烁引导）
    onPipelineState:      (callback)         => ipcRenderer.on('pcp:pipeline:state',    (_event, data) => callback(data)),
    onPipelineGateFail:   (callback)         => ipcRenderer.on('pcp:pipeline:gateFail', (_event, data) => callback(data)),

    // 限流额度监控：按需拉取初值 + 订阅运行期推送（payload: { limit, used, remaining, cooldownRemainingMs, active }）
    ratelimitGetState:    ()                 => ipcRenderer.invoke('pcp:ratelimit:getState'),
    onRateLimitState:     (callback)         => ipcRenderer.on('pcp:ratelimit:state',  (_event, data) => callback(data))
  },

  // ---------- ERC feature：汇率转换 ----------
  erc: {
    // 拉取最新汇率（以 USD 为锚定）
    getExchangeRate:     ()                  => ipcRenderer.invoke('erc:exchange:getRate'),
    // 拉取所有国家信息（含币种代码）
    getCountriesList:    ()                  => ipcRenderer.invoke('erc:exchange:getCountries')
  },

  // ---------- 悬浮窗 ----------
  floating: {
    // 主窗口触发：打开悬浮窗（如已存在则显示并置顶）
    open:                ()                  => ipcRenderer.invoke('floating:open'),
    // 悬浮窗内触发：鼠标进入 → 展开
    expand:              ()                  => ipcRenderer.invoke('floating:expand'),
    // 悬浮窗内触发：鼠标离开 + 延迟 → 缩成图标
    collapse:            ()                  => ipcRenderer.invoke('floating:collapse'),
    // 关闭悬浮窗
    close:               ()                  => ipcRenderer.invoke('floating:close'),
    // 监听悬浮窗状态变化（如被手动关闭、最小化），主窗口 UI 据此更新按钮态
    onStateChange:       (callback)          => ipcRenderer.on('floating:stateChange', (_event, data) => callback(data))
  },

  // ---------- 自动更新（主进程原生对话框已处理；此处为后续做自定义「检查更新」UI 预留） ----------
  update: {
    // 触发检查更新（若有新版本，主进程会弹出原生确认对话框，无需渲染层再处理）
    checkNow:            ()                  => ipcRenderer.invoke('update:checkNow'),
    // 手动触发下载（仅在收到 update:state.available 事件后调用才有意义）
    downloadNow:         ()                  => ipcRenderer.invoke('update:downloadNow'),
    // 下载完成后退出并安装（仅在收到 update:state.downloaded 事件后调用）
    quitAndInstall:      ()                  => ipcRenderer.invoke('update:quitAndInstall'),
    // 订阅更新事件：payload { type, data }
    //   type 枚举: checking / available / not-available / downloading / downloaded / error
    onStateChange:       (callback)          => ipcRenderer.on('update:state', (_event, data) => callback(data))
  }
}

// 使用 defineProperty 赋值：不可枚举（避免被 for-in 误扫）、不可重写（防止被页面意外覆盖），
// 但 value 可以读（组件调方法是正常读属性调用，不受 writable:false 影响）。
Object.defineProperty(window, 'api', {
  value: api,
  writable: false,
  configurable: false,
  enumerable: false
})
