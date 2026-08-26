// ============================================================
// 渲染进程侧 IPC API 统一入口（给 Vue 组件使用）
//
// 使用方式（所有组件都从此文件 import，禁止直接访问 window.api）：
//   import api from '@/shared/api.js'
//   const res = await api.pcp.taskGetState()
//   const rate = await api.erc.getExchangeRate()
//   await api.floating.open()
//
// 做了三层健壮性保障（永远不会因 window.api 缺失抛 Cannot read properties of undefined）：
//   层 1) 【动态检测】每次调用 api.xxx() 时实时检测 window.api 是否存在（而不是模块导入时
//          一次性检测）——这样即便 Vue 导入 api.js 的时机早于 preload 执行，也能在
//          preload 赋值后自动切到真实调用，不会"永久锁死在 mock 分支"。
//   层 2) 【Mock 兜底】如果 window.api 不存在（例如浏览器直接打开前端、或 preload 未注入），
//          返回空数据/默认值，仅打印 warn。
//   层 3) 【错误带上下文】真实 IPC 调用用 Proxy 包 try/catch，错误信息自动加上
//          `[IPC xxx()]` 方法名前缀和调用参数，一眼看出哪个通道出问题。
//
// 命名空间结构：与 electron/preload.js 完全对应
//   - api.pcp.*       PCP feature（数据处理）
//   - api.erc.*       ERC feature（汇率转换）
//   - api.floating.*  悬浮窗
// ============================================================

// ==================================================
// Mock 兜底（用于非 Electron 环境 / preload 未注入时）
// 返回与真实 IPC 相同形状的空数据，避免组件层因空响应崩
// ==================================================
const mockDelay = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10))

function mockNotReady(name) {
  console.warn(`[api.${name}] 当前环境未检测到 window.api（非 Electron 渲染进程或 preload 未注入），走 mock 兜底。`)
}

