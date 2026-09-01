// ============================================================
// ASS SessionManager - 携程供应商后台会话管理
// 职责：
//   1. 打开携程登录页窗口，用户手动登录（滑块验证必须人工完成）
//   2. 登录成功后捕获会话（localStorage token + cookies）保存到本地
//   3. 提供登录状态查询 / 退出登录（清除分区存储）
//
// 会话分区 persist:ass-ctrip：
//   - 登录窗口与自动查询共用同一分区，登录产生的 cookies 自动被查询请求携带
//   - persist: 前缀让 cookies 本身也落盘到 userData/Partitions，双保险
//
// 登录成功判定：轮询页面 localStorage.token 出现且离开 login 路由
// ============================================================

import { BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = 'https://intlflightsupplier.ctrip.com'
const LOGIN_URL = `${BASE_URL}/#/user/login/CN`
const PARTITION = 'persist:ass-ctrip'
const LOW_PRICE_ROUTE = `${BASE_URL}/#/selfTest/LowPrice`
const POLL_INTERVAL_MS = 800

/**
 * 纯 Chrome 用户代理（与登录窗口/查询窗口共享 partition 级 UA）
 * 要求：
 *   - 不得出现 Electron / TRAESOLOCN / WorkTools 等任何非浏览器标识
 *   - 与 Canvas / WebGL / platform / timezone 等 L4 指纹保持自洽（此处选 Win10 × Chrome 128 稳定版）
 */
const PURE_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

/**
 * 配置 partition 级 UA（影响所有该分区下的 HTTP 请求头 User-Agent + navigator.userAgent）
 * 必须在任何使用该 partition 的 BrowserWindow 创建前调用一次。
 * 多次调用幂等。
 */
function ensurePartitionUA() {
  try {
    const ses = session.fromPartition(PARTITION)
    // setUserAgent 第二个参数是 acceptLanguages，顺带对齐 zh-CN 主流顺序（增强 L3 JA4H Header 一致性）
    try {
      ses.setUserAgent(PURE_CHROME_UA, 'zh-CN,zh;q=0.9,en;q=0.8')
    } catch {
      // Electron 旧版本没有第二个参数，回退单参数签名
      ses.setUserAgent(PURE_CHROME_UA)
    }
  } catch (err) {
    console.warn('[ass] 设置 partition UA 失败（不致命，继续执行）：', err?.message)
  }
}

// 注意：不要在模块加载时调 ensurePartitionUA()——此时 app 尚未 ready，
// session.fromPartition 必然抛 “Session can only be received when app is ready”。
// UA 的实际设置发生在 openLoginWindow() / QueryPageBrowser.open()
// （均晚于 app ready，并在创建任何该 partition 的窗口前执行）。

export { PARTITION, BASE_URL, LOGIN_URL, LOW_PRICE_ROUTE, PURE_CHROME_UA, ensurePartitionUA }

export class AssSessionManager {
  /**
   * @param {string} userDataPath Electron userData 目录（主进程注入）
   * @param {Function} getMainWindow 返回主窗口引用（用于状态事件推送）
   */
  constructor(userDataPath, getMainWindow) {
    this.dir = path.join(userDataPath, 'ass')
    this.sessionFile = path.join(this.dir, 'ass-session.json')
    this.getMainWindow = getMainWindow
    this.loginWindow = null
    this.pollTimer = null
    fs.mkdirSync(this.dir, { recursive: true })
  }

  // ------------------------------------------------------------
  // 状态
  // ------------------------------------------------------------

  /** 读取本地保存的会话文件 */
  loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'))
        return data && data.token ? data : null
      }
    } catch {
      // 文件损坏等同未登录
    }
    return null
  }

  saveSession(data) {
    fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2), 'utf-8')
  }

  /**
   * 登录状态：本地缓存有 token 且 cookies 捕获成功即视为已登录。
   * 真实有效性由查询接口判定（失效会返回 LOGIN_EXPIRED 错误提示重新登录）。
   */
  getStatus() {
    const data = this.loadSession()
    return {
      loggedIn: !!(data && data.token && data.cookieCount > 0),
      loginAt: data?.loginAt ?? null,
      loginAtText: data?.loginAt ? new Date(data.loginAt).toLocaleString() : null,
      cookieCount: data?.cookieCount ?? 0,
      accountName: data?.accountName ?? null,
      accountDisplay: this._formatAccountDisplay(data),
    }
  }

  /** 账号名展示优先：有账号名展示账号名，否则展示登录时间 + cookies 数作为 fallback 标识 */
  _formatAccountDisplay(data) {
    if (!data || !data.token) return null
    if (data.accountName) return String(data.accountName)
    const t = data.loginAt ? new Date(data.loginAt).toLocaleDateString() : ''
    return `携程账号@${t || '未知时间'}（${data.cookieCount || 0} cookies）`
  }

  /**
   * 推送会话状态变化事件给渲染层（登录成功 / 取消 / 退出登录）
   */
  pushStatusChanged() {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('ass:session:changed', this.getStatus())
    }
  }

  // ------------------------------------------------------------
  // 登录窗口
  // ------------------------------------------------------------

  /**
   * 打开携程登录页窗口（用户手动登录，含滑块验证）
   * 已打开时聚焦已有窗口，不重复创建
   */
  openLoginWindow() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return
    }

    const mainWindow = this.getMainWindow()
    // 保证登录窗口创建前 partition UA 已设置（确保 ClientHello 后续握手的所有请求 header UA 一致）
    ensurePartitionUA()

    this.loginWindow = new BrowserWindow({
      width: 940,
      height: 700,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      title: '携程供应商后台 - 登录',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false,
        // 独立会话分区：登录产生的 cookies 与查询请求共享
        partition: PARTITION
      }
    })

    // 双保险：webContents 级 UA 兜底；partition 级 UA 已在 ensurePartitionUA 中设置
    try { this.loginWindow.webContents.setUserAgent(PURE_CHROME_UA) } catch {}

    this.loginWindow.loadURL(LOGIN_URL)

    // 登录页强制 100% 缩放：查询窗口与登录窗口共用同一 partition，
    // Chromium 的页面缩放按 origin 存在分区里（HostZoomMap），
    // 查询窗口"已登录"状态下会设 0.25，这里必须显式压回 1 保证登录输入框可见
    const lwc = this.loginWindow.webContents
    try { lwc.setZoomFactor(1) } catch {}
    lwc.once('did-finish-load', () => {
      try { lwc.setZoomFactor(1) } catch {}
    })

    // 窗口被用户手动关闭 → 停止轮询
    this.loginWindow.on('closed', () => {
      this.stopLoginPoll()
      this.loginWindow = null
      this.pushStatusChanged()
    })

    this.startLoginPoll()
    this.pushStatusChanged()
  }

  /** 关闭登录窗口（登录捕获完成后调用） */
  closeLoginWindow() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.close()
    }
  }

  // ------------------------------------------------------------
  // 登录成功轮询
  // ------------------------------------------------------------

  startLoginPoll() {
    this.stopLoginPoll()
    this.pollTimer = setInterval(() => {
      this.checkLoginDone()
    }, POLL_INTERVAL_MS)
  }

  stopLoginPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * 轮询登录页状态：token 出现且路由离开 login 视为登录成功。
   * executeJavaScript 在导航期间可能抛异常，捕获后等下一轮。
   */
  async checkLoginDone() {
    if (!this.loginWindow || this.loginWindow.isDestroyed()) return
    let tokenLen = 0
    let onLogin = true
    try {
      const result = await this.loginWindow.webContents.executeJavaScript(
        `(function () {
          var token = localStorage.getItem('token') || '';
          var hash = location.hash || '';
          return JSON.stringify({ tokenLen: token.length, onLogin: hash.indexOf('login') > -1 });
        })()`
      )
      const parsed = JSON.parse(result)
      tokenLen = parsed.tokenLen || 0
      onLogin = !!parsed.onLogin
    } catch {
      return // 页面导航中，下一轮再查
    }
    if (tokenLen > 0 && !onLogin) {
      await this.captureSession()
    }
  }

  /**
   * 捕获登录会话并落盘：
   *   - localStorage.token（页面鉴权 token）
   *   - 分区内全部 ctrip cookies（含 httpOnly，自动随查询携带）
   *   - 账号名：尝试从 localStorage / 页面 DOM 文本中抽取（供 UI 右上角展示）
   */
  async captureSession() {
    const ses = this.loginWindow.webContents.session
    let token = ''
    try {
      token = await this.loginWindow.webContents.executeJavaScript(
        `(localStorage.getItem('token') || '')`
      )
    } catch {
      token = ''
    }
    if (!token) return

    let cookies = []
    try {
      cookies = await ses.cookies.get({})
    } catch {
      cookies = []
    }

    // ---- 尝试抽取账号名（多种候选，取第一个非空的）----
    let accountName = null
    try {
      accountName = await this.loginWindow.webContents.executeJavaScript(
        `(function () {
          try {
            // 1) 常见 localStorage 账号字段
            var keys = ['userName','username','loginName','loginNameExt','account','userId','email','mobile','supplierName','realName','nickName'];
            for (var i = 0; i < keys.length; i++) {
              var v = localStorage.getItem(keys[i]);
              if (v && v.length > 0 && v.length < 64) return v;
            }
            // 2) 尝试解析 sessionStorage / userInfo JSON
            try {
              var raw = localStorage.getItem('userInfo') || localStorage.getItem('currentUser') || localStorage.getItem('profile');
              if (raw) {
                var u = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (u) return u.userName || u.username || u.name || u.account || u.loginName || u.mobile || u.email || null;
              }
            } catch (_) {}
            // 3) DOM 扫描：.user-name / .username / .account / #user-info 等常见 class
            var sels = ['.user-name','.username','.account-name','.loginName','.nickname','#account','#userName','.user-info .name','header .user .name','.user-box .name'];
            for (var j = 0; j < sels.length; j++) {
              var el = document.querySelector(sels[j]);
              if (el && el.textContent) {
                var t = el.textContent.trim().replace(/\\s+/g,' ');
                if (t && t.length > 0 && t.length < 40) return t;
              }
            }
          } catch (e) {}
          return null;
        })()`
      )
    } catch {
      accountName = null
    }
    if (accountName) accountName = String(accountName).trim()
    if (!accountName) accountName = null

    const data = {
      token,
      cookies,
      cookieCount: cookies.length,
      loginAt: Date.now(),
      accountName,
    }
    this.saveSession(data)

    this.stopLoginPoll()
    // 捕获完成，用户无需再停留在网页 → 关闭登录窗口
    this.closeLoginWindow()
    this.loginWindow = null
    this.pushStatusChanged()
  }

  // ------------------------------------------------------------
  // 退出登录
  // ------------------------------------------------------------

  /**
   * 打开登录窗口并阻塞等待用户完成登录（或超时/取消）。
   * 供 queryEngine → tripClient → requestLogin 链路调用。
   *
   * @param {number} [timeoutMs=10*60*1000] 最长等待 10 分钟
   * @returns {Promise<boolean>} true=登录成功；false=超时/窗口关闭仍未登录
   */
  async waitForLogin(timeoutMs = 10 * 60 * 1000) {
    // 已经登录？直接返回
    if (this.getStatus().loggedIn) return true

    // 打开登录窗口（若未打开）
    this.openLoginWindow()

    const startTs = Date.now()
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        // 1) 已登录 → 成功
        if (this.getStatus().loggedIn) {
          clearInterval(timer)
          resolve(true)
          return
        }
        // 2) 超时 → 失败
        if (Date.now() - startTs > timeoutMs) {
          clearInterval(timer)
          resolve(false)
          return
        }
        // 3) 登录窗口被用户手动关闭且仍未登录 → 取消
        if (!this.loginWindow || this.loginWindow.isDestroyed()) {
          clearInterval(timer)
          resolve(this.getStatus().loggedIn)
          return
        }
      }, 500)
    })
  }

  /**
   * 清空本地会话 + 分区存储（cookies/localstorage），下次查询需重新登录
   */
  async logout() {
    this.stopLoginPoll()
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.destroy()
      this.loginWindow = null
    }
    try {
      const ses = session.fromPartition(PARTITION)
      await ses.clearStorageData({ storages: ['cookies', 'localstorage'] })
    } catch (err) {
      console.warn('[ass] 清除分区存储失败:', err?.message)
    }
    try {
      if (fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile)
    } catch {
      // 删除失败不影响退出
    }
    this.pushStatusChanged()
  }
}