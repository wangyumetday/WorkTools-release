# 锦绣 TaskResult 接口文档

> 来源：`https://spider.xxklf.com/taskresult/swagger/index.html`（Swagger / OpenAPI 3.0.1）
> 服务名：`Spider.TaskResultManager v1`
> 整理日期：2026-08-28

---

## 通用说明

### Base URL

```
https://spider.xxklf.com/taskresult
```

所有接口路径均以 `/taskresult` 为前缀，Swagger 文档中写的 `/api/...` 是相对路径，实际请求时必须拼接为：

```
https://spider.xxklf.com/taskresult/api/...
```

直接请求 `https://spider.xxklf.com/api/...` 会返回 404（nginx）。

### 认证

**无需登录验证 / 无需 Token。** Swagger 中未声明任何 `securitySchemes`，实测不带 Cookie、Authorization、API Key 等任何凭证即可正常调用，返回真实数据。

### 编码要求

| 场景 | 要求 |
|---|---|
| 请求体（POST） | 必须使用 **UTF-8** 编码，`Content-Type` 设为 `application/json; charset=utf-8` |
| 中文参数名 | 请求体中的属性名为中文（如 `起飞日期`、`出发机场`），不能用英文翻译替代 |
| 响应体 | JSON 响应中中文以 `\uXXXX` Unicode 转义形式返回；`format=3`（文本格式）响应虽为 UTF-8 但 `Content-Type` 不带 `charset`，客户端需强制按 UTF-8 解码，否则中文会乱码 |

### 数据来源枚举 `ETicket数据来源`

| 值 | 含义（推断） |
|---|---|
| 0 | 全部 |
| 1 | 爬虫 |
| 2 | API |
| 3 | 其他 |

---

## 接口一：GetList — 分页查询机票结果列表

### 基本信息

| 项 | 值 |
|---|---|
| 路径 | `GET /api/TaskResult/GetList` |
| 完整 URL | `https://spider.xxklf.com/taskresult/api/TaskResult/GetList` |
| 方法 | GET |
| 认证 | 无 |
| 用途 | 分页浏览所有已采集的机票数据，支持多维度过滤 |

### 请求参数（Query String，全部可选）

| 参数名 | 类型 | 说明 |
|---|---|---|
| `fn` | string | 航班号，如 `HO1729` |
| `depDate` | date-time | 出发日期，如 `2026-09-20T00:00:00` |
| `arrDate` | date-time | 到达日期 |
| `depAirPort` | string | 出发机场三字码，如 `NKG` |
| `arrAirPort` | string | 到达机场三字码，如 `CGQ` |
| `stopAirPort` | string | 经停机场三字码 |
| `cabin` | string | 舱位，如 `T`、`Y` |
| `carrier` | string | 航司二字码，如 `HO` |
| `gn` | boolean | 是否经停（推断：gn = 经停） |
| `zz` | boolean | 是否中转（推断：zz = 中转） |
| `dataSource` | enum(int) | 数据来源，见上方枚举表 |
| `spiderName` | string | 爬虫名称 |
| `updateSecond` | double | 数据更新时间窗口（秒），仅返回 N 秒内更新的数据 |
| `CurrentPage` | int32 | 当前页码，从 1 开始 |
| `PageSize` | int32 | 每页条数 |
| `isTest` | boolean | 是否包含测试数据 |
| `max_seats` | int32 | 最大座位数筛选 |
| `index` | int32 | 索引偏移 |
| `价格开始` | double | 价格区间下限（CNY） |
| `价格结束` | double | 价格区间上限（CNY） |
| `价格类型` | boolean | 价格类型标记（true/false，具体语义待确认） |

### 请求示例

```
GET https://spider.xxklf.com/taskresult/api/TaskResult/GetList?PageSize=1&CurrentPage=1
```

按航线+日期+航司过滤：

```
GET https://spider.xxklf.com/taskresult/api/TaskResult/GetList?depAirPort=NKG&arrAirPort=CGQ&depDate=2026-09-20T00:00:00&carrier=HO&PageSize=10&CurrentPage=1
```

### 响应结构

```json
{
  "Content": {
    "Total": 316337,
    "List": [ Ticket, Ticket, ... ]
  }
}
```

### Ticket 对象字段

