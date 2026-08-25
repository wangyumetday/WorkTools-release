# PCP 架构 / 数据流 / 控制流

> 范围：`electron/features/pcp/` + `src/features/pcp/`
> 目标：一眼看懂数据怎么流、步骤怎么编排、平台怎么接入、UI 怎么响应。

---

## 1. 分层架构

```
┌───────────────────────────── 渲染层 (src/features/pcp) ─────────────────────────────┐
│  views/Home.vue          主页布局 + Dev 模式切换按钮（左下角）                          │
│  components/TopToolbar    选文件/开始/下载入口；file 闪烁引导                          │
│  components/ConfigPanel   标签页：账号管理 / 平台配置；门禁闪烁路由                    │
│  components/PlatformConfig 平台 sub-tab；门禁失败时切到对应平台                       │
│  components/PlatformConfigForm  schema 驱动单平台表单（JXGJ 公式/TRIP 一整套/O2-O3）  │
│  components/CredentialManager  4 平台账号分组；credential 闪烁引导                   │
│  components/StepFlow      步骤流 4 步展示；dev 模式可点击触发                          │
│  components/TaskMonitor    任务队列/进度监控                                           │
│  stores/task.js          单一 store：步骤器数据 + 任务监控 + pipelineState + blink   │
└──────────────────────────────────────────────────────────────────────────────────────┘
                              │  window.api.pcp.* (IPC invoke)
                              │  + on* 订阅推送
┌───────────────────────────── IPC 层 ─────────────────────────────────────────────────┐
│  preload.js              api.pcp 命名空间白名单（invoke + on 订阅）                    │
│  src/shared/api.js      渲染层统一入口（动态检测 + mock 兜底 + 错误上下文）            │
│  controller.js          ipcMain.handle 注册：task/file/credential/config/pipeline    │
└──────────────────────────────────────────────────────────────────────────────────────┘
                              │  注入 manager 实例
┌───────────────────────────── 编排层 (electron/features/pcp) ─────────────────────────┐
│  pipeline.js            步骤流单一权威：状态机 + 门禁 + auto/dev + 串联衔接          │
│  taskManager.js         facade：组合 Scheduler + Runner；预编译平台配置                │
│  taskScheduler.js       队列 + 并发池 + 真实进度上报                                   │
│  platformRunner.js      单平台五步执行：账密→登录→前置→请求→交叉                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
                              │  registry.get(key) 动态分发
┌───────────────────────────── 平台层 (platforms/<key>) ───────────────────────────────┐
│  registry.js            注册中心：register/get/all/keys（新增平台零硬编码）            │
│  platforms/jxgj/        锦绣国际（源数据平台，产出 a2，不导出政策）                    │
│    adapter.js           compileConfig/login/prepareRequest/request/mergeResult        │
│    config.js            configSchema + defaults（enabled + floorPriceFormula 等）      │
│    formula.js           mathjs BigNumber 公式编译（仅 + - * / 和括号，变量 cost）       │
│  platforms/trip/        携程 OTA 低价看板（O 平台，产出政策 xlsx）                     │
│    adapter.js           同上 7 方法 + exportTemplate（异构 xlsx 列模板）               │
│    config.js            一整套请求参数 + agentName/agentRemark（业务员信息）           │
│  platforms/o2/          O2（模板预留，未实现，方法抛错）                                │
│  platforms/o3/          O3（模板预留，未实现，方法抛错）                                │
└──────────────────────────────────────────────────────────────────────────────────────┘
                              │
┌───────────────────────────── 数据/配置层 ────────────────────────────────────────────┐
│  fileManager.js         a1/a2/a3 JSON 持久化 + xlsx 解析/导出；导出按 _platform 分组   │
│  configManager.js       schema 驱动配置；get/getSchema/set/isEnabled/enabledPlatforms │
│  credentialManager.js   4 平台账密 + 选中关系；持久化                                   │
│  持久化目录：userData/{data/a1,a2,a3.json, config/platformConfig.json, ...}           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**装配入口**：`electron/main.js` → `initFeatures()` 实例化 4 manager + Pipeline，`registerIpcHandlers()` 注入 controller。
依赖注入顺序：`configManager` → `credentialManager` → `fileManager(注入 configManager)` → `taskManager(注入 credential+config)` → `Pipeline(注入全部)`。

---

## 2. 数据流（a1 → a2 → a3）

```
[用户 xlsx] ─parseXlsx→ a1[]                          步骤1 上传
   每条：{id, CF_jichang, DD_jichang, CH_city, DD_city, hangsi, cangwei_str}

a1[] ─JXGJ 请求+交叉→ a2[]                            步骤2/3 锦绣国际
   每条 = 增强 a1 项：+ cangwei_arr[] + date_obj{日期: 航班[]}
   底价公式 floorPriceFormula(cost) 在此编译应用 → item.dijia

