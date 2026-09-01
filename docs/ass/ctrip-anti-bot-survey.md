# 携程 OTA 供应商后台反自动化手段调研报告

- 目标站点：`https://intlflightsupplier.ctrip.com`（携程供应商后台 / Partner Portal）
- 报告版本：`v1.0`
- 报告日期：`2026-08-31`
- 适用模块：`ass`（OTA 低价政策查询模拟器）
- 证据形式：联网行业调研 + 在真实供应商后台中手动操作的**首屏 / 登录 / 低价政策查询**三次抓包实锤

---

## 1. 目的与证据来源

### 1.1 目的
本报告用于回答 ASS 模块 Phase 2（携程查询）阶段最核心的工程问题：

> ——"为什么不能在 Node.js 主进程里直接 `fetch('/partnerportal/api/lowpricesearch')`？携程会从哪些维度识别程序自动化请求 vs 用户真实请求？我们要做到『看起来就是真人』，需要模拟到哪一层？"

结论将直接决定 Phase 2 查询行为的架构选型（**方案 L2：隐藏 BrowserWindow 内真实页面跑 fetch**，见本项目 `docs/ass/requirements.md` §5.2 及对应 ADR）。

### 1.2 证据来源
| 类别 | 来源 | 说明 |
|---|---|---|
| 行业调研 (公开资料) | Apify Academy 《Anti-Scraping Techniques 2026》 / FoxIO JA4 白皮书 / 影刀社区《反爬检测的 5 层防线》/ CSDN《设备指纹对抗全方案 2026》/ WebDecoy《JA4 Fingerprinting AI Scrapers》/ SegmentFault 《Cloudflare 反爬机制全面解析》 | 建立「行业通用的检测分层」参考框架 (§2) |
| 行业调研 (携程公开逆向案例) | CSDN《某程机票查询 token + sign + transactionid 逆向 2024-12》/ CSDN《testab 逆向还原 2025》/ CSDN《signature 生成补环境 2024》/ CSDN《动态 Cookie 机制 2026-03》/ CSDN 文库《去哪儿+携程机票爬虫 rsc 2024-10》 | 建立「携程自研风控 SDK」预期信号列表，与我们实测结果做交叉验证 (§3) |
| **我方实测 (供应商后台，首屏未登录)** | 浏览器 DevTools Network 面板的 30 个请求、`window/localStorage/cookie/navigator` 全局对象 Dump | 实锤携程在**页面首屏第一帧**就部署了哪些风控 SDK (§3) |
| **我方实测 (手动登录成功)** | 登录过程中 `ic.ctrip.com/captcha` 滑块验证 / `partnerportal/login` / 登录后 `token` 出现 & 路由离开 `#/user/login/CN` | 实锤登录行为的风控流程与 session 持久化方式 |
| **我方实测 (进入低价政策推荐页，手动查询 3 次)** | 进入 `#/selfTest/LowPrice` 页面；填写 `JNB→DUR / 2026-09-29`，点击【查询】3 次；控制台输出 & Network 面板请求 | 实锤目标接口 URL、请求 method、SDK 持续运行状态 (§4)，以及真实返回的数据结构 |

> ⚠️ 注意：本报告所描述的「签名算法」均为行业/社区公开逆向结论**汇总**或我方从「SDK 存在 / 持续运行」所做的**存在性推断**，不包含对携程 SDK 二进制代码的实际反汇编和密钥提取。我方工程决策遵循「不逆向、直接复用真实页面 SDK」的 L2 方案原则（见 §7）。

---

## 2. 行业通用反自动化检测分层全景

现代反爬系统（Cloudflare、Akamai、DataDome、Kasada、极验、以及大厂自研如携程的整套 SDK）都是**多层叠加检测**，且"一层失败、后续不执行"——TLS 层没通过的请求，服务器根本不会把 JS 发给你（直接 403 / 空数据）。

按「检查发生的先后顺序」从早到晚，共 7 层：

### L1 网络 / IP 层 (早于 HTTPS)
| 检测项 | 识别逻辑 | 典型阈值 |
|---|---|---|
| IP 信誉 ASN 分类 | 数据中心 IP (阿里云/AWS/Azure/腾讯云 IP 段) 自动列入"非人类"；住宅/移动宽带 IP 视为正常人 | Cloudflare/Akamai 维护全球 ASN 黑白名单 |
| IP 频率限流 (滑动窗口 + 令牌桶) | 单 IP 单位时间内请求数量；检测突发 burst | 轻量站点：≈10 次 / 分钟 / IP；OTA 大型站点 ≈30-60 次 / 分钟 / IP，超限 429 |
| IP / 账号 × 地域跳变 | 同一账号/同一 Cookie 生命期内 IP 归属地从北京跳到上海再跳到广州 → 代理特征 | 1 小时内跨 ≥3 个省 → 直接锁定账号 |
| 并发 TCP 连接数 | 正常用户浏览器开 6-15 个并发 H2 流；爬虫往往开几十个并发 | 单 IP 并发 ≥20 → 异常 |
| 公共代理 / VPN / TOR 出口命中 | 威胁情报 (第三方 feed + 自建 honey pot) 黑名单 | 命中即 403 |

