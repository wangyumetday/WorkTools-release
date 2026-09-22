# PCP 运行日志「分片 HTML」改造

## Context（为什么改）

110 航线大跑时，单文件 run-log.html 体积逼近 V8 单字符串上限（~512MB，12:01 成功那次已达 460MB），buildHtml 拼接抛异常被 exportRunLog 外层 catch 吞掉 → 只剩空文件夹。用户确认改为**分片 HTML**：一个总览页 + 每任务一个小文件，保留全量数据与现有可视化风格，永不超限、秒开、可搜索，失败时落 error.txt 兜底。

## 设计

产出目录（沿用现有命名 `YYYYMMDD_HHMM_<航司>_<航线数>[/_N]`）：

```
20260922_1508_XQ_110/
├── index.html          ← 总览页（meta/统计/任务列表，点击跳任务详情）
├── tasks/
│   ├── task-0001.html  ← 每任务一张完整卡片（含对比过程与结果/返回数据/任务数据）
│   └── ...
└── error.txt           ← 导出中任何失败写错误信息（不再静默空文件夹）
```

- index.html：复用现有深色终端 CSS；头部 meta + 统计行（成功/失败/终止/其它）+ 分节（锦绣请求 / 携程请求 / 其它）；每任务一行：状态点、任务ID、类型、航线、进度、阶段，trip 任务附 summary 摘要（对比单元/比赢/比输/未匹配/无对应），链接 `tasks/task-XXXX.html`；渲染失败的任务在索引行标「导出失败」。
- 单任务文件：现有 `renderTaskCard(task)` 原样复用（单任务字符串很小，不会触上限）。
- **对比过程与结果 = 任务列表同款套餐块格式**：`renderQuoteBlock` 的 role 渲染已是最新口径（role='official' 官网行 + role='ctrip' 携程行），本次把分组渲染从「全部行塞一个 tbody」改为**每个 unitKey 一个 `<tbody>`**（与 RequestItem.vue 分块一致），使每个锦绣套餐成为视觉上独立的一块：块首官网行（官价/底价/行李+判定/无人投放标注），其下逐条携程行；附加行（无对应）沿用 own tbody。
- error.txt：任一单任务渲染失败 → 记一行继续导出；外层异常 → 写入 error.stack/message。

## 实施步骤

### 1. electron/features/pcp/runLogExporter.js（唯一核心改动文件）

- `LOG_FILENAME`（L30）删除，新增 `INDEX_FILENAME = 'index.html'`、`TASKS_DIR = 'tasks'`、`ERROR_FILENAME = 'error.txt'`。
- `buildHtml`（L309-505）拆为：
  - `pageShell(title, bodyHtml)`：抽取现有 `<!DOCTYPE html>…样式…` 外壳（样式块原样保留，含 .rb-* / qrow-* 全部 CSS），多两个共用；
  - `renderIndexHtml({ tasks, meta, taskFiles, failedTasks })`：生成总览页（上面设计内容）；
  - `renderTaskHtml(task)` ⇒ `pageShell(任务标题, renderTaskCard(task))`。
- `exportRunLog`（L536-584）改为：
  1. 建子目录 + `tasks/` 子目录（mkdirSync 不变的前半段）；
  2. 遍历 tasks：逐个 `renderTaskHtml` → `writeFileSync(tasks/task-XXXX.html)`（4 位序号）；单个失败 → `fs.appendFileSync(error.txt, …)` 并标记 failedTasks，继续；
  3. 写 index.html（小字符串，安全）；
  4. 外层 catch：写 error.txt（含 `e.stack || e.message`），`console.error` 保留，返回 `{ success:false, error, dir }`；
  5. 成功返回 `{ success:true, dir, file: index.html 路径 }`（调用方 pipeline.js 只 console.log(r.file)，返回键不变）。
- 保留不动：safeStringify/escapeHtml/extractRoute/statusToClass/triggerLabel/QUOTE_STATUS_TEXT/UNMATCH_REASON_TEXT/quoteStatusText/renderTaskCard 及相关 CSS。
- `renderQuoteBlock`（L154-255）小改：分组渲染改为「每个 unitKey 一个 `<tbody>`」（每套餐块），行渲染逻辑（renderRow 的 role 分支）不变。

### 2. electron/features/pcp/pipeline.js（不改逻辑，仅核对）

- `_exportRunLog`（L839-855）调用方式不变（参数与返回键一致），无需改动；确认后不做任何代码修改。

### 3. 新增 _local/tests/runlog-shard-test.mjs（诊断期验证手法复用）

- 用与诊断相同的 electron 桩（读取 runLogExporter.js 源码替换 `import { app } from 'electron'` 为 `const app = null`，写入临时 stub 再动态 import——仅测试用，不动源码）。
- 构造 3-4 个合成任务（jxgj + trip 含 mergeResult 真实结果），调用 exportRunLog 写入桌面目录后立即查出：
  1. `index.html` 存在，含任务数统计与 `tasks/task-0001.html` 链接；
  2. `tasks/` 下文件数 = 成功导出的任务数；
  3. 返回 `{success:true, file}` 中 file 指向 index.html；
  4. trip 任务页 HTML 中「对比过程与结果」按 unitKey 分 `<tbody>`：有 N 个套餐块则 N 个 tbody，块内先官网行（`qrow--official`）后携程行（`qrow--ctrip`）
  5. 目录清理（rm -rf 测试目录）。
- 一个失败注入用例：模拟一个 `status==='failed'` 任务的 `result` 为不可序列化数据（可用含 toJSON 抛错的对象），断言 error.txt 生成、其余任务文件仍产出、索引含「导出失败」标记（若实现上有该标记）。

### 4. 本地函数级冒烟（可选，若上条失败注入难写则跳过）

- 直接以 `.scratch/` 临时脚本（跑完删除）验证大任务渲染单文件不超限（mock 一个 5MB 级 result 的任务，断言 tasks/task-0001.html 成功写入）。

## 验证

1. `node _local/tests/runlog-shard-test.mjs` 全绿。
2. `npm run build` 三端通过。
3. 用户实跑一次（先小跑再 110 大跑）：桌面目录出现 index.html + tasks/*.html，双击 index 秒开；任何失败可见 error.txt；旧单文件 run-log.html 不再产出。

## 边界与风险

- 无 UI/代码依赖旧 'run-log.html' 文件名（已核实），直接切换安全。
- pipeline 调用点五处触发时机不变；返回键不变，日志打印 `r.file` 自动指向 index.html。
- 每任务文件仍是「完整卡片」，体验上从"一个 460MB 文件里滚"变为"索引页点进详情"，数据零损失。
- task 序号用 4 位补零（task-0001.html），索引与文件名映射存于内存，不落 JSON。