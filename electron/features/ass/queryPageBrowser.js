// ============================================================
// ASS QueryPageBrowser —— 携程低价政策查询页面容器（可见窗口）
// ------------------------------------------------------------
// 设计决策（对应 docs/ass/ctrip-anti-bot-survey.md §7 L2 + CONTEXT.md ADR-5）：
//   1. 与登录窗口共用 partition=persist:ass-ctrip，保证：
//        - 登录/查询 TLS/JA4/H2/Cookie jar/Canvas 指纹 100% 自洽（解决 L2/L3/L6）
//        - 登录产生的 localStorage.token / httpOnly cookies 自动被查询窗口携带
//   2. 窗口默认可见 (show:true)，用户可自由在窗口里晃鼠标/滚屏/切 tab：
//        - UBT bee/collect 上报的事件 isTrusted=true，时序噪声天然真实（解决 L5）
//        - Canvas/WebGL 走真实合成路径，不会出现离屏渲染的"机器人指纹"（解决 L4）
//   3. 查询触发走「纯 DOM 操作 .value + .click()」不碰 OS 级光标：
//        - 不与用户真实鼠标事件抢光标控制权
//   4. 响应捕获优先走 CDP（Chromium DevTools Protocol）Network 域：
//        - 直接抓 POST /partnerportal/api/lowpricesearch 的真实响应体（rms.js 签名已生效）
//        - 无需解析 DOM 表格（列名/结构会变），也无需在页面里 monkey-patch fetch（可能被 c-sec 检测）
//   5. 页面内执行通道优先 CDP Runtime.evaluate（与 Network 域共用同一个已 attach 的 debugger）：
//        - 脚本异常时能拿到 exceptionDetails 的真实错误描述/堆栈，
//          不再只有 executeJavaScript 那句"Script failed to execute"黑箱兜底文案
//        - 填单/校验/点击拆成三个短脚本分步执行，每步自带失败原因（failTag/reason/页面占位符快照）
//        - CDP 挂不上时自动降级 executeJavaScript，错误同样附带渲染进程日志
//   6. 渲染进程诊断采集：Runtime.exceptionThrown / consoleAPICalled / render-process-gone
//      全部进环形缓冲，任何页面交互失败时随错误一起带回主进程日志
//   7. 请求间隔：上一请求返回后随机 3~7 秒才发下一请求（成功/失败都生效，绝不连发）
//   8. 任务执行期间用户误关窗口 → 拦截 close 事件改为 hide()，不销毁会话（保持 partition 持续）
//   9. 窗口显示：物理尺寸 = 逻辑布局尺寸 × 0.25（视觉等比缩小，页面内部布局不变），
//      创建后停靠在屏幕右缘（垂直居中）；缩放只在「已登录」时应用，
//      未登录保持 100%——同一 partition 的 zoom 会串到登录页，必须按登录态显式收敛
// ============================================================

import { BrowserWindow, session, screen } from 'electron'
import { PARTITION, LOW_PRICE_ROUTE, PURE_CHROME_UA, ensurePartitionUA } from './sessionManager.js'

// 低价位目标接口 URL（CDP 捕获时按此过滤 responseReceived）
const TARGET_API_SUFFIX = '/partnerportal/api/lowpricesearch'

// ---- 请求间隔：上一个携程请求返回后，随机等 3~7 秒再发下一个请求 ----
const INTERVAL_MIN_MS = 3000
const INTERVAL_MAX_MS = 7000

// ---- 窗口显示缩放 ----
// 页面内部逻辑布局尺寸（innerWidth/innerHeight、媒体查询、Canvas 画像都按这个走）
const LAYOUT_WIDTH = 1200
const LAYOUT_HEIGHT = 700
// 视觉缩放系数（Chromium zoom 下限 0.25，正好四分之一）
const WINDOW_ZOOM_FACTOR = 0.25
// 物理窗口尺寸 = 逻辑布局 × 缩放系数（视觉上"缩放"，不是"改小布局"）
const PHYSICAL_WIDTH = Math.round(LAYOUT_WIDTH * WINDOW_ZOOM_FACTOR)
const PHYSICAL_HEIGHT = Math.round(LAYOUT_HEIGHT * WINDOW_ZOOM_FACTOR)

// 页面/查询相关超时
const PAGE_READY_TIMEOUT_MS = 120_000       // 打开页面到"表单+token 就绪"最多等 2 分钟（给用户手动登录留足时间）
const QUERY_TIMEOUT_MS = 90_000             // 单条查询：点击查询 → 收到响应 最多 90s

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function randBetween(lo, hi) {
  return Math.floor(lo + Math.random() * (hi - lo + 1))
}

// ============================================================
// QueryPageBrowser 类
// ============================================================
export class QueryPageBrowser {
  constructor(getMainWindow) {
    /** @type {BrowserWindow|null} */
    this.win = null
    this.getMainWindow = getMainWindow || (() => null)
    /** 任务运行锁：为 true 时 close 事件改为 hide() 不销毁 */
    this._taskRunning = false
    /** 最近一次 CDP 响应体（key=requestId，异步 race 用） */
    this._lastResponse = null
    /** CDP 是否已 attach */
    this._debuggerAttached = false
    /** 查询计数器（>0 表示已有过至少一次请求，下一次需先间隔 3~7 秒） */
    this._queryCount = 0
    /** 记录上一次查询完成的时间戳（供诊断/后续策略参考） */
    this._lastQueryFinishedAt = 0
    /** 渲染进程诊断环形缓冲（console / 异常），最多 20 条 */
    this._pageLogTail = []
    /** 渲染进程崩溃信息（render-process-gone） */
    this._rendererGone = null
  }

