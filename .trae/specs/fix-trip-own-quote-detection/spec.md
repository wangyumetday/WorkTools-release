# 携程「我方投放」识别修复（agencyID / 当前代码事实依据）Spec

## Why
数据统计面板中「我方投放数 / 展示的报价数 / 我方胜出却未显示数」恒为 0：真实携程响应里 `isOwn` 对任何报价都返回 false，程序仅以 isOwn 判定我方投放，永远判不出。已确认携程侧的我方标识线索：接口文档（2.9 低价看板查询）示例报文中带 `agencyID`（代理商ID），我方供应商编号为 4984。需要按**当前仓库内真实代码**实施修复并真机验证；不再引用任何历史数据样本（含 D:\WorkTools-data 下已迁移的抓包文件）。

## What Changes
- 携程平台配置新增「代理商ID（agencyID）」数值配置项（默认空），用户填 4984。
- 携程请求体 `queryCondition` 增加 `agencyID` 字段：配置非空时随请求发送；为空时不发送（行为与现状一致）。
- 验证主线：真机跑真实数据，观察响应中 isOwn 是否开始出现 true，面板三项统计是否非 0。
- 备用方案（仅当主线验证 isOwn 仍恒 false 时启用）：将「我方投放」判定改为 `isOwn === true 或 属性标签 quantifyFlagRemark 含 initSelected`（代码现有 isInit 检测即此标记），作用于统计口径（我方投放数/展示的报价数/我方胜出却未显示数）与对比块展示。
- 清理误导残留：删除 `.gitignore` 第 19 行关于 `_local/wenti/` 的注释（该目录已迁出/删除，残留注释会误导后续会话引用不存在路径）。
- 结束结论需写回项目记忆（新口径 + 真机验证结果）。

## Impact
- Affected specs: 携程平台配置 schema、trip 平台请求构造、任务监视器统计口径（备用方案时）。
- Affected code:
  - `electron/features/pcp/platforms/trip/config.js`（平台配置 schema）
  - `electron/features/pcp/platforms/trip/adapter.js`（buildRequestBody / 备用方案下的 isOwn 判定）
  - 前端政策/平台配置面板（schema 驱动，自动出现新输入项）
  - `_local/tests/trip-compare-test.mjs`（请求体构造断言 / 备用方案下统计断言）
  - `.gitignore`

## ADDED Requirements

### Requirement: 携程请求携带代理商 ID
系统 SHALL 支持在携程低价看板请求的 `queryCondition` 中发送 `agencyID`，其值来自携程平台配置中用户填写的「代理商ID」。

#### Scenario: 已配置 agencyID 时请求携带
- **WHEN** 用户在携程平台配置里填写代理商ID（如 4984）并执行比价任务
- **THEN** 每个低价看板请求的 queryCondition 中包含该 agencyID 数值

#### Scenario: 未配置 agencyID 时行为不变
- **WHEN** 用户未填写代理商ID（空值）
- **THEN** 请求体不包含 agencyID 字段，与当前行为一致，不影响现有任务

### Requirement: 我方投放统计的真实数据验证
系统 SHALL 在一次真实数据运行中验证 isOwn 是否返回 true，并以此判断三项统计（我方投放数 / 展示的报价数 / 我方胜出却未显示数）是否恢复非 0。

#### Scenario: agencyID 生效
- **WHEN** 用户使用填写了 agencyID 的配置跑一批真实航线
- **THEN** 携程响应出现 isOwn=true 的报价，数据统计面板三项由 0 变为非 0

#### Scenario: agencyID 无效（触发备用方案）验证结果仍可信
- **WHEN** 填写 agencyID 后真实运行中 isOwn 仍全部为 false
- **THEN** 不改变比价主逻辑；启用备用方案（initSelected 判定）前需用户确认，并以代码内现有 isInit 逻辑为唯一依据

### Requirement: 清理误导性路径残留
系统 SHALL 删除 `.gitignore` 中关于 `_local/wenti/` 的注释行，防止后续会话依据已不存在的目录做判断。

#### Scenario: 仓库内无 wenti 引用
- **WHEN** 清理完成后在仓库内检索 `wenti`
- **THEN** 不再有指向已迁出/删除目录的引用

## MODIFIED Requirements
无。

## REMOVED Requirements
无。