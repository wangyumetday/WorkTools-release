# Checklist

- [ ] 携程平台配置面板新增「代理商ID（agencyID）」输入项（schema 驱动）
- [ ] trip 请求体在配置非空时携带 agencyID，为空时不发送该字段
- [ ] 请求体构造断言：带配置 → 含 agencyID；不带配置 → 无该字段（不出真实网络请求）
- [x] .gitignore 中 `_local/wenti/` 注释已删除，仓库内检索 `wenti` 无残留引用（仅规范文档自身对清理事项的描述）
- [ ] 用户真机跑批后，验证结论已记录（isOwn 是否出现 true / 面板三项是否非 0）
- [ ] 备用方案（initSelected 判定）仅在真机验证失败且用户确认后启用
- [ ] trip-compare-test / jxgj-brand-test / runlog-shard-test 全部通过