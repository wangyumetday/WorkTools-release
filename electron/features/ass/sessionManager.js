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
const POLL_INTERVAL_MS = 800

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
      cookieCount: data?.cookieCount ?? 0
    }
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
    this.loginWindow = new BrowserWindow({
      width: 1000,
      height: 720,
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

    this.loginWindow.loadURL(LOGIN_URL)

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

    const data = {
      token,
      cookies,
      cookieCount: cookies.length,
      loginAt: Date.now()
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