const mockApi = {
  // ---------- PCP feature：数据处理 ----------
  pcp: {
    taskAdd:             () => { mockNotReady('pcp.taskAdd');             return mockDelay({ success: false, message: '未连接主进程' }) },
    taskDelete:          () => { mockNotReady('pcp.taskDelete');          return mockDelay(false) },
    taskClear:           () => { mockNotReady('pcp.taskClear');           return mockDelay(true) },
    taskStart:           () => { mockNotReady('pcp.taskStart');           return mockDelay({ success: false, message: '未连接主进程' }) },
    taskPause:           () => { mockNotReady('pcp.taskPause');           return mockDelay({ success: false, message: '未连接主进程' }) },
    taskGetState:        () => { mockNotReady('pcp.taskGetState');        return mockDelay({ tasks: [], isRunning: false, isPaused: false, currentStage: null, concurrency: 1, activeCount: 0 }) },
    taskSetConcurrency:  () => { mockNotReady('pcp.taskSetConcurrency');  return mockDelay({ success: false, concurrency: 1 }) },
    onTaskProgress:      () => { mockNotReady('pcp.onTaskProgress') },
    onTaskAllComplete:   () => { mockNotReady('pcp.onTaskAllComplete') },
    onTaskError:         () => { mockNotReady('pcp.onTaskError') },
    onTaskState:         () => { mockNotReady('pcp.onTaskState') },

    fileUploadXlsx:      () => { mockNotReady('pcp.fileUploadXlsx');      return mockDelay(null) },
    fileGetA1:           () => { mockNotReady('pcp.fileGetA1');           return mockDelay({ data: [], count: 0 }) },
    fileGetA2:           () => { mockNotReady('pcp.fileGetA2');           return mockDelay({ data: [], count: 0 }) },
    fileGetA3:           () => { mockNotReady('pcp.fileGetA3');           return mockDelay({ data: [], count: 0 }) },
    fileDownloadResult:  () => { mockNotReady('pcp.fileDownloadResult');  return mockDelay({ success: false, canceled: false, error: '未连接主进程' }) },
    fileGetDownloadDir:    () => { mockNotReady('pcp.fileGetDownloadDir');    return mockDelay({ dir: '' }) },
    fileSelectDownloadDir: () => { mockNotReady('pcp.fileSelectDownloadDir'); return mockDelay({ success: false, canceled: true }) },
    fileOpenDownloadDir:   () => { mockNotReady('pcp.fileOpenDownloadDir');   return mockDelay({ success: false, error: '未连接主进程' }) },
    onFileDownloadProgress: () => { mockNotReady('pcp.onFileDownloadProgress') },

    credentialList:      () => {
      mockNotReady('pcp.credentialList')
      return mockDelay({ credentials: [], selectedMap: { jxgj: null, trip: null, o2: null, o3: null }, platforms: ['jxgj', 'trip', 'o2', 'o3'] })
    },
    credentialAdd:       () => { mockNotReady('pcp.credentialAdd');       return mockDelay({ success: false }) },
    credentialDelete:    () => { mockNotReady('pcp.credentialDelete');    return mockDelay({ success: false }) },
    credentialSelect:    () => { mockNotReady('pcp.credentialSelect');    return mockDelay({ success: false }) },
    credentialUpdate:    () => { mockNotReady('pcp.credentialUpdate');    return mockDelay({ success: false }) },

    configGet:           () => {
      mockNotReady('pcp.configGet')
      return mockDelay({
        jxgj: { floorPriceFormula: '', markupPercent: 0, enabled: true },
        trip: { enabled: true, rateLimitPerMin: 200 },
        o2:   { floorPriceFormula: '', markupPercent: 0, enabled: true },
        o3:   { floorPriceFormula: '', markupPercent: 0, enabled: true }
      })
    },
    configGetSchema:     () => { mockNotReady('pcp.configGetSchema'); return mockDelay({}) },
    configSet:           () => { mockNotReady('pcp.configSet'); return mockDelay({ success: false }) },

    // Pipeline：步骤流编排（auto/dev 模式 + 门禁 + 步骤触发）
    pipelineStart:        () => { mockNotReady('pcp.pipelineStart');        return mockDelay({ success: false, message: '未连接主进程' }) },
    pipelineTriggerStep:  () => { mockNotReady('pcp.pipelineTriggerStep');  return mockDelay({ success: false, message: '未连接主进程' }) },
    pipelineSetMode:      () => { mockNotReady('pcp.pipelineSetMode');      return mockDelay({ success: false }) },
    pipelinePause:        () => { mockNotReady('pcp.pipelinePause');        return mockDelay({ success: false }) },
    pipelineAbort:        () => { mockNotReady('pcp.pipelineAbort');        return mockDelay({ success: true }) },
    pipelineGetState:     () => { mockNotReady('pcp.pipelineGetState');    return mockDelay({ mode: 'auto', status: 'idle', step: 'upload', lastGateFail: null }) },
    pipelineReset:        () => { mockNotReady('pcp.pipelineReset');        return mockDelay({ success: true }) },
    onPipelineState:      () => { mockNotReady('pcp.onPipelineState') },
    onPipelineGateFail:   () => { mockNotReady('pcp.onPipelineGateFail') }
  },

  // ---------- ERC feature：汇率转换 ----------
  erc: {
    getExchangeRate:     () => { mockNotReady('erc.getExchangeRate');     return mockDelay({ result: 'error', conversion_rates: {}, time_last_update_unix: 0 }) },
    getCountriesList:    () => { mockNotReady('erc.getCountriesList');    return mockDelay([]) }
  },

  // ---------- 悬浮窗 ----------
  floating: {
    open:                () => { mockNotReady('floating.open');       return mockDelay(false) },
    expand:              () => { mockNotReady('floating.expand');     return mockDelay(false) },
    collapse:            () => { mockNotReady('floating.collapse');   return mockDelay(false) },
    close:               () => { mockNotReady('floating.close');      return mockDelay(false) },
    onStateChange:       () => { mockNotReady('floating.onStateChange') }
  },

  // ---------- 自动更新 ----------
  update: {
    checkNow:            () => { mockNotReady('update.checkNow');      return mockDelay({ ok: true }) },
    downloadNow:         () => { mockNotReady('update.downloadNow');   return mockDelay({ ok: true }) },
    quitAndInstall:      () => { mockNotReady('update.quitAndInstall') },
    onStateChange:       () => { mockNotReady('update.onStateChange') }
  }
}

// ==================================================
// 运行时检测：当前 window.api 是否是真实注入的 IPC 对象
// 检测关键命名空间是否都是 object（防止 partial 注入）
// ==================================================
function hasRealApi() {
  return typeof window !== 'undefined'
    && window.api
    && typeof window.api === 'object'
    && typeof window.api.pcp === 'object'
    && typeof window.api.erc === 'object'
    && typeof window.api.floating === 'object'
}

