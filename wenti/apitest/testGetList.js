/**
 * 锦绣 TaskResult / GetList 接口调用
 *
 * 接口文档: https://spider.xxklf.com/taskresult/swagger/index.html
 * 完整文档见项目根目录: 锦绣TaskResult接口文档.md
 *
 * 技术选型:
 *   - Node.js 24 全局 fetch（原生，无需第三方依赖）
 *   - ESM 模块
 *   - JSDoc 类型标注
 */

// ────────────────────────────────────────────────────────────────────
// 1. 配置
// ────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://spider.xxklf.com/taskresult';

/**
 * GetList 请求参数（全部可选，按需填写）
 * @typedef {Object} GetListParams
 * @property {string}  [fn]           航班号，如 "HO1729"
 * @property {string}  [depDate]      出发日期 "2026-09-20T00:00:00"
 * @property {string}  [arrDate]      到达日期
 * @property {string}  [depAirPort]   出发机场三字码 "NKG"
 * @property {string}  [arrAirPort]   到达机场三字码 "CGQ"
 * @property {string}  [stopAirPort]  经停机场
 * @property {string}  [cabin]        航位 "T" / "Y"
 * @property {string}  [carrier]      航司二字码 "HO"
 * @property {boolean} [gn]           是否经停
 * @property {boolean} [zz]           是否中转
 * @property {number}  [dataSource]   数据来源枚举 0-3
 * @property {string}  [spiderName]   爬虫名称
 * @property {number}  [updateSecond] 更新时间窗口（秒）
 * @property {number}  [currentPage]  当前页码，从 1 开始
 * @property {number}  [pageSize]     每页条数
 * @property {boolean} [isTest]       是否包含测试数据
 * @property {number}  [max_seats]    最大座位数筛选
 * @property {number}  [index]        索引偏移
 * @property {number}  [priceStart]   价格区间下限（CNY）
 * @property {number}  [priceEnd]     价格区间上限（CNY）
 * @property {boolean} [priceType]    价格类型标记
 */

/**
 * GetList 响应结构
 * @typedef {Object} GetListResponse
 * @property {{ Total: number, List: Ticket[] }} Content
 */

/**
 * @typedef {Object} Ticket
 * @property {string} Ticket_ID
 * @property {string} SearchKey
 * @property {string} H航班号_去0
 * @property {number} C出发日期
 * @property {string} C出发时间_Date
 * @property {string} D到达时间_Date
 * @property {string} S数据获取时间_Date
 * @property {number} C成人总票价_CNY
 * @property {number} C成人净票价_CNY
 * @property {string} 承运航司
 * @property {Array}  套餐信息
 * @property {Array}  分段信息
 * @property {Array}  行李信息
 */

// ────────────────────────────────────────────────────────────────────
// 2. 请求构建
// ────────────────────────────────────────────────────────────────────

/**
 * 将参数对象转为 query string，自动跳过 undefined / null / 空字符串
 * @param {GetListParams} params
 * @returns {string}  形如 "?carrier=HO&PageSize=10"，无参数时返回空串
 */
function buildQueryString(params) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const key = k === 'priceStart' ? '价格开始'
                 : k === 'priceEnd'   ? '价格结束'
                 : k === 'priceType'  ? '价格类型'
                 : k === 'currentPage' ? 'CurrentPage'
                 : k === 'pageSize'    ? 'PageSize'
                 : k;
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`;
    });
  return entries.length ? '?' + entries.join('&') : '';
}

/**
 * 调用 GetList 接口
 * @param {GetListParams} params
 * @returns {Promise<GetListResponse>}
 */
async function getList(params = {}) {
  const qs = buildQueryString(params);
  const url = `${BASE_URL}/api/TaskResult/GetList${qs}`;

  console.log(`▶ 请求: GET ${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  /** @type {GetListResponse} */
  const data = await res.json();
  return data;
}

