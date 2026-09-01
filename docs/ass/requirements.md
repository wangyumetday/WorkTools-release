# ASS 模块需求规格书（Airline Search Simulator）

> 版本：v1.2\
> 日期：2026-08-31\
> 状态：实现中\
> 变更记录：
> * v1.1 新增 §4.2.1 锦绣请求实现标准（必须抄 PCP/jxgj，解耦约束）
> * v1.2 §5.2 从"阶段性 mock"升级为 **L2 方案正式实现**：可见 BrowserWindow + 同 partition + DOM 填单 + CDP 抓响应；新增 §5.3 抖动/限频参数

***

## 1. 概述

### 1.1 目标

ASS（航线搜索模拟模块）的核心目标是：**尽可能真实地模拟用户在「携程 OTA 网站」上对多条航线、多个日期进行低价政策查询的完整人工流程**，并将查询结果经过用户可编辑的处理函数后保存到本地文件。

### 1.2 关键特性

\*- 从 Excel 批量导入「出发机场 / 到达机场」航线对

* 界面可选航司 + 日期区间，自动展开全部查询参数

* **两阶段查询架构**：锦绣国际预检（航班存在性过滤，请求实现抄 PCP 模块 jxgj 标准） → 携程正式低价查询

* **按天串行执行**：Day-N 全部请求完成后才进入 Day-(N+1)

* 两阶段各用独立的数据处理函数与独立输出文件

* **模块间严格解耦**：ass 与 pcp 之间不得互相 import / 调用任何函数、常量，PCP 的锦绣实现只能通过**复制源代码**的方式迁移到 ass

* 用户可随时编辑处理函数，当前默认原样透传

***

## 2. 用户界面（UI）

### 2.1 界面元素

| 元素      | 类型            | 是否必填   | 说明                                      |
| ------- | ------------- | ------ | --------------------------------------- |
| 文件选择器   | 文件 input      | **必填** | 支持 `.xlsx` 格式。选择后需显示文件名与「读取到 N 条航线对」。   |
| 航司输入框   | 文本框           | 可选     | 留空代表不指定航司；填写后**所有航线**共用此航司。             |
| 日期区间选择器 | 双 date picker | **必填** | 开始日期 + 结束日期，**区间为闭区间**（首尾两日都包含）。        |
| 开始按钮    | 按钮            | —      | 点击后触发整个流程；执行中变为「停止」按钮。                  |
| 进度展示区   | 区域            | —      | 显示：当前阶段（P1 / P2）、当前日期、已完成请求数 / 总请求数、日志。 |

### 2.2 Excel 文件格式

Excel 中至少包含两列：

| 列 A    | 列 B    |
| ------ | ------ |
| 出发机场代码 | 到达机场代码 |
| JNB    | GUR    |
| HLA    | CPT    |
| ...    | ...    |

* 表头可存在也可不存在；解析时自动识别首行是否为纯三字码（3 字母 / 3 字母+数字）。

* **Excel 中不出现航司列**，航司统一由界面输入。

* 行内任一机场为空 → 该行跳过。

* 重复行（同一 dep+arr 出现多次）→ 去重。

***

## 3. 查询参数生成

### 3.1 参数展开逻辑

设：

* Excel 解析后去重得到 **R 条航线对** `(dep_i, arr_i)`，i = 1..R

* 界面填写的航司为 **A**（为空则 `A = null`）

* 日期区间闭区间展开后得到 **D 个日期** `date_j`，j = 1..D

则总查询参数数 = **R × D**，每条结构如下：

```json
{
  "dep": "JNB",
  "arr": "GUR",
  "airline": "SA" | null,
  "date": "2026-09-01"
}
```

### 3.2 执行顺序（核心约束）

**按天串行、日内按航线顺序。**