a2[] ─拆 date_obj→ O 任务[] ─各 O 请求+交叉→ a3[]       步骤4 O 平台组合
   每个 O 任务：{id, source: a2项, dateKey, dateValue: 当天航班[]}
   runCombo 并行执行已选中账号的 O 平台 → result{trip, o2, o3}
   saveA3FromOTasks 按 _platform 分组 + exportTemplate 生成行

a3[] ─exportResult→ <platform>.xlsx（每 O 一份）        步骤5 下载
   trip.xlsx / o2.xlsx / o3.xlsx（按 exportTemplate.columns 决定列序）
```

**关键落盘点**：
- `fileManager.saveStageResults(stage, tasks)` 是阶段完成的唯一落盘点
  - `stage='jxgj'` → `saveA2FromJxgjTasks`（取 `task.result.data.inputData`）
  - `stage='o_combo'` → `saveA3FromOTasks`（按 `task.result[platform]` 分组 + exportTemplate）
- 落盘由 `pipeline.handleStageComplete` 触发（接管 `scheduler.onAllComplete`）

---

## 3. 控制流（Pipeline 状态机）

### 状态机
```
status: idle | running | paused | waiting_next | done
step:   upload | jxgj | o_combo | export
mode:   auto | dev   （持久化到 userData/config/pipelineState.json）
```

### auto 模式（默认：选文件 + 点开始 → 跑到底）
```
[点开始] → pipeline.start()
   ├─ checkGate() 失败 → emit gateFail → 渲染层闪烁引导（missing[0]）
   └─ 通过 → status=running, step=jxgj → runStage('jxgj')
        ├─ _invokeAddBatchByStage('jxgj') → taskManager.addBatch + start
        └─ stage 完成 → handleStageComplete
             ├─ saveStageResults('jxgj') 落盘 a2
             ├─ emit pcp:task:allComplete
             └─ mode==='auto' → 自动 runStage('o_combo')
                  └─ stage 完成 → handleStageComplete
                       ├─ saveStageResults('o_combo') 落盘 a3
                       └─ step='export', status='done' → 等用户下载
```

### dev 模式（步骤需手动点击触发）
```
[切 dev] → pipeline.setMode('dev') → emitState → StepFlow 步骤变 clickable
[点开始] → store.handleStartExecution → mode==='dev' → pipelineTriggerStep('jxgj')
   └─ pipeline.triggerStep('jxgj') → checkGate → runStage('jxgj')
        └─ stage 完成 → handleStageComplete
             └─ mode==='dev' → status='waiting_next', step='o_combo'  ← 停下等用户
[点 StepFlow o_combo] → pipelineTriggerStep('o_combo') → runStage('o_combo')
   └─ stage 完成 → status='done'