| 字段名 | 类型 | 说明 |
|---|---|---|
| `Ticket_ID` | string | 唯一标识，格式：`航班号\|出发\|到达\|时间戳\|来源` |
| `Data_ID` | string | 数据 ID（GUID） |
| `SearchKey` | string | 搜索键，格式：`出发\|到达\|时间戳` |
| `H航班号_去0` | string | 去程航班号 |
| `C出发日期` | long | 出发日期（Unix 秒时间戳） |
| `C出发时间_Date` | string | 出发时间，如 `2026-09-20 10:40:00` |
| `D到达时间_Date` | string | 到达时间 |
| `S数据获取时间_Date` | string | 数据采集时间 |
| `C成人总票价_CNY` | decimal | 成人总票价（含税/费） |
| `C成人净票价_CNY` | decimal | 成人净票价 |
| `承运航司` | string | 承运航司二字码 |
| `套餐索引` | int | 选中的套餐序号 |
| `套餐信息` | array | 套餐列表，见下 |
| `分段信息` | array | 航段列表，见下 |
| `行李信息` | array | 行李列表，见下 |
| `退改规则` | object | 退改签规则映射 |

#### 套餐信息 `Ticket_套餐信息Model`

| 字段 | 类型 | 说明 |
|---|---|---|
| `套餐索引` | int32 | 套餐序号 |
| `套餐价格` | double | 成人价格 |
| `儿童套餐价格` | double? | 儿童价格 |
| `套餐行李` | int32 | 行李件数 |
| `行李信息` | array | 行李明细 |
| `座位数` | int32 | 剩余座位 |
| `舱位` | string | 如 `T` |
| `舱等` | string | 如 `Y` |
| `退改规则` | object | 退改规则（航司为 key） |

#### 分段信息 `Ticket_分段信息Model`

| 字段 | 类型 | 说明 |
|---|---|---|
| `air` | string | 航司二字码 |
| `fn` | string | 航班号 |
| `dp` | string | 出发机场 |
| `dt` | string | 出发时间 `yyyyMMddHHmm` |
| `ap` | string | 到达机场 |
| `at` | string | 到达时间 |
| `do` | boolean | 是否国内 |
| `tr` | boolean | 是否中转 |
| `c` | string | 舱位 |
| `ms` | int32 | 座位数 |

#### 行李信息 `Ticket_行李信息Model`

| 字段 | 类型 | 说明 |
|---|---|---|
| `重量` | int32 | 重量（kg） |
| `长` / `宽` / `高` | double? | 尺寸 |
| `类型` | int32 | 行李类型枚举（1=手提, 2=托运 等） |

### 响应示例（节选）

```json
{
  "Content": {
    "Total": 316337,
    "List": [
      {
        "H航班号_去0": "HO1729",
        "C出发日期": 1789833600,
        "C出发时间_Date": "2026-09-20 10:40:00",
        "D到达时间_Date": "2026-09-20 13:25:00",
        "S数据获取时间_Date": "2026-08-28 13:30:47",
        "Ticket_ID": "HO1729|NKG|CGQ|1789833600|爬虫",
        "Data_ID": "80DE334F60E414C40195596AA6B48632",
        "SearchKey": "NKG|CGQ|1789833600",
        "套餐信息": [
          {
            "套餐索引": 1,
            "套餐价格": 760.0,
            "儿童套餐价格": null,
            "套餐行李": 0,
            "行李信息": [
              {"重量": 5, "长": null, "宽": null, "高": null, "类型": 1},
              {"重量": 20, "长": null, "宽": null, "高": null, "类型": 2}
            ],
            "座位数": 10,
            "舱位": "T",
            "舱等": "Y",
            "退改规则": null
          }
        ],
        "分段信息": [
          {
            "air": "HO", "fn": "HO1729",
            "dp": "NKG", "dt": "202609201040",
            "ap": "CGQ", "at": "202609201325",
            "do": false, "tr": false,
            "c": "T", "ms": 10
          }
        ],
        "行李信息": [
          {"重量": 5, "长": null, "宽": null, "高": null, "类型": 1},
          {"重量": 20, "长": null, "宽": null, "高": null, "类型": 2}
        ],
        "退改规则": {},
        "套餐索引": 0,
        "C成人总票价_CNY": 760.00,
        "C成人净票价_CNY": 640.00,
        "承运航司": "HO"
      }
    ]
  }
}
```

---

## 接口二：Search — 批量条件搜索

### 基本信息

| 项 | 值 |
|---|---|
| 路径 | `POST /api/TaskResult/Search` |
| 完整 URL | `https://spider.xxklf.com/taskresult/api/TaskResult/Search` |
| 方法 | POST |
| 认证 | 无 |
| Content-Type | `application/json; charset=utf-8` |
| 用途 | 按航线+日期组合批量搜索机票，支持多组条件一次提交 |

### 请求参数

#### Query 参数

| 参数名 | 类型 | 说明 |
|---|---|---|
| `format` | enum(int) | 响应格式，见下方枚举表。不传时默认返回 JSON |

#### `format` 枚举 `ESearchResultFormat`

