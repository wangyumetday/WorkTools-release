# 携程政策回写 + 政策文件单程过滤 实施计划

## Context

用户跑完 PCP 比价后，现状是「凭空生成」一份《携程导入政策{日期}.xlsx》。新需求：
1. 政策导入文件**只输出「航程类型=单程」的政策行**（多程不写；底价检查文件保留多程）。
2. 新增「政策文件上传」项（TopToolbar 左栏「航线：选择文件」下方）：用户上传外部系统（携程）导出的政策文件。
3. 点「下载结果文件」时，若已上传政策文件 → 拿本次生成政策逐条与用户文件匹配回写；未上传 → 回退旧模式。

**回写规则（已与用户对齐）**
- 9 项全等即同一政策：`OTAConfigID / 航程类型 / 航司名 / 机场航线匹配 / 舱位 / 去程套餐索引v2 / 爬虫名 / 价格基础类型 / 创建人id`（全部为政策文件模板实列名，已核实存在于 exportTemplate.columns）。
- 命中 → 取**第一条命中用户行**的 `ID`、`CreateTime` 覆盖到我方行，整条替换；多条命中 = 多变一：**删除全部命中行、我方更新行追加到文件末尾**（用户确认）。
- 未命中 → 我方行（ID/CreateTime 留空）直接追加。
- 产物：在用户文件基础上**另存新文件到下载目录**，文件名沿用旧格式 `{航司-}携程导入政策{日期}.xlsx`。

## 改动清单（按实施顺序）

### 1. 新增 `electron/features/pcp/policyWriteback.js`（纯逻辑，无 Electron 依赖）
- `POLICY_MATCH_KEYS`：9 键数组（顺序固定）。
- `normalizePolicyKey(v)`：9 键字符串化统一口径——null/undefined/空串/空白 → `''`；数字与纯数字文本 → `String(Number(v))`（11 == '11' == '11.0'）；其余文本 `trim().toUpperCase()`（xq==XQ、ber-ayt==BER-AYT）。
- `buildHeaderKeyMap(headers)`：表头名 → 列索引（9 键 + ID + CreateTime 共 11 列）。
- `signatureOfFlatRow(flatRow)` / `signatureOfUserRow(userRowArr, keyColMap)`：9 键归一化后 `JSON.stringify` 拼接为签名。
- `keepPolicyRow(row, outcomeField)`：`outcome !== 'lost'` 且 航程类型归一后 === '单程'（复用 ExcelExporter 303 行已用的 `A3_FIELDS._outcome`）。
- `applyPolicyWriteback(ourFlatRows, userPolicy)`：
  - 我方行按签名去重建 Map（防我方重复 9 键异常数据）。
  - 用户行按签名匹配 → 命中集合：`ID/CreateTime` 取第一条命中行；多变一=全部命中行删除、我方更新行进 appended。
  - 结果 `{ finalRows, deletedCount, hitCount, appendCount }`：未命中用户行保序 + appended 追加末尾。
- `buildRowInUserColumnOrder(flat, headers)`：我方 147 列 {key:value} 按用户表头列序重排为数组（缺失列填 ''），保用户列序/列数。

### 2. 新增 `_local/tests/policy-writeback-test.mjs`（测试先行）
锚点：①匹配（数字 11 vs 文本 '11'、小写 vs 大写都命中；ID/CreateTime 覆盖）②未命中（追加、ID/CreateTime 空）③多变一（删 2 条留 1 条在末尾、取第一条 ID/CreateTime）④`keepPolicyRow` 单程过滤三态。

### 3. `electron/features/pcp/fileManager.js`
- 新内存字段 `this.policyFile = null`；`hasPolicyFile()` / `getPolicyFileData()` / `setPolicyFileData()`。
- 新 `parsePolicyFile(filePath)`：`XLSX.readFile` + `sheet_to_json({header:1, defval:null})`（复用 parseXlsx 同款）；表头首行，若首行无 `OTAConfigID`/`航程类型` 则顺延试下一行（至多两行）；`buildHeaderKeyMap` 建索引；11 列缺失 → 返回 `{success:false, error:'缺少列: xxx'}`；成功即 `this.policyFile = { headers, keyColMap, rows }` 并返回 `{success:true, fileName, count}`。
- `clearAll()` 末尾加 `this.policyFile = null`（换航线/下载完成 pipelineReset → clearAll 天然清政策文件；上传政策本身不 reset，不清航线数据）。

### 4. `electron/features/pcp/controller.js`
- 在 `pcp:file:uploadXlsx` 旁新增 `ipcMain.handle('pcp:file:uploadPolicy')`：`failIfInProgress('上传政策文件')` → dialog（xlsx/xls filter、lastDirectory）→ `fileManager.parsePolicyFile(path)`。

### 5. `electron/preload.js`
- `fileUploadPolicy: () => ipcRenderer.invoke('pcp:file:uploadPolicy')`。

### 6. `src/features/pcp/stores/task.js`
- 新 ref `policyFileName`；新 action `handleUploadPolicyXlsx()`：调 `api.pcp.fileUploadPolicy()`（**不调 pipelineReset**），成功记 fileName + message 提示（含条数），失败 message.error。导出暴露。

### 7. `src/features/pcp/components/TopToolbar.vue`
- 左栏「航线：选择文件」行下方加「政策: 政策文件上传」按钮（`:disabled="store.pipelineInProgress"`），上传成功后展示文件名（ttb-fi-value 样式）。

### 8. `electron/features/pcp/ExcelExporter.js`
- **单程过滤**：303 行改为 `rows = groups[p].filter(r => keepPolicyRow(r, A3_FIELDS._outcome))`（老数据无 `_outcome` 时 `undefined !== 'lost'` 仍兼容）。
- **回写分支**：循环体内生成 worksheet 前：`writeback = (p === 'trip') && this.fileManager.hasPolicyFile()`；true → `applyPolicyWriteback(flatData, getPolicyFileData())`，`XLSX.utils.aoa_to_sheet([userPolicy.headers, ...finalRows])`（保留用户表头/列序/单元格类型）；false → 原 `json_to_sheet` 逻辑零改动。
- 文件名 `finalPath`/`unifiedSeq`/进度推送/底价检查文件生成**全部不动**（底价检查读 `fileManager.a3` 全量，含多程，不受单程过滤影响）。

## 既有测试影响
- trip-compare-test / runlog-shard-test / jxgj-brand-test 均不触碰（改动全在导出层与上传链路，adapter 未动），跑一遍确认无回归即可。

## 验证
1. `node _local/tests/policy-writeback-test.mjs`（新锚 4 类）。
2. 既有三套回归（trip/runlog/jxgj）全绿。
3. 手工端到端：上传航线 → 上传政策文件（显示文件名/条数）→ 跑批 → 下载：
   - 命中/未命中/多变一三种行在输出文件中正确（另存到下载目录、文件名旧格式）；
   - 未上传政策文件 → 仍凭空生成导入文件（回退模式）；
   - 底价检查文件仍含多程行。