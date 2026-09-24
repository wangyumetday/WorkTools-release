# Tasks

- [x] Task 1: 携程平台配置新增「代理商ID（agencyID）」数值项 —— 已实施后按用户决定**全量回滚**（Task 4 实测 agencyID 无作用）
- [x] Task 2: 请求体携带 agencyID —— 同上，已回滚（buildRequestBody 恢复原签名，T33 测试一并移除）
- [x] Task 3: 清理误导残留
  - [x] 3.1 删除 .gitignore 第 19 行 `_local/wenti/` 注释
  - [x] 3.2 仓库内检索 `wenti` 确认无残留引用
- [x] Task 4: 真机验证（2026-09-24 已完成，结论推翻本 spec 前提）
  - [x] 4.1 A/B 对照实验：XQ AYT→CAI 2026-10-17（用户确认已投放），同一请求带/不带 agencyID=4984
  - [x] 4.2 结果：**两组响应完全相同，均有 isOwn=true ×2（814/1043，showState=0）** —— 携程靠 requestHeader 账密识别身份，agencyID 无作用
  - [x] 4.3 结论：① 用户 2026-09-23 18:19 跑批（62 任务）三项统计为 0 是真实反映——该批响应里确实无 isOwn=true 报价（逐任务 HTML 验证：0 个 qrow--own 行）；② app 代码全链路正确（真实响应走真实 mergeResult → quoteOwn=2 计数正常）；③ 已实施又回滚：agencyID 配置项/请求字段/T33 测试全部撤销（实测无用）
- [ ] Task 5: 备用方案 —— **已证伪，永不实施**：实测我方报价属性标签为 `NEW_QUANTIFY_COMPARE:beatAllSelected`，`initSelected` 出现在他人报价上（该标记是 OTA 航班卡选中标记，非我方标识）；且 agencyID 主线本就无需启用
- [x] Task 6: 回归测试
  - [x] 6.1 跑 trip-compare-test、jxgj-brand-test、runlog-shard-test 确认无回归

# Task Dependencies
- Task 2 依赖 Task 1（需先有配置项）
- Task 4 依赖 Task 2（请求体先带上 agencyID 才能真机验证）
- Task 5 依赖 Task 4（验证失败后才启用）
- Task 3、Task 6 无依赖，可并行