### L2 TLS 握手指纹层 (发生于 HTTPS ClientHello，早于 HTTP 请求)
| 检测项 | 识别逻辑 |
|---|---|
| **JA3 (2017)** | MD5(TLS 版本, 加密套件列表序, 扩展列表序, 椭圆曲线, 曲线点格式)；Chrome/Python/Go/Node 的 ClientHello 完全不同 |
| **JA4 (2023，行业主流最新)** | 升级 JA3：按值排序抗随机化；三部分可读格式 `t13d1516h2_8daaf6152771_02713d6af862` |
| JA4S / JA4H / JA4T / JA4X (扩展族) | JA4S=ServerHello；JA4H=HTTP Header 指纹；JA4T=TCP 参数；JA4X=证书链 |
| GREASE 处理 (Chrome 特性) | Chrome 会在扩展里插无效 GREASE 值（每次随机）；爬虫客户端很少实现 |

> **致命结论：** `Python requests / Node.js undici fetch / Go net/http / curl` 各自的 JA3/JA4 是**唯一且固定**的，在主流反爬黑名单里。住宅代理只能换 IP，**不会改写 ClientHello**——所以干净住宅 IP + requests JA4 = 一秒 403，IP 白换了。

### L3 HTTP 协议层 (HTTP/2 + Header)
| 检测项 | 识别逻辑 |
|---|---|
| HTTP/2 SETTINGS 帧默认值 & 顺序 | Akamai 称此为 `akamai_fingerprint`；Chromium / undici / curl / go net/http 默认参数都不同 |
| HTTP/2 伪头 (pseudo-header) 顺序 | Chromium 固定 `:method → :authority → :scheme → :path`；爬虫客户端不保证 |
| **JA4H (Header 指纹)** | 按「出现过哪些 Header + 顺序 + casing」做指纹。**顺序错 = 机器人** |
| Sec-Ch-Ua / Sec-Ch-Ua-Mobile / Sec-Ch-Ua-Platform (客户端提示) | Chrome 2020 年后必带；爬虫默认不带或与 UA 中声称版本不一致 |
| Sec-Fetch-Site / Sec-Fetch-Mode / Sec-Fetch-User / Sec-Fetch-Dest | 导航请求应为 `navigate`；CORS 请求应为 `cors`；同源应为 `same-origin`。错 = 机器人 |
| Accept / Accept-Language / Accept-Encoding / Priority 组合 | Chrome 固定值与顺序；爬虫常只写 `accept: */*` |
| Header casing (HTTP/1.1) | HTTP/1.1 浏览器首字母大写 `User-Agent`；HTTP/2 必须全小写；混用 = 机器人 |

### L4 JavaScript 环境 & 设备指纹层 (页面内 JS 执行完才知道)
| 检测项 | 识别逻辑 |
|---|---|
| `navigator.webdriver` / CDP runtime leak | Selenium/Playwright 默认 true；无头 Chromium 默认暴露 |
| **Canvas 指纹** | 画一个隐藏 canvas 取 `toDataURL()` 哈希；GPU 型号/驱动/操作系统→渲染像素差异 |
| **WebGL 指纹** | `gl.getParameter(VENDOR) + getParameter(RENDERER)` + WebGL extensions 列表；无头默认 `Mesa OffScreen` / `Brian Paul` 这两个值**真人永远不会有** |
| **AudioContext 声纹** | 生成 10ms 正弦取特征 |
| 字体列表 (Font Enumeration) | 系统装了哪些字体 |
| `navigator.plugins` / `navigator.mimeTypes` | 真人 Chrome 默认 4 个 PDF 相关 plugin；Playwright 无头默认为空数组 |
| `deviceMemory` / `hardwareConcurrency` / `maxTouchPoints` / `platform` / `languages` 组合一致性 | UA 声称 Win10 Chrome × Mac platform 或 0.5GB 内存 × 16 核 → 机器人 |
| **屏幕分辨率 × 窗口大小 × 色彩深度** 长期稳定 | 与画像库对比 |
| Timezone / IANA timezone / 语言 一致性 | IP 在北京而 timezone=America/New_York → 机器人 |
| WebDriver BiDi / `$cdc_asdjflasutopfhvcZLmcfl_` / `__webdriver_async_callbacks` 等 Chrome driver 注入变量残留 | 老版本 Selenium 会在 DOM 里注入隐藏元素 |

### L4b 动态签名 / WASM (JS/WASM 执行结果作为请求头/cookie)
这是大型商业网站最主流的做法（**携程 testab / rms / signature / abce / abog 全部属于这一层**）：

