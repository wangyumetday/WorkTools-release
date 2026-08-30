// ============================================================
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
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import * as registry from './platforms/registry.js'
import { O_PLATFORM_KEYS as O_PLATFORMS } from './platforms/registry.js'
import { A3_FIELDS } from './fieldNames.js'

// 「底价检查」人看文件需要保留的原始字段（附加在 a3 每行上）
//   exportResult 只按 template.columns 的 key 导列，这些附加字段不会被写进系统导入文件
export const HR_FIELDS = [
  A3_FIELDS.H航班号, A3_FIELDS.C舱位, A3_FIELDS.C成人总票价_CNY, A3_FIELDS.XC_dijia, A3_FIELDS.CUT_VALUE,
  A3_FIELDS.C出发机场, A3_FIELDS.D到达机场, A3_FIELDS.C出发城市, A3_FIELDS.D到达城市, A3_FIELDS.H航司名,
  A3_FIELDS.C出发时间_Date, A3_FIELDS.D到达时间_Date, A3_FIELDS.仓等, A3_FIELDS.isOwn
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
 * 「底价检查」预计减价列的展示值：四舍五入成整数（-24.14 → -24），非数字/缺失 → 空字符串
 */
function roundForDisplay(v) {
  if (v == null || v === '') return ''
  const n = Number(v)
  return Number.isNaN(n) ? '' : Math.round(n)
}

/**
 * 「底价检查」行李额列（只展示托运部分，手提不展示）：
 *   汇总 行李信息 里「托运」条目的重量总和 → 托运：20kg / 托运：0
 *   非数组或没有托运条目 → 托运：0
 */
function formatBaggageText(list) {
  if (!Array.isArray(list) || list.length === 0) return '托运：0'
  let kg = 0
  for (const x of list) {
    if (x && x['类型'] == '2' && x['重量'] != null) {
      const w = Number(x['重量'])
      if (!Number.isNaN(w)) kg += w
    }
  }
  return kg > 0 ? `托运：${kg}kg` : '托运：0'
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
   *   - 系统导入文件只导出比价胜出的行（_outcome !== 'lost'）；底价检查文件全量导出（主行 + 套餐子行）
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
   * @param {{ platformsToInclude?: string[] }} opts
   *   platformsToInclude：即使 a3 中该平台 0 条数据，也生成"仅表头"的系统导入文件。
   *     用于 O 平台真的跑成功了但恰好没匹配到底价政策、0 结果也应该允许下载的场景。
   */
  async exportResult(dir, _filename = 'result.xlsx', onProgress = () => { }, opts = {}) {
    try {
      onProgress(0)
      const dateStr = dateStamp()
      const { platformsToInclude = [] } = opts

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

      // ★ 统一序号：政策导入文件 + 每个有数据平台的底价检查文件用相同序号（取使所有文件都不冲突的最小序号）
      const bases = platformKeys.map(p => `${platformDisplayName(p)}导入政策${dateStr}`)
      for (const p of platformKeys) {
        if ((groups[p] || []).length > 0) {
          bases.push(`${platformDisplayName(p)}底价检查${dateStr}`)
        }
      }
      const unifiedSeq = this._uniqueSeqForAll(dir, bases, '.xlsx')

      const files = []
      for (let i = 0; i < platformKeys.length; i++) {
        const p = platformKeys[i]
        // 导入政策文件只导出「可以胜出」的行（比输行仅进底价检查文件）
        //   老 a3 无 _outcome 标记的数据视为胜出，兼容已持久化数据
        const rows = groups[p].filter(r => r[A3_FIELDS._outcome] !== 'lost')

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
        if (flatData.length === 0 && columns) {
          const headerRow = columns.map(col => col.title || col.label || col.key)
          worksheet = XLSX.utils.aoa_to_sheet([headerRow])
        } else {
          worksheet = XLSX.utils.json_to_sheet(flatData)
        }
        // 系统导入文件：所有单元格水平垂直居中显示
        centerSheetCells(worksheet)
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, p)

        // 系统导入文件名：{平台中文名}导入政策{日期}.xlsx（如 携程导入政策2026-08-21.xlsx）
        const finalPath = this._pathWithSeq(dir, `${platformDisplayName(p)}导入政策${dateStr}`, '.xlsx', unifiedSeq)
        XLSX.writeFile(workbook, finalPath)
        files.push({ path: finalPath, filename: path.basename(finalPath), platform: p, count: rows.length })

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
   * 生成「底价检查」人看文件（业务模式重构：每平台独立一份，主行 + 套餐子行）
   *   - 每个有 a3 数据的平台各出一份文件：{平台中文名}底价检查{日期}.xlsx
   *   - 行布局（对齐模板 docs/pcp/携程底价检查*.xlsx）：
   *       主行 = 舱位级数据（航班号/舱位/机场/城市/时间/仓等 + 票价/底价/公式/行李额全填）
   *       主行下方紧跟该舱位行的套餐子行（只填 成人总票价_CNY / {平台}底价 / 预计减价 / 底价公式命中 / 行李额）
   *   - 套餐没有匹配到携程价的也列出（携程底价/预计减价留空），其余照写
   *   - 预计减价：主行 = CUT_VALUE（携程底价 - 官网价取整 - 1）；套餐行 = 差值（携程底价 - 官网套餐我方底价 - 1）
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
        if (rows.length === 0) continue
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
    // 表头（对齐模板：主键列 + 本平台底价三列 + 行李额 + 航班详情列尾）
    const header = ['航班号', '舱位', '出发机场', '到达机场', 'isOwn', '成人总票价_CNY',
      `${pName}底价`, '预计减价', '底价公式命中', '行李额',
      '出发城市', '到达城市', '航司名', '出发时间', '到达时间', '仓等']
    // 中文表头 → 行级原始字段（仅主行填充）
    const fieldMap = {
      '航班号': A3_FIELDS.H航班号, '舱位': A3_FIELDS.C舱位,
      '出发机场': A3_FIELDS.C出发机场, '到达机场': A3_FIELDS.D到达机场,
      'isOwn': A3_FIELDS.isOwn,
      '出发城市': A3_FIELDS.C出发城市, '到达城市': A3_FIELDS.D到达城市,
      '航司名': A3_FIELDS.H航司名,
      '出发时间': A3_FIELDS.C出发时间_Date, '到达时间': A3_FIELDS.D到达时间_Date,
      '仓等': A3_FIELDS.仓等
    }
    const outRows = []
    const rowBgColors = [] // 与 outRows 对齐，记录每行背景色（null = 不着色）
    for (const r of rows) {
      // ===== 主行：舱位级数据（本身就是一种"套餐"） =====
      const parent = {}
      for (const h of header) {
        if (fieldMap[h] != null) {
          parent[h] = r[fieldMap[h]]
        } else if (h === '成人总票价_CNY') {
          parent[h] = r[A3_FIELDS.C成人总票价_CNY]
        } else if (h === `${pName}底价`) {
          parent[h] = r[A3_FIELDS.XC_dijia]
        } else if (h === '预计减价') {
          parent[h] = roundForDisplay(r[A3_FIELDS.CUT_VALUE])
        } else if (h === '底价公式命中') {
          parent[h] = formatFloorMeta(r[A3_FIELDS._floorMeta])
        } else if (h === '行李额') {
          parent[h] = formatBaggageText(r['行李信息'])
        } else {
          parent[h] = ''
        }
      }
      outRows.push(parent)
      rowBgColors.push(r[A3_FIELDS.isOwn] ?? null)

      // ===== 套餐子行：主行下方展开，只填 5 列，其余留空 =====
      const taocan = Array.isArray(r['套餐信息']) ? r['套餐信息'] : []
      for (const acai of taocan) {
        if (!acai) continue
        const child = {}
        for (const h of header) child[h] = ''
        child['舱位'] = acai['舱位'] ?? ''
        child['isOwn'] = acai['isOwn'] ?? ''
        child['成人总票价_CNY'] = acai['套餐价格_CNY'] ?? ''
        child[`${pName}底价`] = acai['携程底价'] ?? ''
        child['预计减价'] = roundForDisplay(acai['差值'])
        child['底价公式命中'] = formatFloorMeta(acai._floorMeta)
        child['行李额'] = formatBaggageText(acai['行李信息'])
        outRows.push(child)
        rowBgColors.push(acai['isOwn'] ?? null)
      }
    }

    // 写 xlsx：{平台中文名}底价检查{日期}.xlsx（如 携程底价检查2026-08-28.xlsx）
    //   用 exceljs 生成（支持单元格样式：居中 + 行背景色）
    const finalPath = seq != null
      ? this._pathWithSeq(dir, `${pName}底价检查${dateStr}`, '.xlsx', seq)
      : this.getUniqueFilePath(dir, `${pName}底价检查${dateStr}.xlsx`)

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('底价检查')
    // 表头行
    ws.columns = header.map(h => ({ header: h, key: h, width: 14 }))
    // 数据行
    for (let i = 0; i < outRows.length; i++) {
      const row = ws.addRow(outRows[i])
      const bgVal = rowBgColors[i]//
      const fgColor = (bgVal === true || bgVal === 'true') ? 'E2ECFF' : null  // isOwn=true → 极浅蓝，其他不变色
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { horizontal: 'center', vertical: 'center', wrapText: true }
        if (fgColor) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + fgColor } }
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
