// ============================================================
// 携程低价查询客户端（真实实现：复用 QueryPageBrowser 可见窗口）
// ------------------------------------------------------------
// seam 契约不变（无需改 queryEngine.js 调用方）：
//   async tripQuery(queryParam, session, requestLogin)
//
// 依赖注入（由 controller.js 在 registerAssController 时设置一次）：
//   setQueryBrowser(QueryPageBrowser instance)
//
// 真实实现要点（对应 docs/ass/ctrip-anti-bot-survey.md §7 L2）：
//   1. 登录/查询共用 persist:ass-ctrip partition，TLS/H2/Cookie/Canvas 一致
//   2. 查询窗口默认可见，用户自由晃鼠标 → UBT 行为样本 isTrusted=true
//   3. 触发：纯 DOM .value + .click()，不与用户真实光标抢位置
//   4. 捕获：CDP Network 域抓 /lowpricesearch 的响应体（已过 rms.js 签名）
//   5. 兜底：CDP 抓不到则 DOM 解析表格返回 Content.List
//   6. 间隔：QueryPageBrowser.query() 内部保证上一请求返回后随机 3~7 秒才发下一请求
// ============================================================

/** @type {import('./queryPageBrowser.js').QueryPageBrowser|null} 由 controller.js 注入 */
let _queryBrowser = null

/** 由 controller.js 启动时注入一次（保证单账号 = 单窗口实例） */
export function setQueryBrowser(instance) {
  _queryBrowser = instance || null
}
export function getQueryBrowser() {
  return _queryBrowser
}

/**
 * 携程低价政策查询
 *
 * @param {object}   queryParam            { dep, arr, airline, date }
 * @param {object}   [session]             当前登录快照；缺失或 loggedIn=false → 触发登录
 * @param {()=>Promise<boolean>} [requestLogin]  触发用户手动登录的回调
 * @returns {Promise<any>}                 接口原始响应 JSON（Content.Total / Content.List）
 */
export async function tripQuery(queryParam, session = null, requestLogin = null) {
  // ---------- Step 1: 登录检查（主进程 session 快照层）----------
  // 注意：本地 sessMgr 快照为 true ≠ 页面 localStorage.token 仍有效（服务器可能踢下线/异地登录）。
  // 这里只做"明显未登录"的前置拦截；页面级登录态丢失会在 Step 3 里通过 LOGIN_REQUIRED 再次兜底。
  const loggedInSnap = !!(session && session.loggedIn)
  if (!loggedInSnap) {
    if (typeof requestLogin !== 'function') {
      throw new Error('携程未登录且未提供 requestLogin 回调，请先在右上角完成登录')
    }
    const ok = await requestLogin()
    if (!ok) {
      throw new Error('用户未完成携程登录或登录窗口已关闭，当前查询已放弃（可重新开始或点击右上角"登录携程"）')
    }
    // 登录完成：partition 里 token/cookies 已就绪，QueryPageBrowser 下次 waitForReady 会拿到
  }

  if (!_queryBrowser) {
    throw new Error('tripClient 未绑定 QueryPageBrowser 实例（controller 初始化异常）')
  }

  // ---------- Step 2: 打开查询窗口（首次创建；已创建则恢复显示+回到低价页）----------
  try {
    await _queryBrowser.open()
  } catch (e) {
    throw new Error(`打开携程查询窗口失败：${e?.message || String(e)}`)
  }

  // ---------- Step 3: 执行查询 + 页面级登录态兜底重试策略 ----------
  // 分层策略：
  //   尝试 1：正常 query(qp)
  //     若 LOGIN_REQUIRED 且 (session 快照为真登录 _或_ 业务 Msg 显示未登录)：
  //       → [Fix C] 先自动 reloadAndWait (不打扰用户)，重试一次 query
  //       → 仍失败 → 真的调用 requestLogin 让用户手动登录，再重试一次 query
  //   最后仍不行 → throw
  let attempts = 0
  const MAX_ATTEMPTS = 3
  let lastErr = null
  let triedReload = false
  let triedRelogin = false
  while (attempts < MAX_ATTEMPTS) {
    attempts++
    try {
      const resp = await _queryBrowser.query(queryParam)
      // 【业务层识别"登录失效"】
      if (_isLoginExpiredResponse(resp)) {
        if (!triedReload) {
          await _queryBrowser.reloadAndWaitForReady()
          triedReload = true
          continue
        }
        if (!triedRelogin) {
          if (typeof requestLogin !== 'function') {
            throw new Error('携程登录已过期（接口返回未登录），但未提供 requestLogin 回调')
          }
          const relogOk = await requestLogin()
          if (!relogOk) {
            throw new Error('携程登录过期且用户未完成重新登录，当前查询已放弃')
          }
          triedRelogin = true
          triedReload = false // 真·重新登录后重置 reload 机会（页面SPA 会重新读新 token）
          continue
        }
        lastErr = new Error('LOGIN_EXPIRED_RETRY')
        continue
      }
      return resp
    } catch (err) {
      const msg = String(err?.message || err)
      // QueryPageBrowser.waitForReady / query 明确抛出的"需要登录"
      if (msg === 'LOGIN_REQUIRED' || msg.includes('LOGIN_REQUIRED')) {
        // [Fix C - 第 1 层]：本地 sessMgr 快照是已登录 → 冷启动竞态可能性极高
        //             → 自动 reloadAndWait，不打扰用户
        const loggedInSnap = !!(session && session.loggedIn)
        if (!triedReload && loggedInSnap) {
          await _queryBrowser.reloadAndWaitForReady()
          triedReload = true
          lastErr = err
          continue
        }
        // [Fix C - 第 2 层]：调用 requestLogin 真的请用户重新登录
        if (!triedRelogin) {
          if (typeof requestLogin !== 'function') {
            throw new Error('查询页面检测到未登录（页面路由在 /login），但未提供 requestLogin 回调')
          }
          const ok = await requestLogin()
          if (!ok) {
            throw new Error('用户未完成携程重新登录，当前查询已放弃')
          }
          triedRelogin = true
          triedReload = false // 真登录成功后也再给一次 reload 机会
          lastErr = err
          continue
        }
        lastErr = err
        continue
      }
      // 其他错误直接冒泡（查询超时 / DOM 找不到按钮 / 网络错）
      throw err
    }
  }
  if (lastErr) throw lastErr
  throw new Error(`携程查询未完成：${MAX_ATTEMPTS} 次尝试均未返回有效响应`)
}

/** 简单启发式：接口返回内容里"未登录/鉴权失败"特征 → 当作 LOGIN_EXPIRED 处理 */
function _isLoginExpiredResponse(resp) {
  if (!resp) return false
  // 常见携程返回模式
  if (typeof resp === 'object') {
    const msg = String(resp.Msg ?? resp.Message ?? resp.msg ?? resp.message ?? '').toLowerCase()
    const code = String(resp.Code ?? resp.code ?? resp.Status ?? resp.status ?? '')
    if (
      msg.includes('未登录') ||
      msg.includes('登录过期') ||
      msg.includes('login') ||
      msg.includes('unauth') ||
      msg.includes('鉴权') ||
      msg.includes('没有权限') ||
      code === '401' || code === 'UNAUTHORIZED' || code === 'LOGIN_EXPIRED'
    ) {
      return true
    }
  }
  return false
}

export default { tripQuery, setQueryBrowser, getQueryBrowser }