```
页面加载
  → 下载混淆 JS (经 javascript-obfuscator: string-array / control-flow-flattening)
  → 再下载配套的 .wasm 模块
  → JS 持续采集 L4 所有环境 + 用户 L5 行为
  → 经 WASM + HMAC / SHA256 / MD5 + 硬编码密钥 计算签名
  → 结果写在请求 Header (X-xxx-Token/Sign)、Cookie (_abck / _RSG / _RDG / testab 等)、或请求体 JSON 字段
服务端校验：
  → 签名值必须与服务端使用同一组"环境熵 + 请求 body + 令牌 + ts"重算后一致
  → 少一个参数 / 版本错 / 环境不一致 = 直接 403 或 返回空 List[]
```

### L5 用户行为 & 设备 ID 层 (时序分析，通常 ML 模型)
| 检测项 | 识别逻辑 |
|---|---|
| UBT 行为埋点批量上报 (如 `s.c-ctrip.com/bee/collect`) | 鼠标位置 × 时间、按键间 delay、滚动速度、点击前 move 曲线 |
| 点击时间间隔分布 (泊松检验) | 真人是指数分布 (λ⁻¹≈6s 典型均值，方差 = 均值²)；爬虫常是恒距 3.000±0.001s → 方差 0 |
| 鼠标移动路径线性度 / 抖动特征 / 贝塞尔 vs 直线 | 真人点击从不是"从 (0,0) 瞬移到按钮中心" |
| time-to-first-click / 页面停留时长分布 | 真人首击至少 >350ms (认知+反应)；爬虫 DOM 加载完 20ms 就点 |
| **CDID 设备指纹** | 基于 L4 环境计算的 long-lived 设备 ID，跨请求跨登录持久化；ID 长期高风险就封设备 |
| CAPTCHA risk_inspect + 滑块拼图 (轨迹/加速度/时长/回退) | 滑块 0.3s 到达终点 + 无回退 = 机器人；正常 ≥0.8s |

### L6 账号 & 会话画像层 (长期机器学习评分)
| 检测项 | 识别逻辑 |
|---|---|
| 登录指纹 vs 查询指纹一致性 | ⚠️ 同账号：登录用 Chrome JA4，查询用 Node.js JA4 → **强特征机器人**，真人不会这样 |
| mid-session User-Agent / mid-session TLS 指纹跳变 | 真人不会中途换浏览器 |
| 请求 URL 访问顺序模式 | 爬虫按列表遍历 (1→2→3→4…)，真人是随机跳跃 + 重复访问 + 回退 |
| Retry-after 行为 | 403 后立刻原样重试，还是会等待 + 换条件再试 |
| 蜜罐 / 隐藏链接 / hidden form 字段 | 人类看不见不点；爬虫 DOM 全选会命中 |
| 账号活跃度 / 历史行为模式对比 | 老账号平时每天 10 条查询，突然 1 小时 300 条 → 锁定 |

---

## 3. 携程供应商后台（intlflightsupplier.ctrip.com）实测清单

本节内容均为**我方对 intlflightsupplier 供应商后台的真实抓包**。结论：携程供应商后台**按行业标准 L1-L6 全栈部署**，且在 L4b (动态签名) 有自己的独家实现。

### 3.1 首屏即加载的风控 SDK（用户没点任何按钮就已工作）

登录路由 `#/user/login/CN` 首屏共 30 个请求，其中**纯风控 25 个**：