```

### 前置门禁（checkGate）+ 闪烁引导
门禁按顺序检查，`missing[0]` 是当前要补的第一项（一次只闪一个，补完再点开始）：

| 检查项              | missing key        | 闪烁目标 + UI 跳转                                    |
|---------------------|--------------------|-------------------------------------------------------|
| a1 文件未选         | `file`             | TopToolbar 选文件按钮抖动                             |
| JXGJ 配置未启用     | `jxgj_config`      | ConfigPanel→平台 tab→jxgj sub-tab→配置块抖动          |
| JXGJ 未选账号       | `jxgj_credential`  | ConfigPanel→账号 tab→jxgj 卡片抖动                    |
| 无 O 平台启用       | `o_config`         | ConfigPanel→平台 tab→trip sub-tab→配置块抖动           |
| 启用 O 未选账号     | `o_credential`     | ConfigPanel→账号 tab→第一个未选 O 卡片抖动             |

闪烁链路：`pipeline.emit('pcp:pipeline:gateFail', {missing})` → preload `onPipelineGateFail` → `store.handlePipelineGateFail` → `triggerBlink(missing[0])` → 各组件 `watch(store.blinkTarget)` 匹配自己的 key 加 `.pcp-blink-shake` 抖动 + 自动切 tab。3.5s 后 store 自动清空 blinkTarget。

---

## 4. 关键组件职责表

| 文件                                            | 职责                                                      |
|-------------------------------------------------|-----------------------------------------------------------|
| `electron/main.js`                              | 装配：实例化 managers + Pipeline，注册 IPC，自动更新       |
| `electron/features/pcp/pipeline.js`             | 步骤流编排：状态机/门禁/runStage/串联/mode 持久化          |
| `electron/features/pcp/taskManager.js`          | facade：组合 Scheduler+Runner，预编译配置，门禁账号检查    |
| `electron/features/pcp/taskScheduler.js`        | 队列+并发池+runNextTask 自驱+进度推送                     |
| `electron/features/pcp/platformRunner.js`       | 单平台五步执行+真实进度；runCombo 并行 O 平台             |
| `electron/features/pcp/controller.js`           | IPC handlers 注册（task/file/credential/config/pipeline） |
| `electron/features/pcp/fileManager.js`          | a1/a2/a3 持久化+xlsx 解析/按 _platform 分组导出          |
| `electron/features/pcp/configManager.js`        | schema 驱动配置：get/getSchema/set/isEnabled               |
| `electron/features/pcp/credentialManager.js`    | 4 平台账密+选中关系                                       |
| `platforms/registry.js`                         | 平台注册中心：register/get/all                           |
| `platforms/<key>/adapter.js`                    | 7 方法接口：compileConfig/login/prepareRequest/request/mergeResult + exportTemplate |
| `platforms/<key>/config.js`                     | configSchema + defaults（驱动配置页+门禁）               |
| `src/features/pcp/stores/task.js`               | 单一 store：步骤器+任务监控+pipelineState+blinkTarget     |
| `src/features/pcp/views/Home.vue`               | 主页布局 + Dev 切换按钮                                   |
| `src/features/pcp/components/StepFlow.vue`      | 步骤流展示 + dev 可点击触发                               |

---

## 5. IPC / 事件清单

### 渲染层 → 主进程（invoke）
| 通道                      | 入参                | 说明                                  |
|---------------------------|---------------------|---------------------------------------|
| `pcp:task:add`            | task                | 添加单任务                            |
| `pcp:task:addBatchByStage`| stage               | 按阶段批量添加（jxgj/o_combo）         |
| `pcp:task:start`          | stage               | 启动队列                              |
| `pcp:task:pause`          | -                   | 暂停                                  |
| `pcp:task:getState`       | -                   | 查队列状态                            |
| `pcp:task:setConcurrency` | n                   | 设并发数                              |
| `pcp:file:uploadXlsx`     | -                   | 选 xlsx + 解析为 a1                   |
| `pcp:file:getA1/A2/A3`    | -                   | 取各阶段数据计数                      |
| `pcp:file:downloadResult` | -                   | 按 O 平台分组导出多 xlsx              |
| `pcp:credential:*`        | ...                 | 账号增删查选                          |
| `pcp:config:get`          | -                   | 取全部平台配置                        |
| `pcp:config:getSchema`    | -                   | 取全部平台 schema（驱动配置页渲染）   |
| `pcp:config:set`          | config              | 保存配置                              |
| `pcp:pipeline:start`      | -                   | auto 模式启动                         |
| `pcp:pipeline:triggerStep` | step                | dev 模式触发单步                      |
| `pcp:pipeline:setMode`    | mode                | 切 auto/dev                           |
| `pcp:pipeline:pause`      | -                   | 暂停流程                              |
| `pcp:pipeline:getState`   | -                   | 取 pipeline 状态                      |

### 主进程 → 渲染层（send / on 订阅）
| 通道                       | payload                       | 触发时机                          |
|----------------------------|-------------------------------|-----------------------------------|
| `pcp:task:progress`        | task[]（16ms 合批去重）       | 任务进度变化                      |
| `pcp:task:allComplete`     | {results, stage}              | stage 整批完成                    |
| `pcp:file:downloadProgress`| {progress: 0~100|-1}          | 导出进度                          |
| `pcp:pipeline:state`       | {mode,status,step,...}       | Pipeline 状态变化                |
| `pcp:pipeline:gateFail`    | {success,missing}             | 门禁失败（渲染层据此闪烁引导）    |

---

## 6. PlatformAdapter 接口（7 方法 + schema）

```js
// platforms/<key>/adapter.js 必须导出
{
  key,                  // 'jxgj' | 'trip' | 'o2' | 'o3'
  configSchema,         // 从 ./config.js，驱动配置页渲染 + 门禁
  defaults,             // 从 ./config.js，配置缺字段兜底
  compileConfig(raw),   // 预编译：字符串公式→函数（JXGJ 用，O 平台透传）
  login(credential),    // 登录（JXGJ mock token / TRIP 透传账密）
  prepareRequest(data, dateKey, cfg),  // 前置：拼 URL/请求体
  request(prepared, ctx),               // 发请求（含重试/超时/gzip）
  mergeResult(raw, data, cfg),         // 交叉：响应 + 原数据 → 结果
  exportTemplate                        // 导出模板（O 平台用，JXGJ=null）
}
```

`exportTemplate` 结构（仅 O 平台）：
```js
{
  platform: 'trip',
  columns: [
    { key: 'Name', from: (item, cfg) => `${cfg.agentName}_${item.H航司名}_...` },
    { key: '优先级', value: '90' },           // 静态字面量
    { key: '调价固定加减钱', from: (item) => item.CUT_VALUE },
    ...
  ]
}
```
`from(item, cfg)` 的 `cfg` = `configManager.getPlatformConfig(platform)`（含 agentName/agentRemark）。