```
┌─ Day 1 (2026-09-01) ──────────────────────┐
│  Route 1: JNB→GUR + airline + 2026-09-01  │
│  Route 2: HLA→CPT + airline + 2026-09-01  │
│  ...                                       │
│  Route R: ...                              │
└────────── Day 1 全部完成 ──────────────────┘
              ↓
┌─ Day 2 (2026-09-02) ──────────────────────┐
│  Route 1: JNB→GUR + airline + 2026-09-02  │
│  ...                                       │
└────────── Day 2 全部完成 ──────────────────┘
              ↓
            ...
              ↓
┌─ Day D (最后一天) ────────────────────────┐
```

> 注意：不能先跑完 JNB→GUR 的所有日期再跑 HLA→CPT。必须按天粒度切分。

***

## 4. 两阶段查询流程

### 4.1 流程全景

```
┌───────────────────────────────────────────────────────────────┐
│  Phase 1：锦绣国际官网 — 航班存在性预检                          │
│                                                               │
│  对每个 QueryParam → 请求锦绣国际 → 判断是否返回有效航班数据      │
│                   → 写入 hasFlight 标记                        │
│                   → 经过 processP1()                         │
│                   → 追加写入 p1_<timestamp> 文件               │
└──────────────────────────┬────────────────────────────────────┘
                           │ 全部 QueryParam 完成后，得到
                           │ 一份带 hasFlight 标记的列表
                           ▼
┌───────────────────────────────────────────────────────────────┐
│  Phase 2：携程 OTA — 低价政策正式查询                           │
│                                                               │
│  仅对 hasFlight=true 的 QueryParam → 模拟用户操作携程查询        │
│                                   → 经过 processP2()         │
│                                   → 追加写入 p2_<timestamp>文件 │
│  hasFlight=false 的 QueryParam → 直接跳过（写一行跳过记录也可）  │
└───────────────────────────────────────────────────────────────┘
```

### 4.2 Phase 1 — 锦绣国际预检

| 项      | 说明                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| 目标站点   | 锦绣国际 TaskResult/GetList 接口（详见 §4.2.1）                                                                               |
| 处理对象   | **全部** R×D 个 QueryParam                                                                                             |
| 判定规则   | 响应 `Msg=='OK'` 且 `(Content.Total>0 OR Content.List.length>0)` → `hasFlight=true`；否则 `false`；Msg≠OK / 网络异常 → §8.3 处理 |
| 结果标记   | 给每条 QueryParam 追加字段：`hasFlight: boolean`                                                                            |
| 数据处理函数 | **`processP1(rawInput) → output`**（详见第 6 章）                                                                         |
| 输出文件   | `ass_outputs/p1_YYYYMMDD_HHmmss.<ext>`                                                                              |
| 行为模拟   | **不需要**。普通 HTTP 请求即可（锦绣国际没有风控或无需登录）。                                                                                |

### 4.2.1 Phase 1 锦绣请求实现标准（严格抄 PCP/jxgj）

PCP 模块 `electron/features/pcp/platforms/jxgj/` 目录下的锦绣接口封装是**按官方接口文档编写、经过验证的正确实现**，ASS 模块 Phase 1 的锦绣请求实现必须**逐行迁移其 HTTP 层行为**，保证 URL、参数名、重试、超时、响应校验完全一致。

#### 4.2.1.1 强解耦约束（红线，不可违反）

* **ass 与 pcp 两个 feature 之间不得建立任何代码依赖**：

  * 禁止 `import from '../pcp/...'` 或任何跨 feature 的 `require / import`

  * 禁止运行时通过全局对象 / ipc 通道把 pcp 的函数/配置传给 ass

  * 唯一允许的迁移方式：**把 PCP/jxgj 中需要的源代码**复制、粘贴**到 ass 自己的源码目录**，作为 ass 内部独立模块存在

* 复制后允许改名，以及删除 PCP 业务专属内容（`floorPriceFormula`、`A1_FIELDS`、`airportToCity`、`HuiLvZhuanHuan`、`configSchema`、`mergeResult`、`compileConfig` 等 PCP 独有下游处理，ass 一概不需要）