  // ------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------

  /**
   * 打开查询窗口（若已存在则 focus）。登录/注销后调用。
   * @param {boolean|undefined} loggedIn 登录态：
   *   true       → 应用视觉缩放 0.25（已登录才缩放）
   *   false      → 还原 100%（未登录/重新登录期间不缩放）
   *   undefined  → 不动缩放（waitForReady 等内部复用路径）
   */
  async open(loggedIn = undefined) {
    ensurePartitionUA()

    if (this.win && !this.win.isDestroyed()) {
      // 已创建：如果是之前 hide 的就 show 出来，再 focus
      if (!this.win.isVisible()) this.win.show()
      this.win.focus()
      // 按登录态收敛缩放（分区共享 zoom，必须显式控制，防止串到登录页）
      if (loggedIn !== undefined) this._applyZoom(loggedIn)
      // URL 如果因为用户手动切走了，重新导航回低价页
      try {
        const curUrl = this.win.webContents.getURL() || ''
        if (!curUrl.includes('#/selfTest/LowPrice') && !curUrl.includes('login')) {
          await this._safeLoad(LOW_PRICE_ROUTE)
        }
      } catch {}
      return
    }

    const mainWindow = this.getMainWindow()

    // 停靠位置：屏幕右缘、垂直居中（在构造参数里直接给 x/y，避免窗口先闪到默认位置再跳）
    let dockX = undefined
    let dockY = undefined
    try {
      const wa = screen.getPrimaryDisplay().workArea
      dockX = wa.x + wa.width - PHYSICAL_WIDTH
      dockY = wa.y + Math.round((wa.height - PHYSICAL_HEIGHT) / 2)
    } catch { /* 定位失败不影响创建 */ }

    this.win = new BrowserWindow({
      width: PHYSICAL_WIDTH,
      height: PHYSICAL_HEIGHT,
      x: dockX,
      y: dockY,
      minWidth: 200,
      minHeight: 140,
      // 不设 parent 模态，用户可以自由在主窗口和携程窗口之间切换 + 晃鼠标
      parent: undefined,
      title: '携程供应商后台 · 低价政策查询（执行中请勿关闭）',
      autoHideMenuBar: true,
      show: true,            // 默认可见，供用户真实操作产生 UBT 样本
      webPreferences: {
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false,
        partition: PARTITION,
      },
    })

    // webContents 级 UA 兜底
    try { this.win.webContents.setUserAgent(PURE_CHROME_UA) } catch {}

    // 【关键】任务运行中阻止窗口关闭（改为 hide），保持 partition + CDP 会话 + SDK 全局变量
    this.win.on('close', (e) => {
      if (this._taskRunning && !this.win.isDestroyed()) {
        e.preventDefault()
        try { this.win.hide() } catch {}
        return
      }
      // 非任务期允许正常关闭；closed 事件会清理
    })
    this.win.on('closed', () => {
      this._debuggerAttached = false
      this.win = null
    })

    // 渲染进程崩溃/被杀时记录，任何页面交互失败都会把该信息带回主进程日志
    this.win.webContents.on('render-process-gone', (_e, details) => {
      this._rendererGone = details || {}
      this._pushPageLog(`[render-process-gone] reason=${details?.reason} exitCode=${details?.exitCode ?? '-'}`)
    })

    // ---- 加载低价政策页面 ----
    await this._safeLoad(LOW_PRICE_ROUTE)

    // ---- 视觉缩放：仅已登录时应用（未登录保持 100%，登录窗口不受影响）----
    if (loggedIn !== undefined) this._applyZoom(loggedIn)

    // ---- 挂一次 CDP Network 域（用于后续所有查询抓响应体）----
    await this._attachDebuggerAndEnableNetwork()
  }

  /**
   * 按登录态设置页面缩放。查询窗口与登录窗口共用同一 partition，
   * Chromium 的页面缩放按 origin 存于分区（HostZoomMap），两边会互相影响，
   * 因此这里显式收敛：true → 0.25 视觉缩小；false → 100%。
   */
  _applyZoom(loggedIn) {
    if (!this.win || this.win.isDestroyed()) return
    try {
      this.win.webContents.setZoomFactor(loggedIn ? WINDOW_ZOOM_FACTOR : 1)
    } catch { /* zoom 设置失败不致命 */ }
  }

