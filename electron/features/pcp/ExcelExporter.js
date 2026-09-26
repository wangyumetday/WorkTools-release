// Excel 导出器
// 职责：把 a3 最终数据导出为 xlsx
//   - 系统导入文件：每 O 平台一份，按 adapter.exportTemplate.columns 决定列序
//   - 「底价检查」人看合并文件：跨平台底价对照
//
// 依赖：
//   - fileManager：取 a3 数据（this.fileManager.a3）
//   - registry：取平台 adapter.exportTemplate + displayName（平台中文名）
//   - XLSX（xlsx 库）：读写 xlsx
//
// 由 FileManager 在构造时实例化，FileManager.exportResult 代理给它，
//   保证 controller.js / pipeline.js 等外部调用方接口不变。

import fs from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import * as registry from './platforms/registry.js'
import { O_PLATFORM_KEYS as O_PLATFORMS } from './platforms/registry.js'
import { A3_FIELDS } from './fieldNames.js'
import { formatPolicyAdjust } from './policyAdjust.js'
import { keepPolicyRow, applyPolicyWriteback } from './policyWriteback.js'

// 「底价检查」人看文件需要保留的原始字段（附加在 a3 每行上）
//   exportResult 只按 template.columns 的 key 导列，这些附加字段不会被写进系统导入文件
export const HR_FIELDS = [
  A3_FIELDS.H航班号, A3_FIELDS.C舱位, A3_FIELDS.C成人总票价_CNY, A3_FIELDS.XC_dijia, A3_FIELDS.CUT_VALUE,
  A3_FIELDS.C出发机场, A3_FIELDS.D到达机场, A3_FIELDS.C出发城市, A3_FIELDS.D到达城市, A3_FIELDS.H航司名,
  A3_FIELDS.C出发时间_Date, A3_FIELDS.D到达时间_Date, A3_FIELDS.仓等, A3_FIELDS.isOwn,
  // 套餐索引：仅套餐政策行有值（底价检查文件「套餐索引」列；主行参与开启的主行行留空）
  A3_FIELDS.套餐索引
]

/** 平台中文名（用于导出文件名和底价列名），未注册/未定义时回退为大写 key */
function platformDisplayName(p) {
  try {
    const adapter = registry.get(p)
    return adapter?.displayName || String(p).toUpperCase()
  } catch {
    return String(p).toUpperCase()
  }
}

/** 导出文件名用日期戳：YYYY-MM-DD（示例：携程导入政策2026-08-21.xlsx） */
function dateStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 「底价检查」预计减价列的展示值：与政策导入文件「调价固定加减钱」同值（policyAdjust.js）
 *   计算阶段保留精确价差，此处统一「向下取整再 − cutOffset」（cutOffset 取本平台配置，默认 1）；
 *   非数字/缺失原样透传
 */
const roundForDisplay = formatPolicyAdjust

/**
 * 「底价检查」携程减价比例列：100 − (携程价 / 官网价 × 100)，保留 2 位小数（数值，无 % 号）
 *   携程价/官网价任一缺失、非数字或非正数 → null（列留空，避免除零）
 */
function cutRatePct(xcPrice, gwPrice) {
  const x = Number(xcPrice)
  const gRaw = Number(gwPrice)
  if (!Number.isFinite(x) || !Number.isFinite(gRaw) || x <= 0 || gRaw <= 0) return null
  const g = Math.ceil(gRaw) // ★ 官网价先向上取整再参与计算（1950.12→1951；整数不变）
  return Math.round((100 - (x / g) * 100) * 100) / 100
}

/**
 * 「底价检查」-2%后的减价数值列：携程价 − 官网价 × 0.98，保留 2 位小数（数值）
 *   官网价先向上取整再参与计算；携程价/官网价任一缺失、非数字或非正数 → null（列留空）
 */