* 但 §4.2.1.2 表中列出的 HTTP 层要素必须与 PCP 的 `taskResultApi.js` 行为**逐行一致**

#### 4.2.1.2 必须完整复制的 PCP HTTP 行为清单

对照源文件 `electron/features/pcp/platforms/jxgj/taskResultApi.js` + `adapter.js` L54-58：

| #  | 要素             | PCP 中的具体值 / 行为                                                                                                                       | ass 是否必须一致 |
| -- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1  | Base URL       | `https://spider.xxklf.com/taskresult`                                                                                                | **必须一致**   |
| 2  | Endpoint       | `/api/TaskResult/GetList`                                                                                                            | **必须一致**   |
| 3  | HTTP 方法        | `GET`                                                                                                                                | **必须一致**   |
| 4  | Header         | `Accept: application/json`                                                                                                           | **必须一致**   |
| 5  | 请求超时           | `15000 ms`，使用 `AbortController` 触发中断                                                                                                 | **必须一致**   |
| 6  | 最大重试次数         | `MAX_RETRIES = 3`，attempt 从 0 到 3，共最多 4 次发出                                                                                          | **必须一致**   |
| 7  | 触发重试的 HTTP 状态码 | `{429, 500, 502, 503, 504}`                                                                                                          | **必须一致**   |
| 8  | 重试退避算法         | 指数退避：`delay = 2^attempt * 1000 + Math.random() * 500` ms                                                                             | **必须一致**   |
| 9  | 网络层异常重试        | 非 HTTP 错误（网络断连、AbortError、DNS 失败 等）同样按 #6/#8 重试                                                                                      | **必须一致**   |
| 10 | 参数键名映射         | `priceStart → '价格开始'`, `priceEnd → '价格结束'`, `priceType → '价格类型'`, `currentPage → 'CurrentPage'`, `pageSize → 'PageSize'`；其余 key 原样传递 | **必须一致**   |
| 11 | 空值过滤           | 值为 `undefined / null / ''` 的参数不出现在 query string 中                                                                                    | **必须一致**   |
| 12 | 默认 PageSize    | `200`                                                                                                                                | **必须一致**   |
| 13 | 响应解析           | 必须 `await res.json()`；解析失败抛 `TaskResult 响应非 JSON`                                                                                    | **必须一致**   |
| 14 | Msg 缺失兜底       | `res.Msg === undefined` 时补 `res.Msg = 'OK'`（匹配 PCP adapter L56）                                                                      | **必须一致**   |
| 15 | 鉴权             | 无需登录，无 Token / Cookie                                                                                                                | **必须一致**   |

> **不需要** 复制的 PCP 内容：`fetchAllPages` 自动翻页（ass Phase 1 只需要第一页结果存在与否 → 就能判断 hasFlight 真假，不需要翻下一页）、底价计算、汇率转换、舱位匹配 `findItemByCwItem`、`fieldNames`、按日期分组等 PCP 专有业务逻辑。

#### 4.2.1.3 QueryParam → TaskResult/GetList 参数映射（ass 独有规则）

由 ass 的 `QueryParam { dep, arr, airline, date }` 组装成 GetList query：

| QueryParam 字段 | GetList 参数名  | 值处理规则                                                       |
| ------------- | ------------ | ----------------------------------------------------------- |
| `dep`         | `depAirPort` | 原样三字码                                                       |
| `arr`         | `arrAirPort` | 原样三字码                                                       |
| `airline`     | `carrier`    | 如果为空 / null → **不传**（交由 #11 空值过滤自动剔除）；否则原样二字码               |
| `date`        | `depDate`    | 格式转换：`YYYY-MM-DD` → `YYYY-MM-DDT00:00:00`（补时分秒 `T00:00:00`） |
| —             | `PageSize`   | 固定 `200`（见 #12）                                             |

不传 `CurrentPage`（服务端默认 = 1），不传其余查询参数。

#### 4.2.1.4 hasFlight 判定规则

