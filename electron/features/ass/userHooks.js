// ============================================================
// ASS userHooks - 用户自定义钩子（★ 本文件的业务逻辑由你自己实现 ★）
//
// 整个功能的流程（除下面两个方法外，其余全部由代码自动完成）：
//
//   ① 界面点「选择文件」→ 主进程读取文件内容 fileContent
//        · Excel(xlsx/xls)：自动解析为 rows（数组，每行是 sheet 第一张表的一行对象）
//        · csv/txt/其它：读为 text（原始文本）
//   ② extractQueries(fileContent) —— 你写的提取方法
//        把文件内容解析并拆分成多条「查询请求」（数量 = 你要查的航线×日期组合）
//   ③ 代码自动逐条请求携程低价政策推荐接口（支持并发/间隔/暂停/继续/停止）
//   ④ processQueryResult(context, result, helpers) —— 你写的处理方法
//        每条请求完成（无论成功失败）都调用一次，返回数据交给你处理
//
// 注意：修改本文件后需重启应用生效（主进程启动时加载）。
// ============================================================

/**
 * 文件内容 → 查询请求数组（★ 你来实现 ★）
 *
 * @param {object} fileContent 文件内容
 *   - filePath: 文件完整路径
 *   - fileName: 文件名（含扩展名）
 *   - ext:      扩展名（小写，如 'xlsx' / 'csv' / 'txt'）
 *   - rows:     仅 Excel 文件有值（xlsx 库 sheet_to_json 的结果，对象数组）
 *   - text:     非 Excel 文件的原始文本内容
 *
 * @returns {Array} 查询请求数组，每项一条请求（字段说明）：
 *   {
 *     tripType: 'OW',            // 行程类型：'OW' 单程 | 'RT' 往返（RT 需填 returnDate）
 *     departCity: 'JNB',         // 出发城市三字码（必填）
 *     arriveCity: 'CPT',         // 到达城市三字码（必填）
 *     departDate: '2026-09-04',  // 出发日期 YYYY-MM-DD（必填）
 *     returnDate: '2026-09-08',  // 返程日期 YYYY-MM-DD（仅 RT 需要）
 *     validatingCarrier: 'FA',   // 开票航司二字码（默认 'FA'，可省略）
 *     seatGrade: 'Y',            // 舱等：Y 经济舱 / C 商务舱 / F 头等舱（默认 'Y'）
 *     travelerCount: 1,          // 成人数（默认 1）
 *     childTravelerCount: 0,     // 儿童数（默认 0）
 *     channel: 'EnglishSite',    // 主渠道（默认 'EnglishSite'）
 *     subChannel: 0,             // 子渠道（默认 0）
 *     specialSupply: false,      // 特殊参数（默认 false）
 *     id: '任意标识'             // 可选：你自己的序号/备注，会原样传回 processQueryResult
 *   }
 *
 * 示例（假设 Excel 每行有「出发地」「到达地」「出发日期」三列）：
 *   export function extractQueries(fileContent) {
 *     return (fileContent.rows || []).map((row, i) => ({
 *       id: `${row['出发地']}-${row['到达地']}-${row['出发日期']}`,
 *       tripType: 'OW',
 *       departCity: String(row['出发地'] || '').trim(),
 *       arriveCity: String(row['到达地'] || '').trim(),
 *       departDate: String(row['出发日期'] || '').trim()
 *     }))
 *   }
 */
export function extractQueries(fileContent) {
  // TODO ★ 在这里实现：把 fileContent 拆分成查询请求数组
  throw new Error('请在 electron/features/ass/userHooks.js 中实现 extractQueries 方法')
}

/**
 * 处理单次查询的返回数据（★ 你来实现 ★）
 * 每条请求完成后都会调用一次（成功/失败都会调用）
 *
 * @param {object} context 本次请求的原始对象（就是 extractQueries 返回的数组项）
 * @param {object} result  请求结果
 *   - 成功：{ ok: true, rows: [...] }
 *       rows 是接口返回的 lowPrices 数组，每项字段：
 *       routes / flightNos / seatClasses / productType / agencyCode / gds /
 *       quantifyFlagRemark / sortIndicator / baggages / passengerRestriction /
 *       invoiceType / brandNames / publishPrices / taxes / fareBasisList /
 *       showState / isOwner + routeSearchToken（展开对比价需用）
 *   - 失败：{ ok: false, code, error }
 *       code 取值：'LOGIN_EXPIRED'（登录失效，批处理已自动停止）/
 *                 'NETWORK_ERROR' / 'HTTP_ERROR' / 'BIZ_ERROR' / 'BAD_RESPONSE'
 * @param {object} helpers 辅助工具
 *   - helpers.expand(routeSearchToken)
 *       同级调用携程两步接口第二步：用主行的 token 获取该航班的对比价 children
 *       返回 { ok: true, row, children } 或 { ok: false, error }
 *       （children 字段与上述 rows 条目结构一致）
 *
 * 提示：本方法在主进程运行，可直接用 fs / path 等 Node API 把数据写文件。
 */
export async function processQueryResult(context, result, helpers) {
  // TODO ★ 在这里实现：处理每次请求的返回数据
  // 例如：把 rows 写入 Excel/JSON，或汇总统计
  console.log('[ass] 收到查询结果:', context.id ?? '(无id)', result.ok ? `成功 ${result.rows.length} 条` : `失败 ${result.error}`)
}