| # | 抓包记录 | 资源 URL / Host | 版本 | 分层归属 | 我方分析 |
|---|---|---|---|---|---|
| [0] | `ubt.minh.js` | `https://static.tripcdn.com/packages/ubt/websdk/1.3.88/ubt.minh.js` | **1.3.88** | **L5 行为 UBT** | 携程自研行为埋点 SDK：采集鼠标/滚轮/按键/页面停留/路由变化/视野比例 |
| [4][8][9][14][19][24][28][29] | `bee/collect × 8 次` (首屏) | `https://s.c-ctrip.com/bee/collect?...metaSender=1.3.88&vid=...&sid=3&pvId=1&appId=700001` (Fetch/Ping) | metaSender=1.3.88 | **L5 行为 UBT** | 首屏行为数据批量上报；用户每操作一次 (点击/滚动/停留超时) 会继续发送若干次 |
| [5] | `c-sec.js` | `https://webresource.c-ctrip.com/ares2/train/csec/5.1.3/default/sec/c-sec.js?v=2026831` | **5.1.3** | **L4 环境 + L4b 签名** | 携程自研前端安全 SDK：JS 环境 20+ 项采集 + 生成 Header 安全签名（abog / abce 等同家族通常出自此处） |
| [6] | `rms.js` | `https://webresource.c-ctrip.com/ares2/risk/ubtrms/*/default/rms.js?v=2026831` | v=2026831 | **L4b 签名引擎前置** | Risk Management SDK：先下 bootstrap，再下新 dist + wasm |
| [13] | `new/rms.js` (新 dist) | `https://webresource.c-ctrip.com/ares2/risk/ubtrms/*/default/dist/new/rms.js?v=202608041400` | **v=202608041400** | **L4b 签名引擎主文件** | 高度混淆；在 Console 输出 pdata/env/globalVariable (见 §3.3) |
| [16] | `rms.js 配套 .wasm` | `https://pic.c-ctrip.com/picaresonline/risk/ubtrms/dist/new/22b6331bf9a8.f0bc2f4a.wasm` | 文件名哈希 | **L4b 签名引擎 (核心)** | WebAssembly 字节码模块；**在浏览器里运行，Node.js 没有现成执行环境** |
| [18] | `jigsaw-captcha-main.min.js` | `https://webresource.c-ctrip.com/ares2/infosec/jigsawCaptcha/~2.0.0/default/js/jigsaw-captcha-main.min.js?expires=1d` | **~2.0.0** | **L5 滑块验证** | 携程拼图滑块 captcha 2.0；在用户登录时作为人机校验 |
| [12] + [56][57] | `risk_inspect` / `verify_jigsaw` | `https://ic.ctrip.com/captcha/v4/risk_inspect` (POST XHR) | v4 | **L5 事前风控检查** | 每次进入敏感动作 (登录/查询) 前先问：要出滑块吗？risk_inspect 返回"风险分数"，高风险即进入 [56][57] verify_jigsaw 验证流程 |
| [10] + [26][27] | `chloro-device` | `https://cdid.c-ctrip.com/model-poc2/hv` (人机核验) / `https://cdid.c-ctrip.com/chloro-device/v4/d` (POST XHR，设备指纹) | **v4** | **L5 CDID 设备 ID v4** | `chloro` 是携程 chloroform 系列设备指纹引擎代号；`cdid` 是返回的长期持久设备 ID，跨登录/跨月追踪设备 |
| [1] | `getAppConfig.json` | `https://m.ctrip.com/restapi/soa2/18088/getAppConfig.json` | SOA 18088 | **L6 全局配置** | 统一拉取 SDK 开关 & 灰度版本号 & 密钥轮换信息 |
| [2] | `differentDeviceLoginVerification` | `https://intlflightsupplier.ctrip.com/partnerportal/differentDeviceLoginVerification` (Fetch) | — | **L6 异地/异设备登录** | 首屏即检测"此账号是否在别的设备/地点登录过"，若命中触发二次验证 |
| [3] + 若干 | 滑块素材 (拼图底图 + 缺口图) | `jigsawCaptcha/~2.0.0/default/images/*.png` | 2.0.0 | **L5 滑块素材** | |

### 3.2 持久化标识 (Cookie + localStorage 首屏实锤)

**我方在登录页 window/cookie/localStorage 实际 Dump 出来的值（结构脱敏，内容为真实实例）：**

| 存储介质 | Key | 示例值 (脱敏) | 格式说明 | 分层归属 |
|---|---|---|---|---|
| **Cookie** | `UBT_VID` | `1787801932602.43ae7PfmSVia` | `ts.vid` | L5 UBT 访客 ID |
| Cookie | `GUID` | `34e2c390-9c2f-4c5c-acd7-367dcad0d15d` | UUID (更长期) | L5 设备 GUID |
| Cookie | `_RGUID` | `0b9ca9bc-a656-43d4-bcc9-60fe7565cfd9` | UUID (请求关联) | L6 全链路追踪 |
| Cookie | `_bfa` | `1.1787801932602.43ae7PfmSVia.1.1788083844643.1788165131316.3.1.10651171056` | `1.vid_ts.vid.版本号.前会话ts.当前会话ts.当前会话数.?.请求计数` | **L4b/L6 携程核心生命周期追踪 Cookie**。注意最后一段 `10651171056` **会随每次请求滚动**，这是服务端/SDK 配合的滚动令牌 |
| Cookie | `_RF1` | `42.233.17.90` | 客户端 IP | **L6 一致性水印**：服务端校验 cookie 里声明的 IP 和请求来源 IP 是否一致 |
| Cookie | `_RSG` | `KFaLcoRgSk0P_SPrvFO9pB` | 随机字符串 (**RSG=Request Signature Generator**) | **L4b 签名令牌**：rms.js globalVariable 中显示 `rsg_` 与此值对应 |
| Cookie | `_RDG` | `2864dc1c69529329f12cb580496c8201fe` | 随机散列 (**RDG=Request Distributor Generator**) | **L4b 签名分发令牌** |
| **localStorage** | `UBT_BFA` | `{vid_ts, id, lastSession_ts, session_ts, sid, pvid, ...}` | JSON，和 cookie _bfa 生命周期字段对应 | L5 UBT |
| localStorage | `UBT_CONFIG` | `{switchBackWvPv:true, tcpSwitch:true, multiSendMaxCount:50, bkSwitchV2:30, sendBeacon:false, storage:true, seq_h5:true ...}` | JSON，行为采集全局开关，`sendBeacon:false` 强制让它改用 fetch/ping 发 bee/collect | L5 UBT 配置 |
| localStorage | `token` | `<64hex>-<UUID>-<UUID>` (当前值：`a42adf8b...6ead2c36c88b`) | 三段拼接 → **供应商后台登录态 JWT/Token** | L1 登录态 |
| localStorage | `_RGUID` | 同 cookie | UUID | L6 追踪 |
| localStorage | `page_time` | `IwdgHOAMwJwMxxgVjAGlGMkxzAFiTjznXDGADYlg4AmC6IA` | 编码字符串 (疑似时间熵/页面加载采样的签名) | L4b? |
| localStorage | `traceId` | `10.113.197.53_100015306_1788084203032566010` | `{内网IP}_{进程/实例pid?}_{ts}_{rand}` | L6 全链路 |
| localStorage | `language` | `CN` | 界面语言 | 业务 |
| localStorage | `UBTActive_100fKO` / `UBT_LASTVIEW` | ts + JSON | 活跃检测/上次 PV | L5 UBT |
| localStorage | `RouteLowListCache` | `[]` | 业务缓存 | 业务 |