```
try:
    rawResponse = fetchWithRetry(...)     // 按 §4.2.1.2 执行（含 Msg 缺失兜底）
    if rawResponse.Msg != 'OK':
        throw BusinessError(rawResponse.Msg)
    total = rawResponse.Content?.Total ?? 0
    list  = rawResponse.Content?.List  ?? []
    hasFlight = (total > 0) OR (list.length > 0)
catch err:
    hasFlight = null    // UNKNOWN，交由 §8.3 处理（进入 P2 当作有航班）
```

### 4.3 Phase 2 — 携程正式查询

| 项      | 说明                                                           |
| ------ | ------------------------------------------------------------ |
| 目标站点   | 携程 OTA 网站（低价政策页面 / 后台查询接口）                                   |
| 处理对象   | 仅 Phase 1 中 `hasFlight === true` 的 QueryParam（数量 ≤ R×D）      |
| 跳过规则   | `hasFlight === false` 的参数：跳过请求。**建议在输出文件里写一行 SKIP 占位，便于对账**。 |
| 数据处理函数 | **`processP2(rawInput) → output`**（详见第 6 章）                  |
| 输出文件   | `ass_outputs/p2_YYYYMMDD_HHmmss.<ext>`                       |
| 行为模拟   | **需要**。详见第 5 章。                                              |

***

## 5. 用户行为模拟（Browser Simulation）

### 5.1 适用范围

仅以下两处与携程交互的步骤需要模拟真实用户网页行为：

1. **携程登录**：首次启动需要登录（或登录态失效时重登）。
2. **携程查询**：每次发送低价政策查询请求，需要模拟用户在页面上的操作流程。

其余所有步骤（Excel 解析、参数展开、Phase 1 请求、Phase 1/2 数据处理、文件写入等）均为普通程序逻辑，**不需要**任何浏览器模拟。

### 5.2 正式实现方案：L2 — 可见 BrowserWindow + 同 Partition 真实页面（已采纳，见 ADR-5）

基于「docs/ass/ctrip-anti-bot-survey.md」调研结论，携程供应商后台部署 **L1-L6 全栈反爬 + L4b 自研签名体系（rms.js/WASM + c-sec.js + CDID v4）**。任何 Node.js 直连方案都会在 TLS/JA4、HTTP/2、Cookie 滚动、动态签名、登录-查询一致性画像 5 个维度暴露机器人特征。

因此采用 **L2（可见 BrowserWindow 内真实页面跑 fetch）**：

| # | 约束 | 说明 | 解决检测层 |
|---|---|---|---|
| C1 | 登录窗口和查询窗口**共用同一 session partition** (`persist:ass-ctrip`) | 登录产生的 localStorage.token / httpOnly cookies / CDID / AB 分组 / Canvas 画像 自动被查询请求携带；JA4/UA/H2 参数字节级一致 | L2 / L3 / L4b / L6 |
| C2 | **Partition 级 UA = 纯 Chrome 128**，登录窗口与查询窗口再做 webContents 级兜底 | UA/sec-ch-ua 与 Canvas/WebGL/Win10 platform 保持自洽，不出现 Electron/TRAESOLOCN/WorkTools 字样 | L3 JA4H / L6 一致性 |
| C3 | 查询窗口 **默认可见 (show:true)**，不设 parent 模态 | 用户可以自由在窗口里晃鼠标 / 滚屏 / 焦点切换 → UBT bee/collect 上报的事件 **isTrusted=true + 自然时序噪声**，比 sendInputEvent 合成更真实 | L4 Canvas 真实渲染路径 + L5 行为 |
| C4 | **查询触发 = 纯 DOM .value + .click()**，不使用 OS 级 sendInputEvent 合成鼠标 | 不与用户真实光标控制权打架；点击/输入本身触发 isTrusted=true 的 DOM-level 事件（足够通过 c-sec 签名拦截器） | 与"真人晃鼠标"行为共存 |
| C5 | **响应捕获 = CDP Network 域**（debugger.attach + Network.responseReceived + getResponseBody） | 直接抓 POST /partnerportal/api/lowpricesearch 的真实响应体（已过 rms.js 签名拦截器），不在页面内 monkey-patch fetch（避免被 c-sec 反篡改检测） | 绕过 L4b 签名逆向成本 |
| C6 | **DOM 表格解析兜底** | CDP 没挂上或响应体抓取失败时，从页面表格按列抽取结构化行返回 Content.List | 偶发异常容错 |
| C7 | **任务运行中误关窗口 → hide() 不 destroy()**；任务结束还原 | 保持 partition、CDP 会话、SDK 全局变量（_RSG/_RDG 滚动令牌）不丢失；避免"每次关窗后重新生成 GUID/CDID 跳变"的 L6 打标 | L5 CDID 长期稳定 / L6 会话画像 |
| C8 | 登出时先 destroy 查询窗口，再 clearStorageData(cookies+localstorage) | 防止清空 partition 后页面 SDK 还在用过期 token 发请求，造成风控异常 | L6 账号画像一致性 |

