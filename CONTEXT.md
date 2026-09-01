# Project Context (WorkTools-release)

本仓库是一个面向航旅从业者的桌面工具集（Electron + Vue3），以「功能模块（feature）」为单位组织，每个模块通过 manifest.js + routes.js 独立注册并挂载到 Shell 中。

***

## 模块（Feature）

| 模块代码 | 中文名称     | 主要职责                              |
| ---- | -------- | --------------------------------- |
| ass  | 航线搜索模拟模块 | 模拟用户在 OTA 网站上逐航线+逐日期进行低价政策查询的完整流程 |
| pcp  | 底价政策对比模块 | 多平台底价抓取、公式化比价、结果导出                |
| erc  | 汇率换算模块   | 多币种汇率管理与换算                        |

> 本文档只定义共享术语。各模块专属术语在其各自 `docs/<module>/` 目录下维护。

***

## 共享领域词汇

### OTA (Online Travel Agency)

在线旅游代理商，本文档中专指「携程」。

### 锦绣国际 (JX/GJ / Jinxiu International)

一个机票供应商数据网站，在 ass 模块中被用作 **航班存在性预检** 的数据源。

### 机场代码

IATA 三字码（如 JNB、GUR、HLA、CPT），大小写不敏感，内部统一大写。

### 航线 / Airport Pair

由 (出发机场代码, 到达机场代码) 组成的二元组，从 Excel 文件读取。

### 查询参数 / QueryParam

一次网络请求的最小完整单元，结构如下：

```
{ dep, arr, airline?, date }
```

* `dep` / `arr`：出发/到达机场三字码

* `airline`：可选，界面上用户统一填写，若填则所有航线共用

* `date`：单一天的日期（YYYY-MM-DD）

### 航班标记 / hasFlight

Phase 1 预检结果，挂在查询参数上的三态标记（修正自「布尔」→ 含 UNKNOWN）：

* **true  有航班**：锦绣接口返回 Msg==OK 且 Content 非空

* **false 无航班**：锦绣接口返回 Msg==OK 但 Content 为空

* **null  UNKNOWN**：请求或业务异常（§8.3 按「有航班」保守放行进入 Phase 2）

### 用户行为模拟 / Browser Simulation

指用 Puppeteer / Electron `BrowserWindow` 等手段真实打开网页、操作 DOM、模拟点击/输入/等待等过程，以绕过接口风控或满足登录态要求。ass 模块中仅对 **携程登录** 和 **携程查询** 两处启用模拟行为，其余部分均为普通程序逻辑。

***

## 关键决策记录

决策归档位置：`docs/adr/`

| 编号    | 标题                                                                                   | 状态  |
| ----- | ------------------------------------------------------------------------------------ | --- |
| ADR-1 | \[ass] 使用两阶段查询：锦绣预检 → 携程正式查询                                                         | 已采纳 |
| ADR-2 | \[ass] 两阶段各使用独立的数据处理函数与独立输出文件                                                        | 已采纳 |
| ADR-3 | \[ass] 执行顺序按天串行（Day-1 全部完成再 Day-2）                                                   | 已采纳 |
| ADR-4 | \[ass] Phase 1 锦绣请求抄 PCP/jxgj HTTP 标准，ass 与 pcp 两模块严格解耦（仅复制源码，禁止跨 feature import/调用） | 已采纳 |
| ADR-5 | \[ass] Phase 2 携程查询正式落地 L2 方案：**可见 BrowserWindow + persist:ass-ctrip 共享 partition + DOM .value/.click() 填单 + CDP 抓响应 + 泊松抖动**，窗口默认可见供用户真实晃鼠标产生 isTrusted=true UBT 样本，任务运行中误关窗口改为 hide 保持 partition 和 CDID 稳定 | 已采纳 |