// ────────────────────────────────────────────────────────────────────
// 3. 结果展示
// ────────────────────────────────────────────────────────────────────

/**
 * 格式化输出单条 Ticket
 * @param {Ticket} ticket
 * @param {number} idx
 */
function printTicket(ticket, idx) {
  const fn = ticket.H航班号_去0 ?? '-';
  const route = `${ticket.分段信息?.[0]?.dp ?? '?'} → ${ticket.分段信息?.[0]?.ap ?? '?'}`;
  const depTime = ticket.C出发时间_Date ?? '-';
  const arrTime = ticket.D到达时间_Date ?? '-';
  const price = ticket.C成人总票价_CNY ?? '-';
  const netPrice = ticket.C成人净票价_CNY ?? '-';
  const cabin = ticket.套餐信息?.[0]?.舱位 ?? '-';
  const seats = ticket.套餐信息?.[0]?.座位数 ?? '-';
  const carrier = ticket.承运航司 ?? '-';
  const fetchedAt = ticket.S数据获取时间_Date ?? '-';

  console.log(
    `  [${idx + 1}] ${fn} | ${carrier} | ${route} | ${cabin}舱 | ¥${price}(净¥${netPrice}) | 座位${seats} | ${depTime}~${arrTime} | 采集:${fetchedAt}`
  );
}

/**
 * 打印完整响应摘要
 * @param {GetListResponse} data
 * @param {GetListParams} params
 */
function printResult(data, params) {
  const total = data.Content?.Total ?? 0;
  const list = data.Content?.List ?? [];

  console.log(`\n────────────────────────────────────────────`);
  console.log(`✓ 响应成功`);
  console.log(`  总条数: ${total}`);
  console.log(`  本页条数: ${list.length}`);
  if (params.currentPage || params.pageSize) {
    const page = params.currentPage ?? 1;
    const size = params.pageSize ?? 10;
    const totalPages = Math.ceil(total / size);
    console.log(`  当前页: ${page} / ${totalPages}`);
  }
  console.log(`────────────────────────────────────────────\n`);

  list.forEach((t, i) => printTicket(t, i));
}

// ────────────────────────────────────────────────────────────────────
// 4. 主流程
// ────────────────────────────────────────────────────────────────────

async function main() {
  // 示例 1: 基础分页查询（前 10 条）
  console.log('\n═══ 示例 1: 基础分页查询 ═══');
  try {
    const params = { pageSize: 10, currentPage: 1 };
    const data = await getList(params);
    printResult(data, params);
  } catch (e) {
    console.error('✗ 失败:', e.message);
  }

  // 示例 2: 按航司查询（如 HO 吉祥航空）
  console.log('\n═══ 示例 2: 按航司查询 carrier=HO ═══');
  try {
    const params = { carrier: 'HO', pageSize: 10, currentPage: 1 };
    const data = await getList(params);
    printResult(data, params);
  } catch (e) {
    console.error('✗ 失败:', e.message);
  }

  // 示例 3: 按航线+航司查询（指定航线所有日期）
  console.log('\n═══ 示例 3: 按航司+航线查询 HO / NKG→CGQ ═══');
  try {
    const params = {
      carrier: 'HO',
      depAirPort: 'NKG',
      arrAirPort: 'CGQ',
      pageSize: 50,
      currentPage: 1,
    };
    const data = await getList(params);
    printResult(data, params);
  } catch (e) {
    console.error('✗ 失败:', e.message);
  }

  // 示例 4: 按日期+航线查询
  console.log('\n═══ 示例 4: 按日期+航线查询 NKG→CGQ 2026-09-20 ═══');
  try {
    const params = {
      depAirPort: 'NKG',
      arrAirPort: 'CGQ',
      depDate: '2026-09-20T00:00:00',
      pageSize: 50,
      currentPage: 1,
    };
    const data = await getList(params);
    printResult(data, params);
  } catch (e) {
    console.error('✗ 失败:', e.message);
  }
}

main().catch(console.error);