function cutValueMinus2Pct(xcPrice, gwPrice) {
  const x = Number(xcPrice)
  const gRaw = Number(gwPrice)
  if (!Number.isFinite(x) || !Number.isFinite(gRaw) || x <= 0 || gRaw <= 0) return null
  const g = Math.ceil(gRaw) // ★ 官网价先向上取整再参与计算（1950.12→1951；整数不变）
  return Math.round((x - g * 0.98) * 100) / 100
}

/**
 * 「底价检查」预计减价列（2026-09-23 起）：官网价先「向上取整」（1950.12→1951；整数不变），
 *   再算价差 = 携程价 − 取整后官网价，走 policyAdjust 的「向下取整再 − cutOffset」口径
 *   （cutOffset = 本平台配置「比携程低多少元」，默认 1）；
 *   任一缺失/非数字/非正数 → null（列留空）
 */
function expectedCut(xcPrice, gwPrice, offset) {
  const x = Number(xcPrice)
  const gRaw = Number(gwPrice)
  if (!Number.isFinite(x) || !Number.isFinite(gRaw) || x <= 0 || gRaw <= 0) return null
  return roundForDisplay(x - Math.ceil(gRaw), offset)
}

/**
 * 底价命中公式文本：与前端 TaskList 调试标签 formatFloorMeta 输出一致
 *   range   → 「区间 [500,700] cost*0.48」
 *   global  → 「全局 cost*0.2」
 *   fallback→ 「降级 原价」
 *   缺失/格式错误 → 空字符串
 */
function formatFloorMeta(meta) {
  if (!meta || typeof meta !== 'object') return ''
  const type = String(meta.formulaType || '?')
  let typeLabel = ''
  if (type === 'range') typeLabel = '区间'
  else if (type === 'global') typeLabel = '全局'
  else if (type === 'fallback') typeLabel = '降级'
  else typeLabel = type
  const rangeStr = Array.isArray(meta.rangeHit) && meta.rangeHit.length === 2
    ? `[${meta.rangeHit[0]},${meta.rangeHit[1]}] `
    : ''
  const isFallbackCost = String(meta.formulaStr || '') === 'cost' && type === 'fallback'
  const formulaStr = isFallbackCost ? '原价' : (String(meta.formulaStr || '?'))
  return `${typeLabel} ${rangeStr}${formulaStr}`.trim()
}

/**
 * xlsx sheet 所有单元格 水平垂直居中 + 行背景色 + 列宽
 *   - 遍历 !ref 范围内所有单元格，设置 alignment + fill（根据 rowBgColors）
 *   - 无 !ref（空 sheet）时跳过
 *   - rowBgColors：与数据行对齐的数组，row 0 是表头不算
 *     true → 浅绿 C6EFCE / false → 浅红 FFC7CE / null → 不着色
 */
function centerSheetCells(ws, rowBgColors = []) {
  if (!ws || !ws['!ref']) return
  const range = XLSX.utils.decode_range(ws['!ref'])
  for (let R = range.s.r; R <= range.e.r; R++) {
    // 行背景色：跳过表头行（R=0），数据行从 R=1 开始，对应 rowBgColors[R-1]
    const bgVal = R > 0 ? rowBgColors[R - 1] : null
    const fgColor = bgVal == null ? null : (bgVal ? 'C6EFCE' : 'FFC7CE')
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C })
      const cell = ws[addr]
      if (!cell) continue
      const baseStyle = (cell.s && typeof cell.s === 'object') ? cell.s : {}
      if (fgColor) {
        baseStyle.fill = { patternType: 'solid', fgColor: { rgb: fgColor } }
      }
      cell.s = {
        ...baseStyle,
        alignment: {
          horizontal: 'center',
          vertical: 'center',
          wrapText: true
        }
      }
    }
  }
  // 列宽：兜底稍微宽一点，避免中文列被挤成 ###（14px 字体大概 8~16 字符）
  const colCount = Math.max(1, range.e.c - range.s.c + 1)
  ws['!cols'] = new Array(colCount).fill(null).map(() => ({ wch: 14 }))
}

