# PCP 重构计划

## 目标
原位重建 PCP feature，解决：①步骤流拆分不清 ②autoChain 链式启动出错 ③平台定制散落 ④TaskManager 职责过载 ⑤功能未实现。

## 已确认决策
- 原位重建 `electron/features/pcp` + `src/features/pcp`；老代码备份到 `.ref/pcp-old/`（纯文本参考）
- 保留 `main.js` 装配 + `router` + `preload` + `api.js` + ERC + 悬浮窗，仅重建 PCP
- 编排层拆三块：`Pipeline` + `Scheduler` + `PlatformRunner`
- 平台抽离：`platforms/<key>/{adapter.js, config.js, (formula.js)}` + `PlatformAdapter` 7 方法接口
- 步骤流收回主进程 `Pipeline`；前端只发 start/triggerStep/pause
- 前置门禁 + 闪烁引导：选文件 → JXGJ 配置启用 → 至少一个 O 启用
- dev 模式：步骤点击触发；auto 模式：门禁通过后跑到底
- 每 O 一份异构 xlsx（`exportTemplate`）；JXGJ 配置页新建
- 验证：jxgj + trip 真实账号跑小批量数据

## PlatformAdapter 接口
```
{ key, configSchema, defaults, compileConfig(raw), login(credential),
  prepareRequest(a2Item, dateKey, cfg), request(prepared, ctx), mergeResult(raw, a2Item, cfg),
  exportTemplate }
```

## 步骤流（Pipeline 单一权威）
1. 上传 Excel → a1
2. 前置门禁（"开始"动作的检查 + 闪烁引导补全，非独立步骤）
3. JXGJ 请求 → a2（含航班 + date_obj）
4. 各 O 请求（前置→请求→交叉）→ 各 O 独立结果
5. 各 O 导出（adapter.exportTemplate）→ 每O一份 xlsx

## 阶段
- [x] 阶段 1 平台抽离：`registry.js` + `jxgj/trip` adapter 落地 + `configManager` schema 驱动 + 老 `taskManager` dispatch 走 registry
- [x] 阶段 2 拆 TaskManager：`taskScheduler.js` + `platformRunner.js` + 进度真实上报
- [x] 阶段 3 Pipeline + StepFlow：编排 + 门禁 + dev 触发 + 闪烁引导 + 移除 autoChain
- [x] 阶段 4 配置页 + 导出：`PlatformConfig` 加 JXGJ + schema 渲染 + `exportTemplate` 各 O 导出 + o2/o3 模板
- [x] 文档：架构/数据流/控制流 + 修改维护指南 → `architecture.md` / `maintenance.md`

## 移植来源
- `jxgj/formula.js` ← 老 `g1.js` 的 `makeFloorPriceFn/validateNode/toMoneyNumber`
- `jxgj/adapter.js` ← 老 `g1.js` 的 `g1Request`（拆三步）
- `trip/adapter.js` ← 老 `o1.js` 的 `postGzip/buildRequestBody/buildSegments/parseResponse/priceComparisonPolicy`（拆三步）
- `trip/config.js` ← 老 `o1.js` 的 `O1_DEFAULTS`
- `taskScheduler.js` ← 老 `taskManager.js` 的并发池
- `platformRunner.js` ← 老 `taskManager.js` 的 `runPlatformRequest`