  /** 显式销毁窗口（登出/应用退出时调用） */
  destroy() {
    this._taskRunning = false
    this._debuggerAttached = false
    this._lastResponse = null
    this._pageLogTail = []
    this._rendererGone = null
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.removeAllListeners('close') } catch {}
      try { this.win.destroy() } catch {}
    }
    this.win = null
  }

  /** 任务开始/结束调用此函数，控制 close 事件的行为 */
  setTaskRunning(v) {
    this._taskRunning = !!v
    if (!v && this.win && !this.win.isDestroyed() && this.win.isVisible() === false) {
      // 任务结束 + 窗口曾被 hide，restore show 出来（用户可能还想看结果）
      try { this.win.show() } catch {}
    }
  }

  // ------------------------------------------------------------
  // 内部：窗口加载 + CDP
  // ------------------------------------------------------------

  /** 渲染进程诊断日志进环形缓冲（最多 20 条） */
  _pushPageLog(text) {
    const t = new Date()
    const ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0')
    this._pageLogTail.push(`${ts} ${text}`)
    if (this._pageLogTail.length > 20) this._pageLogTail.shift()
  }

  /** 组装页面交互类错误：主因 + 渲染进程崩溃标记 + 渲染进程最近日志 */
  _pageError(tag, detail) {
    const parts = [`[${tag}] ${detail}`]
    if (this._rendererGone) {
      parts.push(`注意：渲染进程曾崩溃/被杀（reason=${this._rendererGone.reason} exitCode=${this._rendererGone.exitCode ?? '-'}）`)
    }
    if (this._pageLogTail.length) {
      parts.push('== 渲染进程最近日志 ==\n' + this._pageLogTail.join('\n'))
    }
    return new Error(parts.join('\n'))
  }

  async _safeLoad(url) {
    if (!this.win || this.win.isDestroyed()) return
    try {
      await this.win.loadURL(url, { waitUntil: 'domcontentloaded' })
    } catch (err) {
      // 导航失败不致命（比如网络错），等下一轮 retry 或调用方抛
      console.warn('[ass] QueryPageBrowser 加载失败:', err?.message)
    }
  }

  async _attachDebuggerAndEnableNetwork() {
    if (!this.win || this.win.isDestroyed()) return
    const wc = this.win.webContents
    if (this._debuggerAttached) return
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
      }
      // Network.responseReceived + Network.getResponseBody：捕捉目标响应
      // Runtime.exceptionThrown / Runtime.consoleAPICalled：渲染进程诊断采集
      wc.debugger.on('message', async (_e, method, params) => {
        if (method === 'Network.responseReceived') {
          const url = params.response?.url || ''
          if (!url || !url.includes(TARGET_API_SUFFIX)) return
          const reqId = params.requestId
          try {
            const bodyRes = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: reqId })
            const raw = bodyRes?.body || ''
            const txt = bodyRes.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : String(raw)
            // 保存最新一次匹配到的响应（并发 race 时取最新）
            this._lastResponse = { at: Date.now(), url, text: txt }
          } catch (err) {
            // 某些时序下 getResponseBody 会失败（比如临时重定向），忽略即可
            console.debug('[ass] CDP getResponseBody 失败（可忽略）：', err?.message)
          }
          return
        }
        if (method === 'Runtime.exceptionThrown') {
          const d = params?.exceptionDetails
          let desc = ''
          try {
            desc = String(d?.exception?.description || d?.exception?.value?.description || d?.text || JSON.stringify(d).slice(0, 300))
          } catch {
            desc = '(异常描述提取失败)'
          }
          this._pushPageLog(`[异常] ${desc.slice(0, 400)}`)
          return
        }
        if (method === 'Runtime.consoleAPICalled') {
          const type = params?.type || 'log'
          const msgs = (params?.args || []).map((a) => {
            try {
              if (a && a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
              return a?.description || `[${a?.type}]`
            } catch {
              return '[?]'
            }
          })
          this._pushPageLog(`[console.${type}] ${msgs.join(' ').slice(0, 400)}`)
        }
      })
      await wc.debugger.sendCommand('Network.enable')
      this._debuggerAttached = true
      // Runtime 域：enable 失败不影响主流程（响应用 Network 域，诊断能力只是增强）
      try { await wc.debugger.sendCommand('Runtime.enable') } catch { /* ignore */ }
    } catch (err) {
      // CDP attach 失败不致命，后续 query 会走 DOM 表格解析兜底
      console.warn('[ass] CDP Network 域挂载失败（将降级为 DOM 解析兜底）：', err?.message)
      this._debuggerAttached = false
    }
  }

  // ------------------------------------------------------------
  // 内部：页面准备检查
  // ------------------------------------------------------------

  /**
   * 等待页面进入"可以查询"的状态（宽容版，避免 partition 冷启动竞态）。
   * 判定三要素：
   *   - token 存在（localStorage.token 非空）
   *   - 路由不在 login
   *   - 页面 DOM 里能找到"出发城市/到达城市/查询按钮"三要素
   *
   * 状态机：
   *   Phase A (tolerantMs 内)：哪怕 onLogin / tokenLen===0 也不抛，耐心等（partition localStorage 冷加载异步 + SPA 路由跳转回稳需要几百 ms）
   *   Phase A 仍未就绪 → 自动 reload() 一次（强制 SPA 重新读 partition 中最新的 token/cookies）
   *   Phase B (timeoutMs 内)：再宽容一轮
   *   Phase B 仍停留在 onLogin 且 tokenLen===0 → 真登录失效，throw LOGIN_REQUIRED
   *
   * @param {number} timeoutMs  总超时（含 reload 前后两轮）
   * @param {number} tolerantMs 第一轮"冷加载宽容期"，此期间内即便 onLogin 也不会抛
   */
  async waitForReady(timeoutMs = PAGE_READY_TIMEOUT_MS, tolerantMs = 10_000) {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('查询窗口未创建或已关闭，请重新登录或重启任务')
    }
    // 先尝试打开（未打开时 open 会加载 URL；已打开会恢复 URL）
    await this.open()

    const tolerantCutoff = Date.now() + tolerantMs
    const hardCutoff = Date.now() + timeoutMs
    let reloaded = false

    while (Date.now() < hardCutoff) {
      let info = null
      try {
        const r = await this.win.webContents.executeJavaScript(
          `(function(){
            try {
              var token = localStorage.getItem('token') || '';
              var hash = location.hash || '';
              var onLogin = hash.indexOf('login') > -1;
              var qBtn = null;
              var btns = document.querySelectorAll('button, .ant-btn, .n-button');
              for (var i = 0; i < btns.length; i++) {
                var t = (btns[i].innerText || btns[i].textContent || '').trim();
                if (t === '查询' || t === 'Search' || t.indexOf('查 询') > -1) { qBtn = 'found'; break; }
              }
              var depInput = document.querySelector('input[placeholder*="出发"], input[placeholder*="Departure"], input[placeholder*="起"], #dep, #departCity');
              var arrInput = document.querySelector('input[placeholder*="到达"], input[placeholder*="Arrival"], #arr, #arriveCity, #arrivalCity');
              return JSON.stringify({
                tokenLen: token.length,
                onLogin: onLogin,
                hasForm: !!(qBtn && depInput && arrInput),
              });
            } catch(e) { return JSON.stringify({err:String(e)}); }
          })()`
        )
        info = JSON.parse(r)
      } catch (execErr) {
        // 导航中 / JS 上下文重建 → 继续循环
        info = null
      }

      // --- 成功出口：三要素全满足 ---
      if (info && !info.err && info.tokenLen > 0 && !info.onLogin && info.hasForm) return true

      // --- 判断要不要触发"登录未登录" ---
      const loginLooking = info && !info.err && (info.onLogin || info.tokenLen === 0)
      if (loginLooking) {
        // [Phase A 宽容期内]：partition localStorage 可能仍在从磁盘加载 / SPA 还没跳完路由
        // → 不抛，不 reload，纯等
        if (Date.now() < tolerantCutoff) {
          await sleep(500)
          continue
        }
        // [Phase A 超时 + 尚未 reload]：自动 reload 一次，给 SPA 一次重新读 token 的机会
        //    （冷启动竞态下 SPA 读到空 token 后自己跳 login，但此时 partition 其实已有 token）
        if (!reloaded) {
          try {
            await this.win.webContents.reload()
            reloaded = true
            await sleep(800) // 给 reload 启动首轮 DOM 渲染留点时间
          } catch { /* ignore */ }
          continue
        }
        // [reload 后仍 login 且无 token]：说明真的是登录失效，或者用户从未登录过
        // → 只有当总超时剩余 < tolerantMs 时才抛（给 Phase B 也留够宽容时间）
        if (Date.now() > tolerantCutoff + tolerantMs) {
          throw new Error('LOGIN_REQUIRED')
        }
        await sleep(500)
        continue
      }

      // --- 其他不满足情形：DOM 表单还没渲染（token 有、路由对，但三要素缺 hasForm）继续循环 ---
      await sleep(500)
    }

    throw this._pageError('wait-ready', `页面 ${timeoutMs}ms 内未就绪（表单/DOM未渲染完成或登录态仍未恢复）`)
  }

  /**
   * 暴露给 tripClient / controller 的快捷重载：用于"本地快照已登录但页面实际还在 login"的冷启动竞态兜底。
   * reload 后 waitForReady(tolerantMs=8s) 会自动给 Phase A+B 的宽容期。
   */
  async reloadAndWaitForReady(tolerantMs = 8_000, totalMs = 30_000) {
    if (!this.win || this.win.isDestroyed()) return
    try { await this.win.webContents.reload() } catch {}
    try { await this.waitForReady(totalMs, tolerantMs) } catch {}
  }

  // ------------------------------------------------------------
  // 对外：主查询入口
  // ------------------------------------------------------------

  /**
   * 执行一次携程低价政策查询（含登录态检查 + 请求间隔 + CDP 响应抓取）
   *
   * @param {{dep:string, arr:string, airline?:string|null, date:string}} qp
   * @returns {Promise<any>} 接口原始 JSON（Content.Total / Content.List 结构）
   */
  async query(qp) {
    if (!qp || !qp.dep || !qp.arr || !qp.date) {
      throw new Error(`携程查询参数非法：dep/arr/date 必填，实际=${JSON.stringify(qp)}`)
    }

    try {
      // 1) 请求间隔：上一请求返回后随机等 3~7 秒再继续（第一次不等待；
    //    计数放在 finally，无论成功/失败下一请求都必须间隔，绝不连发）
    if (this._queryCount > 0) {
      await sleep(randBetween(INTERVAL_MIN_MS, INTERVAL_MAX_MS))
    }

    // 2) 准备就绪：窗口打开 + 登录态 + DOM 渲染
    await this.waitForReady()

    // 3) 清理上次响应，并在页面内填充表单 → 点击查询
    this._lastResponse = null
    await this._fillFormAndClick(qp)

    // 4) 等待 CDP 响应体出现（或超时）
    const rawText = await this._waitForResponse(QUERY_TIMEOUT_MS)

    if (rawText) {
      try {
        const json = JSON.parse(rawText)
        return json
      } catch (parseErr) {
        console.warn('[ass] 低价位响应 JSON 解析失败，转 DOM 解析兜底：', parseErr.message)
      }
    }
    // ---- DOM 表格解析兜底 ----
    const fallback = await this._parseTableAsFallback(qp)
    return fallback
    } finally {
      // 无论成功/失败都计数并记录完成时间：保证下一次 query() 一定间隔 3~7 秒
      this._queryCount++
      this._lastQueryFinishedAt = Date.now()
    }
  }

  // ------------------------------------------------------------
  // 内部：页面内脚本执行通道（CDP Runtime.evaluate 优先，executeJavaScript 兜底）
  // ------------------------------------------------------------

  /**
   * 在查询页面里执行一段表达式并返回其返回值（脚本内部用 JSON.stringify 输出字符串）。
   * 优先走 CDP Runtime.evaluate：页面脚本真抛异常时能拿到 exceptionDetails 的
   * 真实错误描述 + 堆栈（不再只有 executeJavaScript 那句黑箱兜底文案）。
   * CDP 未挂载成功时降级 executeJavaScript，失败同样附带渲染进程日志快照。
   */
  async _evaluatePage(expression, tag) {
    const wc = this.win.webContents
    if (!this._debuggerAttached) {
      await this._attachDebuggerAndEnableNetwork()
    }
    if (this._debuggerAttached) {
      let res
      try {
        res = await wc.debugger.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
        })
      } catch (sendErr) {
        throw this._pageError(tag, `CDP Runtime.evaluate 发送失败：${sendErr?.message || sendErr}`)
      }
      if (res && res.exceptionDetails) {
        const d = res.exceptionDetails
        const desc = d.exception?.description || d.exception?.value?.description || d.text || '(无异常描述)'
        throw this._pageError(tag, `页面脚本抛异常：${String(desc).slice(0, 600)}`)
      }
      return res && res.result ? res.result.value : undefined
    }
    try {
      return await wc.executeJavaScript(expression)
    } catch (execErr) {
      throw this._pageError(tag, `executeJavaScript 失败：${execErr?.message || execErr}`)
    }
  }

  // ------------------------------------------------------------
  // 内部：填表单 + 点查询（纯 DOM 操作，不抢用户光标）
  // ------------------------------------------------------------

  /**
   * 填单流程（重写版）——与旧版的区别：
   *   1. 一个大脚本 → 四个短脚本分步执行（fill → pick-date → verify → click），
   *      每一步失败都返回 failTag/reason 而不是笼统报错
   *   2. 失败时把页面真实的 input 占位符 / 按钮文案 / 当前 URL 快照一起带回，
   *      报错信息可直接用于对症修选择器
   *   3. 日期是受控组件（直接写值会被清空）：改为点击输入框打开日期面板，
   *      再在面板里点选目标日期的日历单元格；读回校验对日期做数字归一化比较
   *   4. 值写不进去就报错，绝不假装成功
   */
  async _fillFormAndClick(qp) {
    const depVal = String(qp.dep || '').toUpperCase()
    const arrVal = String(qp.arr || '').toUpperCase()
    const dateVal = String(qp.date || '')
    const airVal = qp.airline ? String(qp.airline).toUpperCase() : ''
    const hasAirline = !!qp.airline

    // ---------- 脚本 A：定位 + 写入 + 派发事件（全步骤状态上报）----------
    const fillScript = `(function(){
      try {
        var steps = [];
        var inputs = [];
        try { inputs = Array.prototype.slice.call(document.querySelectorAll('input')); } catch (e) {}
        function phOf(el) { try { return String((el.getAttribute && el.getAttribute('placeholder')) || '').toLowerCase(); } catch (e) { return ''; } }
        function find(patterns) {
          for (var i = 0; i < inputs.length; i++) {
            var ph = phOf(inputs[i]);
            if (!ph) continue;
            for (var j = 0; j < patterns.length; j++) {
              if (ph.indexOf(String(patterns[j]).toLowerCase()) > -1) return inputs[i];
            }
          }
          return null;
        }
        function setValue(el, val) {
          if (!el) return 'ELEMENT_MISSING';
          try {
            var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (desc && desc.set) { desc.set.call(el, String(val)); } else { el.value = String(val); }
          } catch (e) {
            try { el.value = String(val); } catch (e2) { return 'SET_FAIL:' + String(e2 && e2.message || e2); }
          }
          try { el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); } catch (e) {}
          try { el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch (e) {}
          return 'OK';
        }
        function placeholders() {
          var out = [];
          for (var i = 0; i < inputs.length && out.length < 12; i++) out.push(phOf(inputs[i]).slice(0, 40));
          return out;
        }
        function fail(tag, reason) {
          return JSON.stringify({ ok: false, failTag: tag, reason: reason, steps: steps, placeholders: placeholders() });
        }
        var depEl = find(['出发', 'departure', '起', 'from']);
        if (!depEl) return fail('dep', '未找到出发城市输入框（按 placeholder 匹配，见下方占位符快照）');
        var r = setValue(depEl, ${JSON.stringify(depVal)});
        steps.push({ tag: 'dep', ok: r === 'OK', info: r });
        if (r !== 'OK') return fail('dep', r);
        var arrEl = find(['到达', 'arrival', '抵达', 'to']);
        if (!arrEl) return fail('arr', '未找到到达城市输入框（按 placeholder 匹配，见下方占位符快照）');
        r = setValue(arrEl, ${JSON.stringify(arrVal)});
        steps.push({ tag: 'arr', ok: r === 'OK', info: r });
        if (r !== 'OK') return fail('arr', r);
        var dtEl = find(['出发日期', 'departure date', 'depdate', 'date', '日期']);
        if (!dtEl) return fail('date', '未找到出发日期输入框（按 placeholder 匹配，见下方占位符快照）');
        // 日期是受控组件：直接写值会被组件状态回写清空（React/umi 风格，实测 fill 后 120ms 值归零）。
        // 改为点击输入框打开日期面板，随后由独立脚本在面板中点选日历单元格。
        try { dtEl.click(); } catch (e) { return fail('date', 'DATE_OPEN_CLICK_FAIL:' + String(e && e.message || e)); }
        steps.push({ tag: 'date-open', ok: true, info: 'CLICKED' });
        if (${JSON.stringify(hasAirline)}) {
          var airEl = find(['航司', 'carrier', 'airline', '航空', '开票航司']);
          if (airEl) {
            r = setValue(airEl, ${JSON.stringify(airVal)});
            steps.push({ tag: 'airline', ok: r === 'OK', info: r });
            if (r !== 'OK') return fail('airline', r);
          } else {
            steps.push({ tag: 'airline', ok: true, info: 'SKIP_NO_INPUT' });
          }
        } else {
          steps.push({ tag: 'airline', ok: true, info: 'SKIP_EMPTY' });
        }
        // 行程类型：单程（没有选项卡也不报错）
        try {
          var oneWay = Array.prototype.slice.call(document.querySelectorAll('[class*="tab"] button, label[class*="radio"], .ant-radio-wrapper, .n-radio'));
          for (var w = 0; w < oneWay.length; w++) {
            var tx = '';
            try { tx = String(oneWay[w].innerText || oneWay[w].textContent || '').replace(/\\s+/g, ''); } catch (e) {}
            if (tx === '单程' || tx === 'OneWay' || tx === 'One-way' || tx === 'Single') {
              try { oneWay[w].click(); } catch (e) {}
              steps.push({ tag: 'oneway', ok: true, info: 'CLICKED' });
              break;
            }
          }
          if (steps[steps.length - 1].tag !== 'oneway') steps.push({ tag: 'oneway', ok: true, info: 'SKIP_DEFAULT' });
        } catch (e) {
          steps.push({ tag: 'oneway', ok: true, info: 'SKIP' });
        }
        return JSON.stringify({ ok: true, steps: steps, dateOpened: true, placeholders: placeholders() });
      } catch (e) {
        return JSON.stringify({ ok: false, fatal: String(e && e.message || e) });
      }
    })()`

    // ---------- 脚本 B：读回校验（受控组件 setState 之后）----------
    const verifyScript = `(function(){
      try {
        var inputs = [];
        try { inputs = Array.prototype.slice.call(document.querySelectorAll('input')); } catch (e) {}
        function phOf(el) { try { return String((el.getAttribute && el.getAttribute('placeholder')) || '').toLowerCase(); } catch (e) { return ''; } }
        function val(patterns) {
          for (var i = 0; i < inputs.length; i++) {
            var ph = phOf(inputs[i]);
            if (!ph) continue;
            for (var j = 0; j < patterns.length; j++) {
              if (ph.indexOf(String(patterns[j]).toLowerCase()) > -1) {
                try { return String(inputs[i].value); } catch (e) { return '[READ_FAIL]'; }
              }
            }
          }
          return '[MISSING]';
        }
        return JSON.stringify({
          dep: val(['出发', 'departure', '起', 'from']),
          arr: val(['到达', 'arrival', '抵达', 'to']),
          date: val(['出发日期', 'departure date', 'depdate', 'date', '日期']),
          depExpect: ${JSON.stringify(depVal)},
          arrExpect: ${JSON.stringify(arrVal)},
          dateExpect: ${JSON.stringify(dateVal)}
        });
      } catch (e) {
        return JSON.stringify({ fatal: String(e && e.message || e) });
      }
    })()`

    // ---------- 脚本 B2：在已打开的日期面板中点选目标日期（受控组件走日历提交）----------
    const dateScript = `(function(){
      try {
        var want = ${JSON.stringify(dateVal)};
        function norm(s) {
          var m = /(\\d{4})\\D*(\\d{1,2})\\D*(\\d{1,2})/.exec(String(s || ''));
          if (!m) return '';
          return m[1] + (m[2].length === 1 ? '0' + m[2] : m[2]) + (m[3].length === 1 ? '0' + m[3] : m[3]);
        }
        function sampleTexts(els) {
          var out = [];
          for (var i = 0; i < els.length && out.length < 40; i++) {
            try {
              var txt = String(els[i].innerText || els[i].textContent || '').trim();
              if (!txt || txt.length > 14) continue;
              var tag = els[i].tagName || '';
              var cls = '';
              try { cls = String(els[i].className || ''); } catch (e) {}
              out.push(tag + '.' + cls.slice(0, 24) + ':' + txt);
            } catch (e) {}
          }
          return out.join(' | ');
        }
        var wantN = norm(want);
        var all = [];
        try { all = Array.prototype.slice.call(document.querySelectorAll('td, div, span, li, button, a, [role="gridcell"], [role="cell"]')); } catch (e) {}
        var clicked = null;
        // 1) title 属性精确命中（antd/rc-picker 日历单元格 title 通常是 YYYY-MM-DD）
        for (var i = 0; i < all.length; i++) {
          var t = '';
          try { t = all[i].getAttribute ? (all[i].getAttribute('title') || '') : ''; } catch (e) {}
          if (t && norm(t) === wantN) clicked = all[i]; // 取最后一个匹配（最内层/最具体）
        }
        // 2) 落入文本命中（仅当元素文本"恰好"是完整日期才敢点）
        if (!clicked) {
          for (var j = 0; j < all.length; j++) {
            var txt = '';
            try { txt = all[j].innerText || all[j].textContent || ''; } catch (e) {}
            if (norm(txt) === wantN) clicked = all[j];
          }
        }
        if (!clicked) {
          return JSON.stringify({ ok: false, failTag: 'date-cell', reason: '日期面板中未找到目标日期单元格（' + want + '）', sample: sampleTexts(all) });
        }
        try { clicked.click(); } catch (e) {
          return JSON.stringify({ ok: false, failTag: 'date-cell', reason: 'CELL_CLICK_FAIL:' + String(e && e.message || e), sample: sampleTexts(all) });
        }
        return JSON.stringify({ ok: true });
      } catch (e) {
        return JSON.stringify({ ok: false, fatal: String(e && e.message || e) });
      }
    })()`

    // ---------- 脚本 C：找查询按钮并点击 ----------
    const clickScript = `(function(){
      try {
        var btns = [];
        try { btns = Array.prototype.slice.call(document.querySelectorAll('button, .n-button, .ant-btn, a.btn, [role="button"]')); } catch (e) {}
        function btnText(b) { try { return String(b.innerText || b.textContent || '').replace(/\\s+/g, '').slice(0, 30); } catch (e) { return ''; } }
        var btn = null;
        for (var i = 0; i < btns.length; i++) {
          var t = btnText(btns[i]);
          if (t === '查询' || t === 'Search' || t === '立即查询' || t === 'SearchNow') { btn = btns[i]; break; }
        }
        if (!btn) {
          for (var k = 0; k < btns.length; k++) {
            var cls = '';
            try { cls = String(btns[k].className || ''); } catch (e) {}
            if (cls.indexOf('primary') > -1 && cls.indexOf('cancel') === -1) { btn = btns[k]; break; }
          }
        }
        if (!btn) {
          var names = [];
          for (var m = 0; m < btns.length && m < 15; m++) names.push(btnText(btns[m]));
          return JSON.stringify({ ok: false, failTag: 'query-btn', reason: '未找到查询按钮', buttons: names });
        }
        var clicked = btnText(btn);
        try { btn.click(); } catch (e) {
          return JSON.stringify({ ok: false, failTag: 'query-click', reason: 'CLICK_FAIL:' + String(e && e.message || e), clicked: clicked });
        }
        return JSON.stringify({ ok: true, clicked: clicked });
      } catch (e) {
        return JSON.stringify({ ok: false, fatal: String(e && e.message || e) });
      }
    })()`

    // ---------- 执行：fill → 等受控组件 settle → verify → click ----------
    const fillRaw = await this._evaluatePage(fillScript, 'fill-form')
    let fill = null
    try { fill = JSON.parse(fillRaw) } catch {
      throw this._pageError('fill-form', `页面返回内容无法解析为 JSON：${String(fillRaw || '').slice(0, 300)}`)
    }
    if (!fill) throw this._pageError('fill-form', '页面脚本未返回任何结果')
    if (fill.ok !== true) {
      const where = fill.failTag ? `（步骤 ${fill.failTag}）` : ''
      let detail = `填单失败${where}：${fill.reason || fill.fatal || '未知原因'}`
      if (Array.isArray(fill.placeholders) && fill.placeholders.length) {
        detail += `\n页面 input 占位符(前12个)：${fill.placeholders.filter(Boolean).join(' | ') || '(空)'}`
      }
      throw this._pageError('fill-form', detail)
    }

    await sleep(400) // 等日期面板弹出/渲染

    if (fill.dateOpened) {
      const dateRaw = await this._evaluatePage(dateScript, 'pick-date')
      let dateRes = null
      try { dateRes = JSON.parse(dateRaw) } catch {
        throw this._pageError('pick-date', `页面返回内容无法解析为 JSON：${String(dateRaw || '').slice(0, 300)}`)
      }
      if (!dateRes) throw this._pageError('pick-date', '日期点选脚本未返回结果')
      if (dateRes.ok !== true) {
        let detail = `日期面板点选失败：${dateRes.reason || dateRes.fatal || '未知原因'}`
        if (dateRes.sample) detail += `\n页面可见文本元素快照：${String(dateRes.sample).slice(0, 800)}`
        throw this._pageError('pick-date', detail)
      }
      await sleep(150) // 给组件提交后回写留时间
    }

    const verRaw = await this._evaluatePage(verifyScript, 'verify-form')
    let ver = null
    try { ver = JSON.parse(verRaw) } catch {
      throw this._pageError('verify-form', `页面返回内容无法解析为 JSON：${String(verRaw || '').slice(0, 300)}`)
    }
    if (ver && ver.fatal) throw this._pageError('verify-form', `读回校验脚本异常：${ver.fatal}`)
    if (!ver) throw this._pageError('verify-form', '读回校验脚本未返回结果')

    // 日期允许显示格式差异（2026-09-01 / 2026/9/1 / 2026年9月1日…），按数字归一化比较
    const digitsOf = (s) => {
      const m = /(\d{4})\D*(\d{1,2})\D*(\d{1,2})/.exec(String(s || ''))
      if (!m) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${m[1]}${pad(m[2])}${pad(m[3])}`
    }
    if (ver.dep !== depVal || ver.arr !== arrVal || digitsOf(ver.date) !== digitsOf(dateVal)) {
      throw this._pageError('verify-form',
        `表单值读回校验失败（写入后值不一致，查询结果不可信，已中止本单）：
  出发: 期望=${ver.depExpect} 实际=${ver.dep}
  到达: 期望=${ver.arrExpect} 实际=${ver.arr}
  日期: 期望=${ver.dateExpect} 实际=${ver.date}`)
    }

    const clickRaw = await this._evaluatePage(clickScript, 'click-query')
    let click = null
    try { click = JSON.parse(clickRaw) } catch {
      throw this._pageError('click-query', `页面返回内容无法解析为 JSON：${String(clickRaw || '').slice(0, 300)}`)
    }
    if (!click) throw this._pageError('click-query', '点击脚本未返回结果')
    if (click.ok !== true) {
      const where = click.failTag ? `（步骤 ${click.failTag}）` : ''
      let detail = `点击查询失败${where}：${click.reason || click.fatal || '未知原因'}`
      if (Array.isArray(click.buttons) && click.buttons.length) {
        detail += `\n页面按钮文案：${click.buttons.join(' | ')}`
      }
      throw this._pageError('click-query', detail)
    }
  }

  // ------------------------------------------------------------
  // 内部：等响应 / DOM 兜底
  // ------------------------------------------------------------

  /** 轮询 _lastResponse 出现，返回 text；超时返回 null */
  async _waitForResponse(timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (this._lastResponse && this._lastResponse.text) {
        const t = this._lastResponse.text
        this._lastResponse = null
        return t
      }
      await sleep(200)
    }
    return null
  }

  /** DOM 表格解析兜底（CDP 挂不上/响应抓不到时用） */
  async _parseTableAsFallback(qp) {
    const rows = []
    try {
      const r = await this.win.webContents.executeJavaScript(
        `(function(){
          try {
            var rows = [];
            var tables = document.querySelectorAll('table');
            for (var t = 0; t < tables.length; t++) {
              var trs = tables[t].querySelectorAll('tbody tr, tr');
              for (var r = 0; r < trs.length; r++) {
                var cells = trs[r].querySelectorAll('td, th');
                if (cells && cells.length >= 5) {
                  var arr = [];
                  for (var c = 0; c < cells.length; c++) arr.push((cells[c].innerText || cells[c].textContent || '').trim());
                  // 首列包含"航程/航班号"字样 → 表头行跳过
                  if (arr[0].indexOf('航程') > -1 || arr[0].indexOf('航班号') > -1 || arr[0].indexOf('Route') > -1) continue;
                  rows.push(arr);
                }
              }
              if (rows.length > 0) break;
            }
            return JSON.stringify(rows);
          } catch (e) { return '[]'; }
        })()`
      )
      const parsed = JSON.parse(r)
      // 按 §4.3 列顺序还原：航程/航班号/舱位/产品类型/含税底价/是否外显/旅客资质/属性标签/票面价/税收
      for (const c of parsed) {
        rows.push({
          _fromDom: true,
          columns: c,
          route: c[0] || '',
          flightNo: c[1] || '',
          cabin: c[2] || '',
          productType: c[3] || '',
          priceText: c[4] || '',
          isPublic: c[5] || '',
          passengerQual: c[6] || '',
          tags: c[7] || '',
          facePrice: c[8] || '',
          tax: c[9] || '',
        })
      }
    } catch (e) {
      // DOM 解析也失败了就返回空
    }
    return {
      _fallback: true,
      _generatedAt: new Date().toISOString(),
      query: qp,
      Msg: 'OK',
      Content: {
        Total: rows.length,
        List: rows,
      },
    }
  }
}

export default { QueryPageBrowser }