/**
 * Excel 导出器
 *   - 由 FileManager 实例化并注入（fileManager 提供 a3 数据访问）
 *   - registry 直接 import（与 fileManager 同款用法），无需注入
 */
export class ExcelExporter {
  /**
   * @param {object} fileManager FileManager 实例（取 a3 数据 + 复用其 a3 数组）
   */
  constructor(fileManager) {
    this.fileManager = fileManager
  }

  /**
   * 导出文件名航司前缀（2026-09-23 起）：政策导入/底价检查文件统一「航司-」前缀（如 XQ-）
   *   取 a1 首行 hangsi 大写；缺失 → 空串（无前缀，不报错）
   */
  _airlinePrefix() {
    const a1Data = this.fileManager?.getA1?.()?.data || []
    const al = String(a1Data[0]?.hangsi || '').trim().toUpperCase()
    return al ? `${al}-` : ''
  }

  /**
   * 本平台「比携程低多少元」cutOffset（航司私有化：从当前文件航司配置取）
   *   仅 trip 平台可配；其余平台/航司未配置/取失败 → undefined（期望行为：formatPolicyAdjust 回退默认 1）
   */
  _airlineCutOffset(p) {
    const fm = this.fileManager
    const hangsi = String(fm?.a1?.[0]?.hangsi || '').trim()
    if (!hangsi || !fm?.configManager) return undefined
    try {
      return fm.configManager.getAirlineConfig(hangsi).platform?.[p]?.cutOffset
    } catch {
      return undefined
    }
  }

  /**
   * 同名文件序号递增（不无限套娃）
   *   - result.xlsx 存在 → result (1).xlsx
   *   - result (1).xlsx 也存在 → result (2).xlsx（不会变成 result (1) (1).xlsx）
   *   - result (2).xlsx 也存在 → result (3).xlsx ...
   *
   * 实现要点：先剥出原始 basename（去掉已有的 " (n)" 后缀），从最大序号+1 开始递增试探。
   */
  getUniqueFilePath(dir, filename) {
    const ext = path.extname(filename)              // .xlsx
    const basename = path.basename(filename, ext)  // result 或 result (1)
    const fullPath = path.join(dir, filename)

    // 不存在直接用原文件名
    if (!fs.existsSync(fullPath)) return fullPath

    // 检测 basename 是否已是 "name (n)" 形式：是则提取原始 name + 起始序号
    let realBase = basename
    let startSeq = 1
    const match = basename.match(/^(.+?)\s*\((\d+)\)$/)
    if (match) {
      realBase = match[1]
      startSeq = parseInt(match[2], 10) + 1
    }

    // 从起始序号开始递增试探，最多 1000 次兜底防爆
    let seq = startSeq
    for (let i = 0; i < 1000; i++) {
      const candidate = path.join(dir, `${realBase} (${seq})${ext}`)
      if (!fs.existsSync(candidate)) return candidate
      seq++
    }
    // 兜底：极不可能走到这里，加时间戳保证唯一
    return path.join(dir, `${realBase} (${Date.now()})${ext}`)
  }

  /** 构造带序号的路径：seq=0 无括号，seq>0 加 (seq) */
  _pathWithSeq(dir, base, ext, seq) {
    const name = seq === 0 ? `${base}${ext}` : `${base} (${seq})${ext}`
    return path.join(dir, name)
  }

  /** 返回使所有 base 都不冲突的最小序号（统一序号，保证多个文件序号一致） */
  _uniqueSeqForAll(dir, bases, ext) {
    for (let seq = 0; seq < 1000; seq++) {
      if (bases.every(b => !fs.existsSync(this._pathWithSeq(dir, b, ext, seq)))) return seq
    }
    return Date.now()
  }

