# PCP 功能块审查报告

> 审查日期：2026-08-26
> 审查范围：`electron/features/pcp/` 全部 18 个 JS 文件 + `electron/main.js` PCP 装配部分
> 审查维度：Bug 排查 + 架构设计审查

---

## 目录

- [1. 概述](#1-概述)
- [2. Bug 排查](#2-bug-排查)
  - [2.1 高严重度](#21-高严重度)
  - [2.2 中严重度](#22-中严重度)
  - [2.3 低严重度](#23-低严重度)
- [3. 架构设计审查](#3-架构设计审查)
  - [3.1 模块职责](#31-模块职责)
  - [3.2 接口设计](#32-接口设计)
  - [3.3 耦合度](#33-耦合度)
  - [3.4 抽象层次](#34-抽象层次)
  - [3.5 可维护性](#35-可维护性)
  - [3.6 扩展性](#36-扩展性)
  - [3.7 数据模型](#37-数据模型)
- [4. 改进建议](#4-改进建议)
- [5. 优先级矩阵](#5-优先级矩阵)

---

## 1. 概述

### 1.1 文件清单

```
electron/features/pcp/
├── fileManager.js          # 数据管理（a1/a2/a3 持久化 + Excel 解析 + 导出）
├── pipeline.js             # 步骤流编排器（阶段状态机）
├── controller.js           # IPC handlers 注册器
├── taskManager.js          # 任务队列管理
├── taskScheduler.js        # 任务调度器（并发 worker）
├── platformRunner.js       # 平台任务执行器
├── configManager.js        # 平台配置管理
├── credentialManager.js    # 账号凭证管理
└── platforms/
    ├── registry.js         # 平台注册中心
    ├── jxgj/               # 锦绣国际（数据源平台）
    │   ├── adapter.js
    │   ├── config.js
    │   └── formula.js      # 底价公式编译（mathjs BigNumber）
    ├── trip/               # 携程（O 平台）
    │   ├── adapter.js
    │   └── config.js
    ├── o2/                 # O2 平台（占位）
    │   ├── adapter.js
    │   └── config.js
    └── o3/                 # O3 平台（占位）
        ├── adapter.js
        └── config.js
```

### 1.2 数据流概览

```
用户选 Excel
    │
    ▼
[a1] parseXlsx → 解析行（hangsi, CF_jichang, DD_jichang, cangwei_str, date_list）
    │
    ▼ jxgj 阶段：prepareRequest → request → mergeResult
[a2] a1 + jxgj 增强（date_obj, cangwei_arr, C成人总票价, dijia）
    │
    ▼ o_combo 阶段：按 date_obj 拆分 → trip/o2/o3 请求 → priceComparisonPolicy
[a3] trip processedData + HR_FIELDS（_platform, C出发机场, D到达机场...）
    │
    ▼ exportResult + buildHumanReadableFile
导出两个文件：
    - {平台}导入政策{日期}.xlsx   （系统导入，按 exportTemplate 列序）
    - {平台}底价检查{日期}.xlsx   （人看，合并所有 O 平台）
```

---

## 2. Bug 排查

### 2.1 高严重度

#### BUG-1：controller 和 pipeline 的 addBatchByStage 任务 type 不一致

- **文件**：[controller.js:73-108](file:///d:/WorkTools-release/electron/features/pcp/controller.js#L73-L108) vs [pipeline.js:492-509](file:///d:/WorkTools-release/electron/features/pcp/pipeline.js#L492-L509)
- **问题**：同一个"o_combo 阶段添加任务"逻辑存在两份实现，且任务 type 不同：
  - controller 版：`type: 'o_combo'`（不拆分平台，下游 executeOComboTask 内部分发）
  - pipeline 版：`type: p`（拆分成 trip/o2/o3 独立任务，type 是具体平台名）
- **影响**：
  - 如果前端调 `pcp:task:addBatchByStage` IPC（绕过 pipeline），生成的任务 type='o_combo'
  - 如果前端调 `pcp:pipeline:start`（走 pipeline），生成的任务 type='trip'/'o2'/'o3'
  - 下游 platformRunner/taskScheduler 对 type 的处理可能不同，导致行为不一致
- **触发条件**：前端混用两个入口
- **建议**：删除 controller.js 的 `pcp:task:addBatchByStage` handler（让 pipeline 成唯一入口），或让两者调同一份内部实现

#### BUG-2：trip mergeResult 不检查 replyStatus，错误被吞

- **文件**：[trip/adapter.js](file:///d:/WorkTools-release/electron/features/pcp/platforms/trip/adapter.js) mergeResult 函数
- **问题**：只检查 `ResponseStatus.Ack === 'Success'`，不检查 `responseHeader.replyStatus`
  - 携程密码错误时，HTTP 200 + Ack='Success'，但 replyStatus 含错误信息
  - mergeResult 把错误响应当成功处理 → processedData 为空 → task 标 completed → 148 个"成功"任务 processed=0
- **影响**：用户看到任务全"成功"但输出 0 条数据，无法定位根因
- **建议**：mergeResult 增加对 replyStatus 的校验，replyStatus 不为 Success 时 throw Error

#### BUG-3：handleStageComplete 是 async，但 onAllComplete 回调可能不 await

- **文件**：[pipeline.js:76](file:///d:/WorkTools-release/electron/features/pcp/pipeline.js#L76)
- **代码**：
  ```js
  this.taskManager.scheduler.onAllComplete = (results, stage) => this.handleStageComplete(results, stage)
  ```
- **问题**：`handleStageComplete` 是 async 函数（内部有 `await new Promise(setTimeout)` 和 `await this.runStage('o_combo')`），但 onAllComplete 回调不 await
  - 如果 taskScheduler 调 onAllComplete 后立即继续，handleStageComplete 的 async 逻辑变成 fire-and-forget
  - auto 模式下 jxgj→o_combo 的衔接可能不按预期时序执行
- **影响**：auto 模式下阶段衔接可能出现时序问题，状态不一致
- **建议**：确认 taskScheduler 是否 await onAllComplete；如果不 await，handleStageComplete 改为同步或用 promise chain

#### BUG-4：a2 缺 date_obj 时 o_combo 任务静默 0 结果

- **文件**：[pipeline.js:497-502](file:///d:/WorkTools-release/electron/features/pcp/pipeline.js#L497-L502)
- **问题**：a2 item 没有 date_obj 时，任务 `dateValue: null`，下游 trip priceComparisonPolicy 用 `dateValue` 做 forData → forData=null → 无循环 → 0 结果，但不报错
- **触发条件**：jxgj 返回的航班没有 C出发日期，或 cangwei_arr 为空
- **影响**：静默 0 结果，用户无法察觉数据缺失
- **建议**：dateValue=null 时 warn 日志或跳过该任务（标 failed）

### 2.2 中严重度

#### BUG-5：trip 匹配用 String() 比较，undefined 误匹配

- **文件**：[trip/adapter.js](file:///d:/WorkTools-release/electron/features/pcp/platforms/trip/adapter.js) priceComparisonPolicy
- **问题**：`String(f.departAirport) === String(item.C出发机场)`
  - 如果两者都 undefined（字段缺失），`String(undefined)="undefined" === "undefined"` → 误匹配
  - 可能匹配到错误航班
- **建议**：先判 null/undefined，或用 `===` 严格比较

#### BUG-6：限流器 cooldown 后不重新检查滑动窗口

- **文件**：[trip/adapter.js](file:///d:/WorkTools-release/electron/features/pcp/platforms/trip/adapter.js) createRateLimiter
- **问题**：cooldown 结束后 acquire 直接返回，不检查滑动窗口是否已满
  - 如果 cooldown 期间窗口没滑过（请求量不大），cooldown 结束立即发请求可能再次触发 429
- **建议**：cooldown 结束后仍需走滑动窗口检查

#### BUG-7：pipelineState.json 只存 mode，不存 stages

- **文件**：[pipeline.js:101-117](file:///d:/WorkTools-release/electron/features/pcp/pipeline.js#L101-L117)
- **问题**：重启后 stages 重置为 idle，但 a1/a2/a3 数据仍在
  - 用户重启 app 后看到数据在，但阶段状态丢失，无法继续流程
  - 必须重新选文件从头跑
- **影响**：重启后无法恢复流程状态
- **建议**：pipelineState.json 同时存 stages（或至少存已完成的阶段）

#### BUG-8：controller addBatchByStage 绕过 pipeline 状态管理

- **文件**：[controller.js:44-116](file:///d:/WorkTools-release/electron/features/pcp/controller.js#L44-L116)
- **问题**：controller 的 `pcp:task:addBatchByStage` 不调 pipeline 的状态管理逻辑
  - o_combo 阶段不会标 running/skipped（pipeline 版有 L470-487 的状态标记）
  - 如果用户通过这个 IPC 入队，导出门控 canExport 会失败（阶段状态不对）
- **建议**：让 controller 的 addBatchByStage 委托给 pipeline._invokeAddBatchByStage

### 2.3 低严重度

#### BUG-9：字段名硬编码易拼写错误

- **涉及**：全模块
- **问题**：C出发机场、D到达机场、H航班号、CF_jichang 等字段名以字符串散落各处，无类型约束
  - 拼写错误不会报错，静默失败
- **建议**：抽取为常量或 JSDoc typedef

#### BUG-10：jxgj prepareRequest 参数方向（已修复）

- **状态**：✅ 已修复（2026-08-26）
- **历史**：arrAirPort/depAirPort 赋值反了，导致请求反方向航班
- **记录目的**：提醒类似 API 参数语义需文档化

---

## 3. 架构设计审查

### 3.1 模块职责

#### fileManager 职责过多（God Object 倾向）

- **文件**：[fileManager.js](file:///d:/WorkTools-release/electron/features/pcp/fileManager.js)（~700 行）
- **承担的职责**：
  1. Excel 解析（parseXlsx）
  2. 数据持久化（a1/a2/a3 load/save/clear）
  3. 数据合并（saveA2FromJxgjTasks, saveA3FromOTasks）
  4. 系统导入文件导出（exportResult）
  5. 底价检查文件生成（buildHumanReadableFile）
  6. 文件路径管理（getUniqueFilePath, _pathWithSeq, _uniqueSeqForAll）
  7. 下载目录管理（downloadDir, lastDirectory）
- **评估**：7 个职责堆在一个类里，修改导出逻辑可能影响数据持久化
- **建议**：拆分为 4 个模块：
  ```
  ExcelParser     # parseXlsx + buildHumanReadableFile
  DataStore       # a1/a2/a3 持久化 + saveA2/saveA3 合并
  Exporter        # exportResult + 路径管理
  UserDirManager  # downloadDir + lastDirectory
  ```

#### pipeline 职责清晰 ✅

- 只管阶段状态机 + 门禁 + 阶段衔接，不碰数据内部结构

#### controller 职责清晰但有重复 ⚠️

- IPC 分发职责清晰
- 但 addBatchByStage 和 pipeline 重复（见 BUG-1）

### 3.2 接口设计

#### 平台 adapter 接口基本合理 ✅

```js
// 统一接口（4 个方法）：
{
  prepareRequest(a1Item / a2Item, cred, cfg)  → { url, headers, ... }
  request(prepared)                           → rawResponse
  mergeResult(rawResponse, a1Item/a2Item)     → { data: { inputData, processedData } }
  exportTemplate                              → { columns: [{key, title}] }
}
```

#### mergeResult 签名不统一 ⚠️

- **jxgj**：`mergeResult(rawResponse, a1Item, compiledConfig)` → 直接修改 a1Item，挂上 cangwei_arr/date_obj
- **trip**：`mergeResult(rawResponse, a2Item, ...)` → 返回 processedData，不改 a2Item
- **问题**：jxgj 的 mergeResult 有副作用（改输入参数），trip 没有
- **建议**：统一为无副作用——mergeResult 返回新数据，由 fileManager 合并到 a1/a2

### 3.3 耦合度

#### pipeline 和 fileManager 耦合过紧 ⚠️

- **文件**：[pipeline.js:458-459](file:///d:/WorkTools-release/electron/features/pcp/pipeline.js#L458-L459)
- pipeline 直接调 `fileManager.getA1().data` / `getA2().data`，知道 a1/a2 的内部结构（`.data` 数组、`.date_obj`）
- **建议**：fileManager 提供 `getA1Data()` / `getA2Data()` 接口，pipeline 不直接访问 `.data`

#### 字段名跨模块硬编码 ⚠️

- `C出发机场`、`H航班号`、`date_obj`、`cangwei_arr` 等字段名在 jxgj/adapter、trip/adapter、fileManager 三处都用
- 改一个字段名要改三处，容易漏
- **建议**：抽取 `fieldNames.js` 常量文件，或用 JSDoc typedef 约束

### 3.4 抽象层次

#### a1/a2/a3 无显式类型定义 ⚠️

- a1/a2/a3 的字段散落在 parseXlsx、mergeResult、exportTemplate、priceComparisonPolicy 各处
- 维护者要追多个文件才能理解 a1/a2/a3 的 shape
- **建议**：增加 JSDoc typedef：
  ```js
  /**
   * @typedef {Object} A1Item
   * @property {string} hangsi - 航司二字码
   * @property {string} CF_jichang - 出发机场三字码
   * @property {string} DD_jichang - 到达机场三字码
   * @property {string} cangwei_str - 舱位序列
   * ...
   */
  ```

#### 硬编码平台列表 ['trip','o2','o3'] ⚠️

- pipeline.js、controller.js、fileManager.js 都硬编码 `['trip','o2','o3']`
- 新增 O 平台要改三处
- **建议**：从 registry 动态获取 O 平台列表，或定义 `O_PLATFORMS` 常量

#### O2/O3 占位合理 ✅

- registry 注册了 o2/o3，adapter/config 存在
- 扩展点清晰，未实现的平台不影响流程

### 3.5 可维护性

#### 命名不一致 ⚠️

| 层级 | 风格 | 示例 |
|------|------|------|
| a1 字段 | 拼音缩写 | `CF_jichang`, `DD_jichang`, `hangsi` |
| a2/a3 字段 | 中文前缀 | `C出发机场`, `D到达机场`, `H航班号` |
| 变量 | 英文 | `depAirPort`, `arrAirPort`, `dateKey` |
| 方法 | 英文驼峰 | `prepareRequest`, `mergeResult` |

- 中英混合 + 拼音 + 中文前缀，新人理解成本高
- **建议**：逐步统一为英文，或至少同层一致

#### 注释质量好 ✅

- 每个文件有头部注释说明职责
- 关键逻辑有行内注释（如门控、阶段衔接、字段映射）
- 数据流注释清晰（a1→a2→a3 箭头图）

#### 魔法字符串多 ⚠️

- 平台 key `'trip'`/`'o2'`/`'o3'`/`'jxgj'` 散落各处
- 阶段 key `'upload'`/`'jxgj'`/`'o_combo'` 硬编码
- 状态值 `'idle'`/`'running'`/`'completed'` 未抽常量
- **建议**：抽取 `constants.js`

### 3.6 扩展性

#### 新增平台流程清晰 ✅

```
1. platforms/newP/adapter.js（实现 4 方法）
2. platforms/newP/config.js（定义配置 schema）
3. platforms/registry.js（注册）
```

#### priceComparisonPolicy 逻辑可能重复 ⚠️

- trip 的比价逻辑（匹配航班 + 算 XC_dijia + CUT_VALUE + 过滤）在 trip/adapter.js 内
- 如果 o2/o3 需要类似比价，逻辑会重复
- **建议**：如果 O 平台比价逻辑趋同，抽取 `comparePrice` 共享函数

### 3.7 数据模型

#### a1/a2/a3 三阶段隐式 ⚠️

| 阶段 | 来源 | 主要字段 | 类型定义 |
|------|------|---------|---------|
| a1 | parseXlsx | hangsi, CF_jichang, DD_jichang, cangwei_str, date_list | 无 |
| a2 | a1 + jxgj mergeResult | date_obj, cangwei_arr, C成人总票价, dijia | 无 |
| a3 | trip processedData + HR_FIELDS | _platform, C出发机场, D到达机场, XC_dijia... | 无 |

- 三阶段数据无显式类型定义，字段散落
- **建议**：JSDoc typedef 或 TypeScript interface

---

## 4. 改进建议

### 优先级 P0（建议立即修）

1. **BUG-2**：trip mergeResult 增加 replyStatus 校验
   - 防止错误被吞，用户看到 0 结果无法定位

2. **BUG-1**：统一 addBatchByStage 入口
   - 删除 controller 的实现，委托给 pipeline
   - 或让两者共享同一内部函数

3. **BUG-3**：确认 taskScheduler 是否 await onAllComplete
   - 如不 await，改 handleStageComplete 为同步或 promise chain

### 优先级 P1（建议近期修）

4. **BUG-4**：a2 缺 date_obj 时 warn 或标 failed
5. **BUG-5**：trip 匹配增加 null/undefined 检查
6. **BUG-6**：限流器 cooldown 后重新检查窗口
7. **BUG-7**：pipelineState.json 存 stages

### 优先级 P2（架构优化）

8. **拆分 fileManager**：ExcelParser + DataStore + Exporter + UserDirManager
9. **统一 mergeResult 签名**：无副作用，返回新数据
10. **抽取常量**：fieldNames.js + constants.js（平台 key、阶段 key、状态值）
11. **JSDoc typedef**：定义 A1Item/A2Item/A3Item shape
12. **动态平台列表**：从 registry 获取，不硬编码

### 优先级 P3（长期改善）

13. **统一命名风格**：逐步统一字段名（英文或中文，不混用）
14. **共享比价逻辑**：如果 O 平台比价趋同，抽取 comparePrice

---

## 5. 优先级矩阵

| 编号 | 问题 | 严重度 | 优先级 | 改动量 | 影响范围 |
|------|------|--------|--------|--------|---------|
| BUG-1 | addBatchByStage 两份实现且 type 不一致 | 高 | P0 | 小 | controller + pipeline |
| BUG-2 | mergeResult 不检查 replyStatus | 高 | P0 | 小 | trip/adapter |
| BUG-3 | onAllComplete 不 await async | 高 | P0 | 小 | pipeline + taskScheduler |
| BUG-4 | a2 缺 date_obj 静默 0 结果 | 高 | P1 | 小 | pipeline |
| BUG-5 | String() 误匹配 undefined | 中 | P1 | 小 | trip/adapter |
| BUG-6 | 限流器 cooldown 后不检查窗口 | 中 | P1 | 小 | trip/adapter |
| BUG-7 | pipelineState 不存 stages | 中 | P1 | 中 | pipeline |
| BUG-8 | controller 绕过 pipeline 状态 | 中 | P1 | 小 | controller |
| BUG-9 | 字段名硬编码易拼写错误 | 低 | P2 | 大 | 全模块 |
| BUG-10 | jxgj 参数方向（已修复） | - | - | - | - |
| ARCH-1 | fileManager God Object | 高 | P2 | 大 | fileManager |
| ARCH-2 | mergeResult 签名不统一 | 中 | P2 | 中 | jxgj + trip adapter |
| ARCH-3 | 字段名跨模块硬编码 | 中 | P2 | 中 | 全模块 |
| ARCH-4 | a1/a2/a3 无类型定义 | 中 | P2 | 中 | 全模块 |
| ARCH-5 | 硬编码平台列表 | 低 | P2 | 小 | pipeline + controller + fileManager |
| ARCH-6 | 命名不一致 | 低 | P3 | 大 | 全模块 |
| ARCH-7 | priceComparisonPolicy 可能重复 | 低 | P3 | 中 | trip + o2/o3 |

---

> **总结**：PCP 功能块流程清晰、注释到位、扩展点设计合理。主要风险集中在：
> 1. **controller 和 pipeline 的重复逻辑**（BUG-1）—— 两个入口做同一件事但行为不一致
> 2. **trip mergeResult 错误处理不足**（BUG-2）—— 错误被吞导致 0 结果难定位
> 3. **fileManager 职责过多**（ARCH-1）—— 7 个职责堆一个类，维护风险高
> 4. **数据模型隐式**（ARCH-4）—— a1/a2/a3 无类型定义，字段散落
>
> 建议先修 P0 的 3 个 bug（改动小、风险高），再做 P2 的架构优化。

---

## 6. 用户批复与执行计划

> 以下为用户对审查报告的逐条批复，以及助理的回答。执行时以此为准。

### BUG-1 批复

**用户**：对于为什么会有两份实现我不知道，但我知道前端的跑文件的方式有两种：dev:on 模式点开始自动跑全流程；dev:off 模式都需要用户分别点击步骤流按钮。你说的某个东西的两种实现是否与此有关。

**回答**：**无关。** 查前端代码确认：
- dev on 自动跑：前端调 `pipelineStart` → pipeline.start() → `_invokeAddBatchByStage`
- dev off 手动点：前端调 `pipelineTriggerStep('jxgj'/'o_combo')` → pipeline.triggerStep() → `_invokeAddBatchByStage`

两条路径**都走 pipeline**，从不调 controller 的 `pcp:task:addBatchByStage`。前端 `src/` 搜不到 `taskAddBatchByStage` 调用，只有 preload.js 暴露但无人使用。

**用户批复**：同意。

**结论**：controller.js 的 `pcp:task:addBatchByStage` handler（L44-116）是**死代码**，直接删除。BUG-1 和 BUG-8 一起消失。

### BUG-2 批复

**用户**：有时请求查询到结果为 0 是正常的，比如当天没有此航班等等。这种 0 是正常的，其他比如密码错误，参数不对等等的报错都要弹给前端页面且弹框不会自动关闭，但同类型错误弹框可堆叠为一处，不然可能会错误把页面堆满。

**执行方向**：
1. mergeResult 区分"正常 0 结果"vs"错误 0 结果"：检查 replyStatus / 业务错误码，错误时 throw
2. 错误弹窗机制：主进程捕获 throw 的错误 → 推 IPC 给前端 → 前端弹窗
3. 弹窗不自动关闭，同类型错误堆叠为一（按错误类型或错误码分组）
4. 正常 0 结果（无航班）不弹错误，正常走流程

### BUG-3 批复

**用户**：可能确实是个 bug

**执行方向**：确认 taskScheduler 是否 await onAllComplete；不 await 则改 handleStageComplete 为同步或 promise chain。

### BUG-4 批复

**用户**：可能需要记录下 0 结果的原因，供用户看到

**执行方向**：a2 缺 date_obj / dateValue=null 时，任务结果带上原因说明（如"无日期数据"），前端可见。

### BUG-5 批复

**用户**：同意建议

**执行方向**：trip 匹配增加 null/undefined 检查，改用 `===` 严格比较。

### BUG-6 批复

**用户**：同意建议

**执行方向**：限流器 cooldown 结束后重新走滑动窗口检查。

### BUG-7 批复

**用户**：业务需要，业务需要时效性，必须重新跑。

**结论**：**不处理。** 重启后 stages 重置为 idle 是业务需要（数据有时效性，必须重新跑）。pipelineState.json 保持只存 mode。

### BUG-8 批复

**用户**：不知道你说的是不是业务需求，我需要更详细的信息去判断。

**回答**：跟 BUG-1 是同一件事。controller 的 `addBatchByStage` 是死代码（无调用方），"绕过 pipeline 状态管理"的问题实际不会触发。

**结论**：跟 BUG-1 一起处理——删掉 controller 的死代码。

### BUG-9 批复

**用户**：属于待优化项。暂不处理。

**结论**：暂不处理。

### ARCH-1（fileManager God Object）批复

**用户**：文件管理模块，管所有文件相关实现不好吗，多么好维护，会有什么坑存在吗？你把他拆分到各处好维护吗

**回答**：
- **坑在于"修改爆炸"**：700 行 7 个职责堆一起，改导出格式和改解析逻辑要在同一个文件里找；不相关职责共享内部状态（如 `_pathWithSeq` 被导出和 buildHumanReadableFile 共用），改一个可能影响另一个
- **拆太碎也不好**：建议折中**只拆 2 个**：
  - `ExcelExporter`（exportResult + buildHumanReadableFile + 路径管理）—— 导出逻辑聚合
  - `fileManager` 保留其余（解析 + 持久化 + 合并 + 目录）—— 数据生命周期在一起
- **可暂缓**：现在 700 行还在可控范围，如果改得动、没踩过坑，可以暂缓

**结论**：**暂缓，列为 P3。** 等规模再增长或出现耦合 bug 时再拆。

**用户最终批复**：同意建议，拆 2 个（ExcelExporter + fileManager）。**升级为 P2 执行。**

### ARCH-2（mergeResult 签名不统一）批复

**用户**：我不知道会有什么影响或后果。

**回答**：
- jxgj 的 mergeResult **修改入参**（挂字段到 a1Item），trip 的 mergeResult **不改入参**（返回新数组）
- 调用方必须记住每个平台的行为差异，新增平台时容易写错
- **但影响不算大**：只有 2 个平台，合并逻辑在 fileManager 里是分开的两个方法

**结论**：**暂缓。** 如果以后 O 平台增多再统一。

**用户最终批复**：统一行为，都不改入参，创建副本以供修改和 return。**升级为 P2 执行。**

### ARCH-3（pipeline 和 fileManager 耦合过紧）批复

**用户**：建议听起来不错，此做法有什么好处？

**回答**：
- 现在 pipeline 直接访问 `fileManager.getA1().data`、`item.date_obj` —— 知道 a1/a2 的内部结构
- 如果 fileManager 把 `.data` 改名 `.items`，pipeline 也要跟着改
- 解耦后 fileManager 暴露 `getA1Data()` / `getA2Data()`，pipeline 只调接口不访问内部，改名只改一处
- **好处**：边界清晰，各自可改，互不影响

**结论**：**列为 P2。** 当前只有 2 处调用，改动量小，做了更好但不紧急。

**用户最终批复**：同意解耦。**保持 P2 执行。**

### ARCH-4（a1/a2/a3 无类型定义）批复

**用户**：同意建议

**执行方向**：增加 JSDoc typedef 定义 A1Item/A2Item/A3Item shape。

### ARCH-5（硬编码平台列表）批复

**用户**：同意建议

**执行方向**：从 registry 动态获取 O 平台列表，或定义 `O_PLATFORMS` 常量。

### ARCH-6/7（命名不一致 / 魔法字符串 / priceComparisonPolicy）批复

**用户**：暂时搁置

**结论**：暂不处理。

### ARCH-7（a1/a2/a3 三阶段隐式）批复

**用户**：搁置

**结论**：暂不处理。

---

## 7. 最终执行清单

> 基于用户批复后的执行优先级

### P0（立即执行）

| 编号 | 任务 | 改动文件 |
|------|------|---------|
| BUG-1 + BUG-8 | 删除 controller.js 的 `pcp:task:addBatchByStage` 死代码 handler（L44-116）+ preload.js 对应暴露 | controller.js, preload.js |
| BUG-2 | trip mergeResult 增加 replyStatus 校验 + 错误弹窗机制（不自动关闭 + 同类型堆叠） | trip/adapter.js, controller.js, 前端弹窗组件 |
| BUG-3 | 确认 taskScheduler 是否 await onAllComplete，不 await 则改为同步/promise chain | pipeline.js, taskScheduler.js |

### P1（近期执行）

| 编号 | 任务 |
|------|------|
| BUG-4 | a2 缺 date_obj 时任务结果带原因说明 |
| BUG-5 | trip 匹配增加 null/undefined 检查 |
| BUG-6 | 限流器 cooldown 后重新检查滑动窗口 |
| ARCH-4 | 增加 JSDoc typedef 定义 A1Item/A2Item/A3Item |
| ARCH-5 | 从 registry 动态获取 O 平台列表 |

### P2（架构优化）

| 编号 | 任务 |
|------|------|
| ARCH-1 | 拆 fileManager → ExcelExporter（导出+路径）+ fileManager（解析+持久化+合并+目录） |
| ARCH-2 | 统一 mergeResult 签名为无副作用（创建副本以供修改和 return） |
| ARCH-3 | pipeline 和 fileManager 解耦（fileManager 暴露 getA1Data/getA2Data） |
| ARCH-3.3 | 字段名跨模块硬编码 → 抽取 fieldNames.js 常量 |

### 暂不处理

| 编号 | 原因 |
|------|------|
| BUG-7 | 业务需要时效性，重启必须重跑 |
| BUG-9 | 待优化项，暂不处理 |
| ARCH-6/7 | 命名/三阶段隐式，搁置 |