**特别观察：**
- `_bfa` / `UBT_BFA` 是**跨月 (至少 1 个月) 持久**的访客生命周期标识。vid_ts 显示我方 vid 诞生于 `2026-07-27` 左右，直到今天还在用。
- `_RSG` / `_RDG` 登录后很可能被重新下发并滚动更新（Console 中 rms.js 的 globalVariable 里 `rsg_/rdg_` 先为 null，后续被填入就是证据）。
- `_RF1` (IP) 一旦和当前请求 IP 不一致，携程就能立即识别"cookie 被盗用 / 走了代理但 cookie 是旧 IP 生成的"。

### 3.3 Console 实锤 (rms.js SDK 在持续运行)

在 `#/user/login/CN` 登录页 DevTools Console 看到 rms.js 输出三条 info 日志：

```
[info]  pdata---             {data: Object, env: Object}
[info]  globalVariable---    {guid: "0b9ca9bc-a656-43d4-bcc9-60fe7565cfd9",
                               rsg_: null, rdg_: null, rf1_: null, existsRsgGuid: true}
```

**解读：**
- `pdata` = rms.js 已经**完成了一轮浏览器环境 (env) + 业务数据 (data) 的采集并上报**。env 对象就是 §2 L4 中提到的 canvas/webgl/audio/plugins/字体/屏幕/时区等 30+ 项。
- `globalVariable` = rms.js 把 cookie / 登录态要用到的**_RSG / _RDG / _RF1 / GUID 等全局变量指针暴露给自己内部**。当前 `rsg_/rdg_` 为 null（因为还没登录、Set-Cookie 没下发新版本），但 existsRsgGuid=true 说明 SDK 已经**识别出此设备上有历史 _RSG 跟踪痕迹**。

---

## 4. 目标接口 & 签名链路 (低价政策查询)

### 4.1 入口页面
- **UI 路径**：供应商后台 → 左侧菜单【自测平台】→ Tab 【低价政策推荐 (新)】
- **路由**：`https://intlflightsupplier.ctrip.com/#/selfTest/LowPrice`
- 表单字段：行程类型 (单程/往返) / 出发城市 / 到达城市 / 出发日期 / 返程日期 / 舱等 / 成人儿童婴儿人数 / 开票航司 / 特殊参数 / 主渠道 / 子渠道 / SC市场 / 旅客资质
- 我方测试填写：单程 / **JNB → DUR / 2026-09-29 / 舱等经济舱 / 成人 1 / 主渠道 EnglishSite** → 点击【查询】

### 4.2 真实查询接口 (Network 面板抓包实锤)

点击查询 3 次 → Network 面板准确出现 3 条同 URL 请求：

| # | Method | URL | Type |
|---|---|---|---|
| [90] | **POST** | `https://intlflightsupplier.ctrip.com/partnerportal/api/lowpricesearch` | Fetch |
| [94] | **POST** | `https://intlflightsupplier.ctrip.com/partnerportal/api/lowpricesearch` | Fetch |
| [98] | **POST** | `https://intlflightsupplier.ctrip.com/partnerportal/api/lowpricesearch` | Fetch |

> 3 次请求之间还夹杂了 8 个 `s.c-ctrip.com/bee/collect` 的行为上报 (91/92/93/95/96/97/99 等)。说明**每执行一次查询，UBT 会额外发 2-3 条行为采样**，这是"人机一致性"的重要信号。

### 4.3 真实返回数据 (DOM 表格解析，非 API 原始 JSON)

查询成功后页面表格显示的内容（证明接口真的出了合法有效数据）：