| 值 | 格式 | 说明 |
|---|---|---|
| 0 | — | **返回空 body**，疑似服务端 bug，**不要使用** |
| 1 | JSON | 返回 `{"Content":{"Total":N,"List":[...]}}`，中文 `\uXXXX` 转义，结构与 GetList 一致（**推荐**） |
| 2 | MessagePack | 二进制格式（`application/octet-stream`），需要 MessagePack 解码器 |
| 3 | 管道分隔文本 | `HO1729\|NKG\|CGQ\|1789833600\|爬虫\|T\|0\|760\|...`，UTF-8 编码但 Content-Type 不带 charset |
| 不传 | JSON | 效果同 format=1 |

#### 请求体（Body）

类型：`TicketSearchDto` 数组（JSON Array），支持一次提交多组搜索条件。

##### `TicketSearchDto` 字段（属性名为中文，`additionalProperties: false`）

| 属性名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `起飞日期` | date-time(string) | 是 | 起飞日期，如 `2026-09-20T00:00:00` |
| `出发机场` | string[] | 是 | 出发机场三字码数组，如 `["NKG"]` |
| `到达机场` | string[] | 是 | 到达机场三字码数组，如 `["CGQ"]` |
| `仓等组合` | string[] | 否 | 舱等筛选，如 `["Y"]`（经济舱） |

> **实测约束**：
> - 只传 `起飞日期` 不传机场 → **400 Bad Request**
> - 只传机场不传 `起飞日期` → **500 Internal Server Error**
> - 必须同时提供 `起飞日期` + `出发机场` + `到达机场`，`仓等组合` 可选

### 请求示例

#### 单组搜索

```http
POST https://spider.xxklf.com/taskresult/api/TaskResult/Search?format=1
Content-Type: application/json; charset=utf-8

[
  {
    "起飞日期": "2026-09-20T00:00:00",
    "出发机场": ["NKG"],
    "到达机场": ["CGQ"],
    "仓等组合": ["Y"]
  }
]
```

#### 多组批量搜索

```http
POST https://spider.xxklf.com/taskresult/api/TaskResult/Search?format=1
Content-Type: application/json; charset=utf-8

[
  {"起飞日期": "2026-09-20T00:00:00", "出发机场": ["NKG"], "到达机场": ["CGQ"]},
  {"起飞日期": "2026-09-20T00:00:00", "出发机场": ["PEK"], "到达机场": ["SHA"]},
  {"起飞日期": "2026-09-21T00:00:00", "出发机场": ["CAN"], "到达机场": ["HGH"], "仓等组合": ["Y"]}
]
```

### 响应结构

#### format=1 / 不传（JSON）

```json
{
  "Content": {
    "Total": 1,
    "List": [ Ticket, ... ]
  }
}
```

`List` 中的 Ticket 对象结构与 GetList 完全一致，参见上方 Ticket 对象字段表。

#### format=2（MessagePack 二进制）

`Content-Type: application/octet-stream`，需使用 MessagePack 解码器解析。二进制头部可见航班号、机场码等 ASCII 字符内嵌。

#### format=3（管道分隔文本）

```
HO1729|NKG|CGQ|1789833600|爬虫|T|0|760|120|640|...
```

字段顺序（按实测推断）：

| 位置 | 字段 |
|---|---|
| 0 | 航班号 |
| 1 | 出发机场 |
| 2 | 到达机场 |
| 3 | 出发日期时间戳 |
| 4 | 数据来源 |
| 5 | 舱位 |
| 6 | 套餐索引 |
| 7 | 成人总票价 |
| 8 | 税费 |
| 9 | 成人净票价 |
| ... | 后续字段（含 JSON 格式的分段信息等） |

---

## 使用建议

| 场景 | 推荐接口 | 说明 |
|---|---|---|
| 浏览全量数据 / 分页查看 | GetList | 支持分页，参数灵活 |
| 按指定航线+日期精确查询 | Search(format=1) | 支持批量多组条件，返回 JSON |
| 最小传输量场景 | Search(format=2) | MessagePack 二进制，需额外解码库 |
| 快速文本预览 | Search(format=3) | 管道分隔，注意强制 UTF-8 解码 |

### 注意事项

1. **路径前缀**：所有请求必须带 `/taskresult` 前缀
2. **UTF-8 编码**：POST 请求体必须 UTF-8，否则中文属性名无法被服务端识别，返回 400
3. **format=0 不可用**：返回空 body，不要使用
4. **format=3 charset 问题**：响应 Content-Type 不带 charset，客户端可能按 Latin-1 解码导致中文乱码，需强制 UTF-8
5. **Search 必填字段**：`起飞日期`、`出发机场`、`到达机场` 三者缺一不可，否则 400/500
6. **无速率限制声明**：Swagger 未声明限流策略，但生产环境建议自行控制调用频率