// ==================================================
// 订阅型方法集合（不需要 Promise 包装，只注册回调）
// 用 `命名空间.方法名` 字符串标识
// ==================================================
const LISTENER_METHODS = new Set([
  'pcp.onTaskProgress',
  'pcp.onTaskAllComplete',
  'pcp.onTaskError',
  'pcp.onTaskState',
  'pcp.onFileDownloadProgress',
  'pcp.onPipelineState',
  'pcp.onPipelineGateFail',
  'floating.onStateChange'
])

// ==================================================
// 包装真实 window.api 的某个命名空间：统一 try/catch + 错误上下文
//   - 不存在的方法 → 返回安全空函数并 warn，不崩
//   - 订阅型方法 → 直接调用 + try/catch 包错误
//   - 普通 invoke 方法 → Promise 包装 + 错误信息加方法名和参数
// ==================================================
function wrapNamespace(realNamespace, namespaceName) {
  return new Proxy(realNamespace, {
    get(target, prop) {
      const methodName = String(prop)
      const fullName = `${namespaceName}.${methodName}`
      const original = target[prop]

      // 情况 1：调用了不存在的方法 → 返回安全空函数并 warn，不崩
      if (typeof original !== 'function') {
        return (...args) => {
          console.warn(`[api] 调用了不存在的方法: ${fullName}`, args)
          return undefined
        }
      }

      // 情况 2：订阅型方法（如 pcp.onTaskProgress）
      if (LISTENER_METHODS.has(fullName)) {
        return function wrappedListener(...args) {
          try {
            return original.apply(target, args)
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e))
            err.message = `[IPC ${fullName}()] ${err.message}`
            console.error(err)
            throw err
          }
        }
      }

      // 情况 3：普通 IPC invoke 方法 → Promise 包装 + 错误带上方法名和参数
      return async function wrappedInvoke(...args) {
        try {
          return await original.apply(target, args)
        } catch (e) {
          const err = e instanceof Error ? e : new Error(typeof e === 'object' ? JSON.stringify(e) : String(e))
          // 错误信息加前缀：[IPC xxx()] 原始错误消息
          err.message = `[IPC ${fullName}()] ${err.message}`
          // 附加调用参数（截断到 200 字符，避免 console 爆炸）
          try {
            const argsStr = args.length
              ? JSON.stringify(args).slice(0, 200)
              : '(no args)'
            err.message += `\n  调用参数: ${argsStr}`
          } catch { /* ignore */ }
          console.error(err)
          throw err
        }
      }
    }
  })
}

// ==================================================
// 最终导出口：调用时动态判断用真实还是 mock
//   - 用 Proxy 动态转发，每次访问 api.pcp/api.erc/api.floating 时实时走 hasRealApi
//   - 真实 API 的每个命名空间 Proxy 包装缓存到 window.__wrappedApiCache，
//     避免每次调用都新建 Proxy
// ==================================================
const api = new Proxy({}, {
  get(_target, namespace) {
    // Vue 响应式系统（isRef/unref/isReactive）会访问 Symbol 属性探测对象类型，
    // 这些不是真实 API 调用，直接返回 undefined 避免触发 wrapNamespace 报错
    // （window.api[Symbol] = undefined，new Proxy(undefined) 会抛 "non-object target"）
    if (typeof namespace === 'symbol') return undefined

    const namespaceName = String(namespace)

    if (hasRealApi()) {
      // 只对真实存在的命名空间包装，避免未知 key（如 Vue 内部探测）走 wrapNamespace 报错
      const realNamespace = window.api[namespaceName]
      if (realNamespace && typeof realNamespace === 'object') {
        // 缓存真实 API 的 Proxy 包装，避免每次调用都新建 Proxy
        if (!window.__wrappedApiCache) {
          window.__wrappedApiCache = {}
        }
        if (!window.__wrappedApiCache[namespaceName]) {
          window.__wrappedApiCache[namespaceName] = wrapNamespace(realNamespace, namespaceName)
        }
        return window.__wrappedApiCache[namespaceName]
      }
      return undefined
    }

    // 没真实 API 就走 mock 对应命名空间
    return mockApi[namespaceName]
  }
})

export default api