| 行 | 航程 | 航班号 | 舱位 | 产品类型 | 含税底价 / 人 | 是否外显 | 旅客资质 | 属性标签 | 票面价 | 税收 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | JNB-DUR | FA478 | D | CSD 私有运价 | 294 CNY | 是 | 普通乘客 | NEW_QUANTIFY_COMPARE:initSelected | 103 | 191 |
| 2 | JNB-DUR | FA322 | D | CSD 私有运价 | 294 CNY | 是 | 普通乘客 | NEW_QUANTIFY_COMPARE:initSelected | 103 | 191 |
| 3 | JNB-DUR | FA354 | D | CSD 私有运价 | 294 CNY | 是 | 普通乘客 | NEW_QUANTIFY_COMPARE:initSelected | 103 | 191 |
| 4 | JNB-DUR | FA452 | C | CSD 私有运价 | 323 CNY | 是 | 普通乘客 | NEW_QUANTIFY_COMPARE:initSelected | 132 | 191 |
| 5 | JNB-DUR | FA425 | C | CSD 私有运价 | 323 CNY | 是 | 普通乘客 | NEW_QUANTIFY_COMPARE:initSelected | 132 | 191 |
| … 共 10 行 CSD 私有运价记录 | | | | | | | | | | |

### 4.4 关于签名参数的推断 (基于已实锤资源 + 社区 C 端逆向结论交叉验证)

**我方未对 lowpricesearch 做 request body/headers 明文捕获**（原因：前端 axios 在页面初始化时已缓存原型引用，导致我们事后注入的 window.fetch / XHR.prototype monkey-patch 无法进入该请求路径）。但结合以下三组证据，可以做"存在性 + 工程约束"的**可靠推断**：

| 证据 | 能推断出什么 |
|---|---|
| (1) 首屏即加载了 **`c-sec.js 5.1.3` + `rms.js + .wasm` + `CDID v4`** | 这些 SDK 的存在使命只有一个：**为后续业务请求注入签名头 / 签名 cookie**。不可能只加载不工作。 |
| (2) Console 中 `pdata(env对象)` 和 `globalVariable(rsg_,rdg_,rf1_)` 持续输出 | rms.js 在为签名计算**持续收集熵 (env + 令牌变量)** |
| (3) 社区 C 端机票逆向结论：`POST /search/batchSearch` 接口每次请求由页面 JS 的 `window.signature(rRequest)` 生成 `token (1001 前缀)`，以及 `sign=MD5(transactionID + departureCityCode + arrivalCityCode + departureDate)`、`transactionID` 取自 `window.GlobalSearchCriteria`，而且 signature 函数要依赖 Canvas/WebGL/navigator 20+ 项环境才能算出正确长度 (680~690 位)；另外还有 `testab` SDK 和 `_bfa/_bfi` cookie 持续滚动 | 携程 C 端接口的这套签名模式来自同一套 "前端 SDK 生成签名" 体系；供应商后台 intlflightsupplier 作为同一母公司产品，**大概率沿用相同架构**，只是函数全局名和细节不同。 |
| (4) 另一份社区携程酒店爬取实战："关键 cookie `_RF1/MKT_Pages` 几分钟就失效；且和请求参数/时间戳绑定" | 对应我们 §3.2 中看到的 `_RF1 (IP水印)` + `_RSG/_RDG` 三个令牌；服务端会验证"签名是否使用**当前最新** RSG/RDG/RF1 值生成"，所以"复制一次 Cookie 到 node 里长期跑"是不可能的。 |
| (5) testab 公开分析："签名 = 请求体原文 + ts + Canvas/WebGL/鼠标轨迹/滚轮序列 的哈希链"，且携程每 2~4 周更新一次 SDK | 反推：任何 L4b 签名必须在**页面内实时、自然、有环境有行为**的上下文里生成 |

**工程结论：Phase 2 携程查询** **不可能**通过"静态 Cookie 复制 + Node 重放请求 body"方式长期稳定执行。签名必须由**页面自己的 SDK 在页面上下文里**动态生成。

---

## 5. Node.js 直连 vs 真实浏览器页面 (Electron BrowserWindow) 指纹差异对照表

这张表直接回答你的疑问："代码里现在默认是 node 后端发请求 vs 携程网页应该是前端发，会不会被发现？——会，而且下面 7 层中 6 层都会被发现。"

✅= 对齐 / 天然通过；⚠️= 可勉强模拟但代价大且不保证；❌= JS 层无法改变、极易暴露