**Seam 封装**（保持与 §5.2 原签名兼容，上游 queryEngine.js 零修改）：
```js
// tripClient.js — 对外函数签名完全不变
async function tripQuery(queryParam, session, requestLogin): Promise<{Msg, Content:{Total, List}}>

// 依赖注入（由 controller.js 启动时设置一次，单账号 = 单窗口实例）
function setQueryBrowser(qBrowser: QueryPageBrowser)
```

### 5.3 请求抖动 / 限频参数（已实现）

为通过 L1（频率限流）、L5（点击间隔分布）、L6（行为画像）三层联合检测，所有携程查询请求间自动加入以下节奏：

| 参数 | 值 | 算法 | 说明 |
|---|---|---|---|
| 查询间延迟 | min=3s, mean=6s, max=15s | 指数分布（泊松抖动）`-mean*Math.log(Math.random())` | 真人查询间隔典型分布：方差 ≈ 均值² |
| 批量休息 | 每 50 条查询一次 | 45~90 秒均匀分布 randBetween(45s, 90s) | "人类喝口水/接电话"休息间隔 |
| 预打开时机 | 任务启动 → 登录检查通过 → Phase 1 跑锦绣期间立即 open 查询窗口 | — | 让用户在 Phase 1 的 1-2 分钟内就可以在查询窗口里晃鼠标，等 Phase 2 开始时 UBT 行为历史已经连续且自然 |
| 每日上限 / 工作时段 | 默认只在 09:00-22:00 / 单账号 500 条/日 | — | （预留开关，未强绑；后续如遇封可在 UI 上开放配置） |

> **L2.5 可选升级（当前未实现，预留接口）**：后续如需分布式或遇 IP 封，则通过 `session.fromPartition().setProxy()` 把整个分区挂到住宅代理（sticky session：同账号同一 IP 连续用 1-3 天）。不改 QueryPageBrowser 内部逻辑。


***

## 6. 数据处理函数（processP1 / processP2）

### 6.1 设计原则

* 两个阶段使用**不同的处理函数**。

* 函数体当前默认为「原样透传」，用户后续自行编辑内部逻辑。

* 函数签名由框架固定，用户只改函数体内部。

### 6.2 推荐文件组织

```
src/features/ass/userHooks/
  ├── processP1.js    # Phase 1 数据处理函数（用户编辑区）
  └── processP2.js    # Phase 2 数据处理函数（用户编辑区）
```

### 6.3 processP1 — Phase 1 处理函数

```js
/**
 * Phase 1 数据处理函数
 * @param   {object}  ctx                 上下文（输入参数 + 原始响应）
 * @param   {object}  ctx.queryParam      当前查询参数 { dep, arr, airline, date }
 * @param   {any}     ctx.rawResponse     锦绣国际接口的原始响应；请求失败时为 null
 * @param   {boolean|null} ctx.hasFlight  Phase 1 判定结果：true=有航班，false=无，null=UNKNOWN(请求异常/业务异常，见 §8.3)
 * @param   {Error|null} [ctx.error]      请求异常对象（仅 UNKNOWN 时有值）
 * @returns {any}                         要写入 P1 输出文件的单条记录
 */
export function processP1(ctx) {
  // 默认：原样透传（用户后续在此自由修改）
  return {
    queryParam: ctx.queryParam,
    hasFlight:  ctx.hasFlight,
    raw:        ctx.rawResponse,
    error:      ctx.error ? { name: ctx.error.name, message: ctx.error.message } : null,
  };
}
```

