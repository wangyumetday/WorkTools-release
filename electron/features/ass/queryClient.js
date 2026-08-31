// ============================================================
// ASS QueryClient - 携程低价政策推荐查询
// 职责：模仿网页 #/selfTest/LowPrice 的两步调用流程：
//
//   step1（主查询，useNewPriceCompare=false，无 routeSearchToken）
//         → 返回主行列表，每行自带 routeSearchToken
//   step2（展开对比价，useNewPriceCompare=true + 该行 token）
//         → 返回该航班一条记录，children 内是该航班各代理的对比价
//
// 反爬要领（来自网页行为记录分析）：
//   - 与登录窗口共用 persist:ass-ctrip 分区，cookies 自动携带（同源会话鉴权）
//   - User-Agent / Referer / Accept 对齐真实桌面浏览器（默认 Electron UA 会暴露程序身份）
//   - 仅由用户点击触发，无并发、无轮询，避免高频调用触发风控
// ============================================================

import { session } from 'electron'
import { randomUUID } from 'node:crypto'

const BASE_URL = 'https://intlflightsupplier.ctrip.com'
const API_URL = `${BASE_URL}/partnerportal/api/lowpricesearch`
const PARTITION = 'persist:ass-ctrip'

const REQUEST_CONST = {
  baseUrl: BASE_URL,
  apiUrl: API_URL,
  partition: PARTITION,
  channel: 'EnglishSite',
  sizePerPage: 40,
  // 伪装桌面 Chrome（与真实网页一致的 UA 风格）
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  referer: `${BASE_URL}/`
}

export class AssQueryClient {
  /**
   * 执行主查询（step1）
   * @param {object} form 查询表单
   *   - tripType: 'OW' | 'RT'
   *   - departCity / arriveCity: 城市三字码，如 'JNB'
   *   - departDate: 'YYYY-MM-DD'；RT 时还需 returnDate
   *   - validatingCarrier: 开票航司二字码，默认 'FA'
   *   - seatGrade: 舱等 'Y'（经济舱）/ 'C'（商务舱）/ 'F'（头等舱）
   *   - travelerCount / childTravelerCount: 人数
   *   - channel / subChannel: 主渠道 / 子渠道
   *   - specialSupply: 特殊参数（bool）
   * @param {number} pageNo 页码（默认 1）
   */
  async run(form, pageNo) {
    const body = this.buildBody(form, pageNo, {
      useNewPriceCompare: false,
      routeSearchToken: null
    })
    const result = await this.post(API_URL, body)
    if (!result.ok) return result
    const rows = result.data?.lowPrices ?? []
    return { ok: true, rows }
  }

  /**
   * 展开某主行的对比价 children（step2）
   * @param {object} form 与主查询一致的表单上下文（channel/航司/舱等随 token 绑定查询）
   * @param {string} routeSearchToken step1 主行返回的 token
   */
  async expand(form, routeSearchToken) {
    if (!routeSearchToken) {
      return { ok: false, error: '缺少 routeSearchToken，无法展开对比价' }
    }
    const body = this.buildBody(form ?? {}, 1, {
      useNewPriceCompare: true,
      routeSearchToken
    })
    const result = await this.post(API_URL, body)
    if (!result.ok) return result
    const rows = result.data?.lowPrices ?? []
    const row = rows[0] ?? null
    return { ok: true, row, children: row?.children ?? [] }
  }

  /**
   * 构建请求体（与网页行为记录中的请求结构一致）
   * 注：agentId 经实测不是必填，网页默认视图也不携带，省略以贴近网页行为
   */
  buildBody(form, pageNo, extra) {
    const segments = [
      {
        segmentNo: 1,
        departCity: form.departCity ?? '',
        arriveCity: form.arriveCity ?? '',
        departDate: form.departDate ?? ''
      }
    ]
    if (form.tripType === 'RT' && form.returnDate) {
      segments.push({
        segmentNo: 2,
        departCity: form.arriveCity ?? '',
        arriveCity: form.departCity ?? '',
        departDate: form.returnDate
      })
    }
    return {
      header: { requestID: String(Date.now()) },
      tripType: form.tripType || 'OW',
      channel: form.channel || REQUEST_CONST.channel,
      subChannel: form.subChannel ?? 0,
      validatingCarrier: form.validatingCarrier || 'FA',
      seatGrade: form.seatGrade || 'Y',
      travelerCount: form.travelerCount ?? 1,
      childTravelerCount: form.childTravelerCount ?? 0,
      debug: false,
      segments,
      specialSupply: !!form.specialSupply,
      useNewPriceCompare: !!extra.useNewPriceCompare,
      routeSearchToken: extra.routeSearchToken || null,
      sessionId: randomUUID(),
      pageNo: pageNo ?? 1,
      sizePerPage: REQUEST_CONST.sizePerPage
    }
  }

  /**
   * 以登录分区会话 POST 请求（session.fetch 自动携带该分区 cookies）
   */
  async post(url, body) {
    let res
    try {
      const ses = session.fromPartition(PARTITION)
      res = await ses.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
          Referer: REQUEST_CONST.referer,
          'User-Agent': REQUEST_CONST.userAgent
        },
        body: JSON.stringify(body)
      })
    } catch (err) {
      return { ok: false, code: 'NETWORK_ERROR', error: `网络错误: ${err?.message || err}` }
    }

    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      // 未登录 / 会话过期时接口会跳回登录页返回 HTML
      if (!res.ok || /^\s*</.test(text)) {
        return { ok: false, code: 'LOGIN_EXPIRED', error: '登录已失效，请重新登录' }
      }
      return { ok: false, code: 'BAD_RESPONSE', error: `响应解析失败 (HTTP ${res.status})` }
    }

    if (!res.ok) {
      return { ok: false, code: 'HTTP_ERROR', error: `HTTP ${res.status}` }
    }
    if (json.status !== 1) {
      return { ok: false, code: 'BIZ_ERROR', error: json.msg || '接口返回失败' }
    }
    return { ok: true, data: json.data }
  }
}