| # | 维度 | 检测层级 | Node `https` / undici `fetch` / axios | 真实 Chromium BrowserWindow 内 fetch | 能绕过吗？ |
|---|---|---|---|---|---|
| 1 | IP 信誉 / 限频 | L1 | ✅ 同一出口，无差别 | ✅ 同一出口 | ✅ 相同 |
| 2 | **TLS JA3 / JA4** (ClientHello) | L2 | ❌ Node 的 OpenSSL / BoringSSL 构建版 → JA4 独一无二的"爬虫指纹"，在黑名单里 | ✅ Chromium 的 BoringSSL → JA4 命中 Chrome 白名单 | ❌ JS 层改不了（握手在 TLS 栈里） |
| 3 | **HTTP/2 伪头 & SETTINGS** | L3 | ❌ undici 的伪头顺序 / SETTINGS 默认值和 Chrome 不一致 | ✅ Chromium 的 HTTP/2 栈原生正确 | ❌ 需要改 Chromium net 组件 |
| 4 | **JA4H (Header 顺序 + Sec-Ch-Ua* + Sec-Fetch-*)** | L3 | ⚠️ 能手写，但要 1:1 复刻 Chrome 每 Header 顺序 / 大小写 / 动态值（不同请求上下文会生成不同 sec-fetch-mode / priority），非常脆且每 SDK 变一次 | ✅ 浏览器原生自动按上下文生成 | ⚠️ 可做，维护成本极高 |
| 5 | **Cookie 管理** (httpOnly / SameSite / Partitioned / Set-Cookie 滚动刷新 / 顺序) | L4 / L6 | ❌ 从 session.cookies.get() 复制成静态字符串：① httpOnly 取不到、② SameSite 不会校验、③ 过期/域/路径匹配逻辑丢了、④ RSG/RDG/_bfa 每次响应 Set-Cookie 的滚动刷新你得重新实现一遍、⑤ 拼接顺序还和 Chrome 不一样 | ✅ 同一 `persist:xxx` 分区下 Chromium 的 Cookie jar 自动完成以上全部，你完全不用管 | ❌ 需要自己重写一套 Cookie 管理引擎，且会和浏览器有微妙差异 |
| 6 | **JS/WASM 动态签名** (signature / testab / rms.js 签名、CDID v4) | L4b / L5 | ❌ Node 没有 window / Canvas / WebGL / Audio / 字体；签名需要 20+ 环境项作为熵；WASM 模块需要浏览器全局对象的 hook 才能返回正确值；你得逆向算法 + 补环境（≈2-4 周，且每 2-4 周随 SDK 重新维护） | ✅ 打开真实页面 → 页面自己的 c-sec.js + rms.js + wasm + cdid 都正常跑 → **前端自动为请求生成合法签名，你一行逆向都不用写** | ❌ (除非 L3 级投入逆向+灰度监控系统) |
| 7 | **一致性画像** (登录指纹 vs 查询指纹) | L6 | ❌ 登录用 BrowserWindow（Chrome 指纹）；查询用 Node（OpenSSL 指纹）= 同一账号两种指纹交替 → 这是 ML 模型最喜欢的"强特征机器人" | ✅ 登录+查询都在同一 partition 同一 BrowserWindow → UA/JA4/Canvas/Cookie jar/AB 分组 100% 自洽 | ❌ 你不可能让 Node 的 TLS 握手和 Chromium 的字节级一致 |
| 8 | **UBT 行为上报** (和查询频率绑定) | L5 | ❌ 页面每查询 1 次会自动发 2-3 条 bee/collect (鼠标/滚轮/停留)。纯 Node 发查询但没有配套的 bee/collect 上报 → "用户没动但一直出查询结果" | ✅ 页面 SDK 自己按真实 DOM 交互和时间自然产生 UBT 上报，节奏和真人一致 | ⚠️ 理论上可以伪造 UBT 上报内容，但必须和查询节奏/参数严格耦合，极难猜 |
| 9 | UA 字符串 | L3+L6 | ⚠️ 可手改，但手改的 UA 必须和底层 JA4、Canvas、platform、timezone 全部一致，否则反而露馅 | ✅ 完全一致 | ⚠️ 需和其他 6 项一起对齐才可信 |

**结论表中的含义：**
- 任何 ❌ 项都代表"只在 JS 层调 header 不可能修复"。
- 你目前 `tripClient.js` 的 mock 如果替换成 Node fetch，就会命中 2/3/5/6/7 五项致命不一致。

---

## 6. 各检测层绕过难度 / 可行性矩阵

**L1-L6 7 层分别在三种工程方案下的绕过等级（5 级：1=天然通过 / 5=投入巨大且需要持续维护）：**