  /**
   * 导出 a3 最终数据（阶段4：每 O 平台一个系统导入 xlsx + 每个有数据的平台一份「底价检查」人看 xlsx）
   *   - a3 每行带 _platform 标签 → 按 _platform 分组
   *   - 系统导入文件仅导出 won 行（调价打到携程底价-1）；lost 行不贴底价卖、不导出；底价检查文件全量导出（主行 + 套餐子行，含 lost）
   *   - 每组用该平台 adapter.exportTemplate.columns 决定列顺序
   *     （_platform 与 HR_FIELDS 附加列不写入系统导入文件）
   *   - 嵌套对象扁平化为 JSON 字符串，避免 Excel 显示成 [object Object]
   *   - 系统导入文件命名：{平台中文名}导入政策{日期}.xlsx（如 携程导入政策2026-08-21.xlsx）
   *   - 人看文件命名：{平台中文名}底价检查{日期}.xlsx（如 携程底价检查2026-08-21.xlsx）
   *   - 同名序号递增：携程导入政策2026-08-21.xlsx 存在 → 携程导入政策2026-08-21 (1).xlsx
   *   - 进度推送：0 → 每平台写完按比例推进 → 100
   *   - 返回 { success, files: [{path, filename, platform, count}], dir }
   *
   * @param {string} dir                   下载目录
   * @param {string} _filename             已废弃（每个平台独立命名；仅保留形参兼容老调用方）
   * @param {(n:number)=>void} onProgress  进度回调 0→90→100（-1 = 失败）
   * @param {{ platformsToInclude?: string[], skipPolicyWriteback?: boolean }} opts
   *   platformsToInclude：即使 a3 中该平台 0 条数据，也生成"仅表头"的系统导入文件。
   *     用于 O 平台真的跑成功了但恰好没匹配到底价政策、0 结果也应该允许下载的场景。
   *   skipPolicyWriteback：跳过政策回写（走旧模式，输出 ID/CreateTime 为空的新增类型文件）。
   *     用于政策文件读取失败后，用户在选项框里选了"直接输出"的场景。
   */
  async exportResult(dir, _filename = 'result.xlsx', onProgress = () => { }, opts = {}) {
    try {
      onProgress(0)
      const dateStr = dateStamp()
      const airlinePrefix = this._airlinePrefix()
      const { platformsToInclude = [], skipPolicyWriteback = false } = opts

      // 按 _platform 分组（兼容老 a3：无 _platform 的行归到 trip）
      const groups = {}
      for (const row of this.fileManager.a3) {
        const p = row?.[A3_FIELDS._platform] || 'trip'
        if (!groups[p]) groups[p] = []
        groups[p].push(row)
      }

      // ★ 新增：把显式要求包含的平台补进 groups（空数组 = 只出表头）
      for (const p of platformsToInclude) {
        if (!groups[p]) groups[p] = []
      }

      const platformKeys = Object.keys(groups)
      if (platformKeys.length === 0) {
        return { success: false, error: '没有可导出的平台数据' }
      }

      // ★ 2026-09-25 政策回写（惰性加载）：若已记录政策文件路径且本次要导出 trip，
      //   此处读盘解析一次（上传时未解析、未驻留内存，故与 clearAll 无关）。
      //   读取失败不中止导出：回 code=POLICY_READ_FAILED 给渲染层 → 弹选项框
      //   （① 重选一个正确的文件 ② 直接输出 ID/CreateTime 为空的新增类型文件）
      let tripPolicy = null
      if (!skipPolicyWriteback && platformKeys.includes('trip') && this.fileManager.hasPolicyFilePath()) {
        const policyPath = this.fileManager.getPolicyFilePath()
        const readResult = this.fileManager.readPolicyFile(policyPath)
        if (!readResult.success) {
          // 注意：此处不推 -1 —— 这不是"下载失败"，而是要求用户决策；
          //   渲染层收到本 code 后会复位按钮进度并弹选项框（若推 -1 会让按钮先闪红再弹框，语义冲突）
          return {
            success: false,
            code: 'POLICY_READ_FAILED',
            policyPath,
            error: `政策回写文件读取失败：${readResult.error}`
          }
        }
        tripPolicy = readResult
      }

      // ★ 统一序号：政策导入文件 + 每个有数据平台的底价检查文件用相同序号（取使所有文件都不冲突的最小序号）
      const bases = platformKeys.map(p => `${airlinePrefix}${platformDisplayName(p)}导入政策${dateStr}`)
      for (const p of platformKeys) {
        if ((groups[p] || []).length > 0) {
          bases.push(`${airlinePrefix}${platformDisplayName(p)}底价检查${dateStr}`)
        }
      }
      const unifiedSeq = this._uniqueSeqForAll(dir, bases, '.xlsx')

      const files = []
      for (let i = 0; i < platformKeys.length; i++) {
        const p = platformKeys[i]
        // 导入政策文件仅导出 won 行（调价打到携程底价 − cutOffset，cutOffset 见平台配置「比携程低多少元」）；lost 行（比输）不贴底价卖，
        //   不出现在政策导入文件，只在底价检查文件展示
        //   老 a3 无 _outcome 标记的数据视为胜出，兼容已持久化数据
        // ★ 2026-09-24 起：政策导入文件只输出「航程类型=单程」的政策行（多程不写；底价检查文件保留多程）
        const rows = groups[p].filter(r => keepPolicyRow(r, A3_FIELDS._outcome))

        // 取该平台 exportTemplate.columns 决定列顺序；无模板则用行自身键序
        let template = null
        try { template = registry.get(p)?.exportTemplate || null } catch { template = null }
        const columns = (template && Array.isArray(template.columns)) ? template.columns : null

        // 扁平化 + 按 columns 顺序重建行（_platform 和 HR_FIELDS 附加列不写入）
        const flatData = rows.map(item => {
          const flat = {}
          if (columns) {
            for (const col of columns) {
              const v = item[col.key]
              flat[col.key] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v
            }
          } else {
            for (const key of Object.keys(item)) {
              if (key === A3_FIELDS._platform || key === A3_FIELDS._outcome || HR_FIELDS.includes(key)) continue
              const v = item[key]
              flat[key] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v
            }
          }
          return flat
        })

        // ★ 0 行数据 + 有 columns 模板时：仅写表头行（否则 json_to_sheet([]) 出的表连列名都没有）
        let worksheet
        let outCount
        // ★ 2026-09-24 政策回写：已上传外部政策文件 → 生成政策与用户文件逐条匹配，
        //   输出 = 用户文件行（命中行删除）+ 我方更新/新增行追加末尾（保留用户表头与列序）
        if (p === 'trip' && tripPolicy) {
          const wb = applyPolicyWriteback(flatData, tripPolicy)
          worksheet = XLSX.utils.aoa_to_sheet([tripPolicy.headers, ...wb.finalRows])
          outCount = wb.finalRows.length
        } else if (flatData.length === 0 && columns) {
          const headerRow = columns.map(col => col.title || col.label || col.key)
          worksheet = XLSX.utils.aoa_to_sheet([headerRow])
          outCount = 0
        } else {
          worksheet = XLSX.utils.json_to_sheet(flatData)
          outCount = rows.length
        }
        // 系统导入文件：所有单元格水平垂直居中显示
        centerSheetCells(worksheet)
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, p)

        // 系统导入文件名：{航司-}{平台中文名}导入政策{日期}.xlsx（如 XQ-携程导入政策2026-08-21.xlsx）
        const finalPath = this._pathWithSeq(dir, `${airlinePrefix}${platformDisplayName(p)}导入政策${dateStr}`, '.xlsx', unifiedSeq)
        XLSX.writeFile(workbook, finalPath)
        files.push({ path: finalPath, filename: path.basename(finalPath), platform: p, count: outCount })

        // 每平台完成后按比例推进进度（留 10% 给最终 100）
        onProgress(Math.round(((i + 1) / platformKeys.length) * 90))
      }

      // ===== 生成「底价检查」人看文件：每个有数据的平台独立一份（失败不影响系统导入文件） =====
      const humanFiles = await this.buildHumanReadableFiles(dir, dateStr, unifiedSeq)
      for (const hf of humanFiles) files.push(hf)

      onProgress(100)
      return { success: true, files, dir }
    } catch (error) {
      onProgress(-1) // -1 表示出错，前端据此恢复按钮
      return { success: false, error: error.message }
    }
  }

  /**
   * 生成「底价检查」人看文件（2026-09-26 重构：每锦绣单元 = 官网行 + 全部匹配携程行）
   *   - trip 平台基于完整 quoteRows（官网行 role=official + 携程行 role=ctrip + 附加行 role=other）出文件
   *   - 官网行：锦绣字段全填，浅蓝背景；携程行：携程该报价自己的航班/城市/时间/舱位，无底色
   *   - 官网价/携程价合一列（官网行=官网价、携程行=携程价）；isOwn/showState 原样输出
   *   - 预计减价/减价比例/-2%数值 由「携程价 vs 所属官网价」计算，缺失或非正数 → 留空（不兜底）
   */
  async buildHumanReadableFiles(dir, dateStr, seq = null) {
    const out = []
    try {
      // 1. 按平台分组（按标准 O 平台顺序出文件，顺序稳定）
      const groups = {}
      for (const row of this.fileManager.a3) {
        const p = row?.[A3_FIELDS._platform] || 'trip'
        if (!groups[p]) groups[p] = []
        groups[p].push(row)
      }

      // 2. 每个有数据的平台独立生成一份
      for (const p of O_PLATFORMS) {
        const rows = groups[p] || []
        // trip：底价检查改由完整 quoteRows（官网行+携程行）驱动；有对比行即生成，不限 a3 政策行数
        const hasTripData = p === 'trip' && Array.isArray(this.fileManager?.tripQuoteRows) && this.fileManager.tripQuoteRows.length > 0
        if (rows.length === 0 && !hasTripData) continue
        const file = await this._buildHumanFileForPlatform(p, rows, dir, dateStr, seq)
        if (file) out.push(file)
      }
    } catch (error) {
      // 人看文件是附加产物，失败不影响系统导入文件
      console.warn(`[buildHumanReadableFiles] 底价检查文件生成失败：${error.message}`)
    }
    return out
  }

  /** 单个平台的底价检查文件：按模板列组装主行 + 套餐子行 */
  async _buildHumanFileForPlatform(p, rows, dir, dateStr, seq) {
    const pName = platformDisplayName(p)
    // 本平台「比携程低多少元」配置（航司私有化：从当前文件航司配置取；其余平台无此项 → 回退默认 1）
    const cutOffset = this._airlineCutOffset(p)
    // 新表头（2026-09-26 起）：每锦绣单元 = 官网行 + 全部匹配携程行；官网价/携程价合一列；showState/isOwn 原样
    const header = [
      '航班号', '舱位', '套餐索引', '出发机场', '到达机场', '官网价/携程价', '行李额',
      '出发城市', '到达城市', '航司名', '出发时间', '到达时间', '仓等',
      'isOwn', 'showState', '预计减价', '携程减价比例(%)', '-2%后的减价数值(元)', '底价公式命中'
    ]
    const outRows = []
    const rowBgColors = [] // 与 outRows 对齐：官网行='E2ECFF'（浅蓝）；携程行/附加行=null（无颜色）

    // 数据源：trip 用完整 quoteRows（官网行 role=official + 携程行 role=ctrip + 附加行 role=other）
    const quoteRows = (p === 'trip' && Array.isArray(this.fileManager?.tripQuoteRows))
      ? this.fileManager.tripQuoteRows
      : null

    // 「—」是 UI 占位符，非真实值 → 导出时转空（如实：取不到就空）
    const v = (x) => (x == null || x === '—' ? '' : x)

    if (quoteRows) {
      // 先按 unitKey 建官网价索引：携程行算「预计减价/比例」要用到所属官网行的官网价
      const gwByUnit = new Map()
      for (const q of quoteRows) {
        if (q?.role === 'official') gwByUnit.set(q.unitKey, q.ourPrice ?? null)
      }
      for (const q of quoteRows) {
        if (!q) continue
        if (q.role === 'official') {
          outRows.push({
            '航班号': v(q.flightNo), '舱位': v(q.seatClass), '套餐索引': v(q.pkgIndex),
            '出发机场': v(q.depAirport), '到达机场': v(q.arrAirport),
            '官网价/携程价': (q.ourPrice == null ? '' : q.ourPrice),
            '行李额': v(q.ourBaggageShort),
            '出发城市': v(q.depCity), '到达城市': v(q.arrCity), '航司名': v(q.airlineName),
            '出发时间': v(q.depTime), '到达时间': v(q.arrTime), '仓等': v(q.cabinClass),
            'isOwn': '', 'showState': '',
            '预计减价': '', '携程减价比例(%)': '', '-2%后的减价数值(元)': '',
            '底价公式命中': formatFloorMeta(q.floorMeta)
          })
          rowBgColors.push('E2ECFF') // 官网行浅蓝
        } else {
          // 携程行（role=ctrip）或附加行（role=other）：用该条携程报价自己的航班/城市/时间/舱位
          const gw = gwByUnit.get(q.unitKey) ?? null
          outRows.push({
            '航班号': v(q.xcFlightNo), '舱位': v(q.xcSeatClass), '套餐索引': '',
            '出发机场': v(q.xcDepAirport), '到达机场': v(q.xcArrAirport),
            '官网价/携程价': (q.xcPrice == null ? '' : q.xcPrice),
            '行李额': v(q.xcBaggageShort),
            '出发城市': v(q.xcDepCity), '到达城市': v(q.xcArrCity), '航司名': '',
            '出发时间': v(q.xcTakeOffDateTime), '到达时间': v(q.xcArriveDateTime), '仓等': '',
            'isOwn': q.isOwn ? q.isOwn : '',  // 原始 isOwn（布尔）
            'showState': (q.showState == null ? '' : q.showState),
            '预计减价': expectedCut(q.xcPrice, gw, cutOffset),
            '携程减价比例(%)': cutRatePct(q.xcPrice, gw),
            '-2%后的减价数值(元)': cutValueMinus2Pct(q.xcPrice, gw),
            '底价公式命中': ''
          })
          rowBgColors.push(null) // 携程行无颜色
        }
      }
    }

    // 写 xlsx：{航司-}{平台中文名}底价检查{日期}.xlsx（如 XQ-携程底价检查2026-08-28.xlsx）
    //   用 exceljs 生成（支持单元格样式：居中 + 行背景色）
    const finalPath = seq != null
      ? this._pathWithSeq(dir, `${this._airlinePrefix()}${pName}底价检查${dateStr}`, '.xlsx', seq)
      : this.getUniqueFilePath(dir, `${this._airlinePrefix()}${pName}底价检查${dateStr}.xlsx`)

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('底价检查')
    // 表头行
    ws.columns = header.map(h => ({ header: h, key: h, width: 14 }))
    // 数据行
    for (let i = 0; i < outRows.length; i++) {
      const row = ws.addRow(outRows[i])
      const bgColor = rowBgColors[i]
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { horizontal: 'center', vertical: 'center', wrapText: true }
        if (bgColor) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgColor } }
        }
      })
    }
    // 表头行样式
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { horizontal: 'center', vertical: 'center', wrapText: true }
    })

    await wb.xlsx.writeFile(finalPath)
    return { path: finalPath, filename: path.basename(finalPath), platform: `${pName}底价检查`, count: outRows.length }
  }
}