### 6.4 processP2 — Phase 2 处理函数

```js
/**
 * Phase 2 数据处理函数
 * @param   {object}  ctx                 上下文
 * @param   {object}  ctx.queryParam      当前查询参数 { dep, arr, airline, date }
 * @param   {any}     ctx.rawResponse     携程的原始响应；SKIP 或 请求错误时为 null
 * @param   {"SKIP"|"OK"|"ERROR"} ctx.status  "SKIP"=P1 标为无航班直接跳过；"OK"=成功请求了携程；"ERROR"=携程请求失败（见 §8.3）
 * @param   {Error|null} [ctx.error]      请求异常对象（仅 status=="ERROR" 时有值）
 * @returns {any}                         要写入 P2 输出文件的单条记录
 */
export function processP2(ctx) {
  // 默认：原样透传
  return {
    queryParam: ctx.queryParam,
    status:     ctx.status,
    raw:        ctx.rawResponse, // SKIP / ERROR 时为 null
    error:      ctx.error ? { name: ctx.error.name, message: ctx.error.message } : null,
  };
}
```

### 6.5 约束

* 函数可以返回任意类型（对象、数组、字符串），只要文件写入器能序列化即可。

* 如果函数抛异常：**记录为错误行**，不中断整体流程（错误行附 error 字段写入文件）。

***

## 7. 输出文件

### 7.1 文件命名

所有输出文件统一放在 `ass_outputs/` 目录下（与 exe 同级或项目根目录，由实现决定）。命名规则：

| 文件 | 命名规则                       | 示例                         |
| -- | -------------------------- | -------------------------- |
| P1 | `p1_YYYYMMDD_HHmmss.<ext>` | `p1_20260831_142033.jsonl` |
| P2 | `p2_YYYYMMDD_HHmmss.<ext>` | `p2_20260831_142033.jsonl` |

* 同一轮任务的 P1 / P2 两个文件使用**相同的时间戳**（即开始任务时一次性生成，不要 P1 结束后再生成新的），便于配对。

* **文件永不删除**，P1 文件具有日志性质。

### 7.2 文件格式

当前阶段以实现方便为第一优先。推荐：

* **JSON Lines (`.jsonl`)**：每处理完一条就写一行 `JSON.stringify(result)` + 换行。优点：实时落盘、不怕中断、后续易处理。

* 备选：`.json` 数组（需要最后一次性 flush）、`.csv`、`.xlsx`。

文件格式的切换通过一个简单的 Writer 抽象封装，后续切换不需要改流程代码。

### 7.3 P1 文件中每条记录的语义

对应 `processP1` 的返回值。至少应能还原：

* 是哪条 QueryParam（dep、arr、airline、date）

* hasFlight 标记（`true`=有航班 / `false`=无航班 / `null`=UNKNOWN 请求异常）

* 原始响应快照（成功时有值，UNKNOWN 时为 null，用于排错）

* 若为 UNKNOWN：包含 error 对象（name + message）

### 7.4 P2 文件中每条记录的语义

对应 `processP2` 的返回值。至少应能还原：

* 是哪条 QueryParam

* status（OK / SKIP）

* SKIP 的行也要写进去，不能凭空消失（保证 P2 行数 = P1 中 hasFlight=true 的数量 + 明确的 SKIP 占位行，或总记录数与 P1 对齐，取决于 SKIP 是否落盘——推荐与 P1 对齐，SKIP 也写一行）。

***

## 8. 进度与错误处理

### 8.1 进度展示