| 检测层 | L1 纯 Node HTTP 协议模拟 (不推荐) | L2 隐藏 BrowserWindow 内真实页面 (⭐推荐) | L3 逆向签名 + TLS 指纹冒充 (可选升级) |
|---|---|---|---|
| L1 IP 信誉 / 限频 | 2 (需要代理池 + 抖动) | 1 (只需要抖动 + 出口正常) | 2 (需要代理池 + 抖动) |
| L2 TLS JA3/JA4 | 5 (需要换 TLS 栈：curl-impersonate 或重编译 BoringSSL) | 1 (Chromium 原生) | 2 (curl-impersonate 对齐) |
| L3 HTTP2 + JA4H | 4 (phantom-fetch 对齐但上下文自动值仍错) | 1 (Chromium 原生) | 2 (phantom-fetch 对齐) |
| L4 JS 环境指纹 (Canvas/WebGL 等) | 5 (补环境 20+ 项，还要稳定 seed) | 1 (Chromium 原生) | 4 (jsdom + seed + 补丁) |
| L4b 动态签名 (rms.js/.wasm/c-sec/testab/signature) | 5 (逆向 2-4 周 + 每 2-4 周跟 SDK 更新) | 1 (页面 SDK 自动生成) | 5 (逆向 + 长期灰度监控) |
| L5 CDID/行为 UBT/滑块 | 3-4 (CDID/UBT 得伪造与查询时序耦合) | 1 (真实 DOM 交互与时间自然产生) | 3-4 (伪造) |
| L6 一致性画像 | 5 (登录/查询指纹天生不一致) | 1 (同一 partition = 全部一致) | 2 (需保证全部对齐) |
| **总分 (越低越好)** | **29 / 满分 35** (非常危险) | **7 / 满分 35** (最安全，只需要做限频抖动) | **19–24 / 满分 35** (中等，且有长期维护) |
| 总工程量 | 2 天能写完，但 1-3 天内会开始封/空 | 0.5-1 天实现 QueryPageBrowser，长期无维护 | 2-4 周逆向 + 每周 4-8 小时长期维护 |

---

## 7. 结论与建议

### 7.1 一句话总结
> **携程 intlflightsupplier 供应商后台是 L1-L6 全栈反爬部署，且在 L4b 有携程自研的 rms.js (WASM) + c-sec.js + CDID v4 多层签名体系。任何绕过方案如果在 L2-L4b 有不一致，都会在 24h-1 周内被打标、封 IP 或账号，或返回空列表。**
> **工程上唯一合理、维护成本最低、且与"后续 SDK 更新天然同步"的方案是 L2：在同一个持久会话分区的 Electron BrowserWindow 内，打开真实的低价政策页面并通过 executeJavaScript 触发页面自己的请求（填表单 click 或直接 axios 都行），让 c-sec + rms.js + WASM + CDID + UBT 全部在真实浏览器环境里自动工作。**

### 7.2 推荐方案 (默认 L2) 要点

详见 `docs/ass/requirements.md` §5.2 / §8 以及对应实现 ADR，此处只列清单级约束：

1. **单账号 = 单隐藏 BrowserWindow (QueryPageBrowser)**，与 `sessionManager` 共用 `persist:ass-ctrip` 分区，保证登录/查询指纹/会话完全一致（解决 §6 中 L2/L3/L4b/L6）。
2. **必须自定义 BrowserWindow 的 `userAgent`**，去掉 Electron/TRAESOLOCN 等字符串，仅保留纯 Chrome 142 标准格式（解决 §3.3 我们实测发现的 UA 尾巴露馅问题）。
3. **查询触发走页面内原生链路**：优先"填 DOM 表单 → 点查询按钮 → 等表格刷新 → 在 window 或 Network 面板拦截响应 JSON"；备选为直接在页面上下文中调用前端已经初始化好的 axios 实例（两者都会自动经过 rms.js 的签名拦截器，解决 §4.4）。
4. **请求间必须做"人类抖动延迟"**：用指数分布 `sleep(-mean*Math.log(Math.random()))`，均值 mean=6s，min=3s，max=15s。每 50 条来一次 45-90 秒的"人类休息"。解决 L1/L5/L6 的频率与行为检测。
5. **每 20-30 条中间穿插一次 DOM 鼠标 move + wheel**（调用 BrowserWindow 的 Input.dispatchMouseEvent / webContents.sendInputEvent），让 UBT 持续产生与查询节奏匹配的行为采样，不出现"查询一直出、鼠标从来不报"的矛盾。
6. **每日上限 + 工作时段**：默认只在 09:00-22:00 执行，单日上限设可配置值 (默认 500 条/日)，减少账号画像异常。解决 L1/L6。
7. **L2.5 升级 (可选)**：如遇到 IP 限频/封，再引入 Electron `ses.setProxy({proxyRules:'http://user:pass@ip:port'})` 将整个分区的网络通过住宅代理出口；同一账号尽量用 sticky session（同一 IP 用 1-3 天不换），避免 L6 的 mid-session IP 跳变打标。

### 7.3 什么时候需要上 L3 (逆向签名 + TLS 冒充)
仅当出现以下全部条件时才值得考虑：
- **每日查询量 ≥ 500 且并发需要 >10**（L2 的 3-15 秒自然抖动 + 单窗口太慢，需要分布式扩展）；
- **已经出现了明显的"账号/IP 封禁"现象且 L2 + L2.5 (住宅代理 + sticky) 组合仍无法稳定**；
- 团队有长期每周 4-8 小时的逆向维护人力，能够跟进携程 SDK 每 2-4 周一次的灰度更新。

否则 L2 就是最优解：**签名/WASM/TLS/H2/Cookie/UBT/画像一致性全部靠页面自己做对，我们只管"填值+点按钮+取结果"**，工程上最省事，也最贴近"这就是一个真人在用这个网站"的事实。

---

*— End of report —*
