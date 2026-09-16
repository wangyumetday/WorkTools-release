# ASS 改造：锦绣返回数据提取城市三字码 → 携程查询用城市码

## Context

**问题**：ASS 模块当前用「机场三字码」同时查锦绣和携程。但携程低价查询页面的输入框 placeholder 是「出发城市/到达城市」，按城市三字码查询——机场码填进去会查不到或查错结果。

**用户需求**：
1. 锦绣 API 继续用机场三字码查（现状不变）
2. 从锦绣返回数据里提取「出发城市三字码 / 到达城市三字码」
3. 携程查询改用城市三字码填表单

**字段确认**（来自用户提供的真实样本 `_local/jinxiuAPI.txt`，GBK 编码）：
- `C出发城市` (string) — 出发城市三字码，例 "GZT"
- `D到达城市` (string) — 到达城市三字码，例 "IZM"
- 同数据里也有 `C出发机场`/`D到达机场`（机场码），与城市码可能不同（例：到达机场 ADB vs 到达城市 IZM）

**关键决策**：
- 锦绣 hasFlight=true → 用提取的城市码查携程
- 锦绣 hasFlight=false → List 为空 → SKIP（不需要城市码）
- 锦绣 hasFlight=null（UNKNOWN，请求异常）→ 用机场码兜底查携程，日志明确标注「未查到城市码，使用机场码兜底」
- 锦绣 hasFlight=true 但 List[0] 缺 `C出发城市`/`D到达城市` 字段 → 用机场码兜底，日志标注「未查到城市码」

## 改动文件

### 1. [queryEngine.js](file:///d:/WorkTools-release/electron/features/ass/queryEngine.js) — 核心改造

**A. 改造 `judgeHasFlight(qp)`（L106-L132）**：
- 返回值从 `{hasFlight, rawResponse, error}` 扩展为 `{hasFlight, depCity, arrCity, rawResponse, error}`
- 在 `hasFlight=true` 分支里，从 `rawResponse.Content.List[0]` 提取 `C出发城市`/`D到达城市`，trim+toUpperCase
- 提取失败（字段缺失/空字符串）→ `depCity/arrCity` 保持 null，让 Phase 2 走兜底

**B. 改造 `hasFlightMap`（L236）**：
- value 从 `boolean|null` 改为 `{hasFlight, depCity, arrCity} | null`
- Phase 1 写入：`hasFlightMap.set(qpKey(qp), { hasFlight, depCity, arrCity })`
- Phase 2 读取：`const { hasFlight: flag, depCity, arrCity } = hasFlightMap.get(qpKey(qp)) ?? {}`

**C. 改造 Phase 2 调用（L312-L379）**：
- `flag === false` → status='SKIP'，不变
- `flag === true || null` → 计算实际传给携程的城市码：
  ```js
  const useDep = depCity || qp.dep   // 城市码优先，缺失兜底机场码
  const useArr = arrCity || qp.arr
  const cityFallback = !depCity || !arrCity  // 标记是否走了兜底
  const tripQp = { ...qp, dep: useDep, arr: useArr }  // 携程侧仍读 qp.dep/qp.arr
  raw = await tripQuery(tripQp, session, requestLogin)
  ```
- `onProgress` 的 `P2_ITEM` payload 增加 `cityFallback: boolean` 和 `depCity/arrCity` 字段，供前端日志展示

### 2. [queryPageBrowser.js](file:///d:/WorkTools-release/electron/features/ass/queryPageBrowser.js) — 无需改动

`query(qp)` 和 `_fillFormAndClick(qp)` 始终读 `qp.dep`/`qp.arr` 填表单。改造后 `queryEngine.js` 构造 `tripQp` 时把城市码放进 `dep`/`arr` 字段，所以 queryPageBrowser 不用改。

### 3. [tripClient.js](file:///d:/WorkTools-release/electron/features/ass/tripClient.js) — 无需改动

`tripQuery(queryParam, session, requestLogin)` 原样透传给 `_queryBrowser.query(queryParam)`，不关心字段是机场码还是城市码。

### 4. [processP2.js](file:///d:/WorkTools-release/electron/features/ass/userHooks/processP2.js) — 增加城市码字段（可选）

`processP2(ctx)` 默认透传，建议在 ctx 里附带 `depCity/arrCity/cityFallback`，让用户后续可在 P2 输出文件里看到用了哪个码。需在 queryEngine.js 构造 `p2Ctx` 时加上这些字段。

### 5. [AssLogPanel.vue](file:///d:/WorkTools-release/src/features/ass/views/components/AssLogPanel.vue) — 日志展示兜底标注

`P2_ITEM` 结构化行渲染处（L39-L63）：
- 若 `l.cityFallback` 为 true → 在 status 后追加红色小字「未查到城市码，使用机场码兜底」
- 若有 `depCity/arrCity` → 可选展示「city:GZT-IZM」

### 6. [Home.vue](file:///d:/WorkTools-release/src/features/ass/views/Home.vue) — pushLog 透传新字段

`onProgress` 处理 `P2_ITEM` 时（L230-L298），把 payload 里的 `cityFallback`/`depCity`/`arrCity` 字段透传到 log entry。

## 数据流改造后

```
QueryParam = { dep: 机场码, arr: 机场码, airline, date }
  ↓
Phase 1: jxgjClient.fetchList({depAirPort: dep, arrAirPort: arr})  // 锦绣用机场码
  ↓
judgeHasFlight 从 List[0] 提取 C出发城市/D到达城市 → {hasFlight, depCity, arrCity}
  ↓
hasFlightMap[key] = {hasFlight, depCity, arrCity}
  ↓
Phase 2:
  hasFlight=false → SKIP
  hasFlight=true/null →
    useDep = depCity || qp.dep  // 城市码优先，缺失兜底机场码
    useArr = arrCity || qp.arr
    tripQp = {...qp, dep: useDep, arr: useArr}
    tripQuery(tripQp) → queryPageBrowser 填携程表单（按城市查）
    日志标注 cityFallback
```

## 验证

1. **手动航线测试**：选一条机场码≠城市码的航线（如 PEK→SHA 锦绣返回城市码 BJS→SHA），跑一次任务，检查：
   - `p1_<ts>.jsonl` 里 raw 字段能看到 `C出发城市`/`D到达城市`
   - `p2_<ts>.jsonl` 里查询成功且 status=OK
   - 运行日志中 P2 行能看到 city: BJS-SHA
2. **UNKNOWN 兜底测试**：断网或拔锦绣 token 让 Phase 1 异常，检查：
   - P2 行显示红色「未查到城市码，使用机场码兜底」
   - 携程仍被请求（用机场码），status 可能 OK/ERROR
3. **NO_FLIGHT 测试**：选一条无航班航线，确认 P2 status=SKIP，不请求携程