界面上持续展示：

* 阶段：`Phase 1 / Phase 2`

* 当前日期（例如 2026-09-15），在 P1 和 P2 都要显示

* 当前阶段完成数 / 总数（例如 P1: 340 / 600，P2: 120 / 358）

* 最近几条日志（时间 + 摘要：成功/失败/跳过，dep→arr date）

### 8.2 单日边界

* P1 进入下一天的条件：Day-N 所有航线的 P1 请求全部完成（成功或失败，不等待重试成功）。

* P2 进入下一天的条件同上。

### 8.3 单条请求失败

* **Phase 1**：网络错误、接口超时等 → 视为「无法判断航班是否存在」。推荐处理：`hasFlight` 标记为 `null` / `"UNKNOWN"`，进入 P2 时：默认不跳过（保守策略，当作可能有航班去查携程），或按用户配置选择。

  * 初版实现：**UNKNOWN 按「有航班」处理**（宁查勿漏）。

* **Phase 2**：请求失败 → 记录 error 到文件，不中断。

### 8.4 停止按钮

用户点击停止 → 完成当前正在执行的单条请求后立即结束（不粗暴中断以免文件损坏）。P1 已完成的标记结果：如果没跑完整个 P1，**不进入 P2**（因为 P1 结果不完整，无法安全过滤）。

***

## 9. 数据流完整示例

假设：

* Excel 有 2 条航线：(JNB→GUR)、(HLA→CPT) → R=2

* 用户未填航司 → A=null

* 日期区间 2026-09-01 \~ 2026-09-02 → D=2，共 4 个 QueryParam

### Step 1：生成 QueryParam 列表

```
QP1: { JNB, GUR, null, 2026-09-01 }
QP2: { HLA, CPT, null, 2026-09-01 }
QP3: { JNB, GUR, null, 2026-09-02 }
QP4: { HLA, CPT, null, 2026-09-02 }
```

### Step 2：Phase 1（按天顺序，Day 1 先完成再 Day 2）

```
Day 1:
  QP1 → 锦绣 → 有航班 → hasFlight=true  → processP1 → 写入 p1 文件 (第1行)
  QP2 → 锦绣 → 无航班 → hasFlight=false → processP1 → 写入 p1 文件 (第2行)
Day 2:
  QP3 → 锦绣 → 有航班 → hasFlight=true  → processP1 → 写入 p1 文件 (第3行)
  QP4 → 锦绣 → 有航班 → hasFlight=true  → processP1 → 写入 p1 文件 (第4行)
```

P1 结束后得到带标记的 4 条数据：QP1✓, QP2✗, QP3✓, QP4✓

### Step 3：Phase 2（QP2 被跳过）

```
Day 1:
  QP1 → 携程查询 → status=OK   → processP2 → 写入 p2 文件
  QP2 → 跳过     → status=SKIP → processP2 → 写入 p2 文件 (SKIP占位行)
Day 2:
  QP3 → 携程查询 → status=OK   → processP2 → 写入 p2 文件
  QP4 → 携程查询 → status=OK   → processP2 → 写入 p2 文件
```

***

## 10. 非功能需求

* **并发控制**：请求之间应有合理的并发上限与间隔（参考现有 ass 模块的 1-3 并发 + ≥300ms 间隔方案），避免被风控拦截。

* **可恢复性**：任何时刻程序崩溃，已写入文件的行不会丢失（JSON Lines 天然保证）。

* **可扩展性**：所有外部系统调用（锦绣接口、携程查询、文件写入器、process 函数）均做模块级封装，单体替换不动主流程。

* **日志**：至少打印每个 QueryParam 的阶段、输入、耗时、成功/失败/跳过状态。

***

## 11. 不在本期范围

* Phase 2 查询结果的二次聚合、可视化报表

* 多 Excel 文件合并处理

* 多套用户自定义处理函数的加载切换

* 浏览器模拟的精细化打磨（按 5.2 节阶段性策略执行）

以上留给后续迭代。
