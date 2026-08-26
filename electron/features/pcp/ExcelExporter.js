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
import * as registry from './platforms/registry.js'
import { O_PLATFORM_KEYS as O_PLATFORMS } from './platforms/registry.js'
import { A3_FIELDS } from './fieldNames.js'

// 「底价检查」人看文件需要保留的原始字段（附加在 a3 每行上）
//   exportResult 只按 template.columns 的 key 导列，这些附加字段不会被写进系统导入文件
export const HR_FIELDS = [
  A3_FIELDS.H航班号, A3_FIELDS.C舱位, A3_FIELDS.C成人总票价_CNY, A3_FIELDS.XC_dijia, A3_FIELDS.CUT_VALUE,
  A3_FIELDS.C出发机场, A3_FIELDS.D到达机场, A3_FIELDS.C出发城市, A3_FIELDS.D到达城市, A3_FIELDS.H航司名,
  A3_FIELDS.C出发时间_Date, A3_FIELDS.D到达时间_Date, A3_FIELDS.仓等
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
 * 「底价检查」底价列的展示值：底价（预计减价），如 2050（-30）
 *   预计减价 = 底价 - ceil(成人总票价_CNY) - 1
 *   底价或票价缺失时只显示底价（票价为非数字时省略括号）
 */
function formatDijiaWithCut(dijia, adultTotal) {
  if (dijia == null || dijia === '') return ''
  if (Number.isNaN(Number(dijia))) return String(dijia)
  const price = Number(adultTotal)
  if (Number.isNaN(price)) return String(dijia)
  const cut = Math.round(Number(dijia) - Math.ceil(price) - 1)
  return `${dijia}（${cut}）`
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
 * xlsx sheet 所有单元格 水平垂直居中 + 默认 14px 字体与边框（轻量美化）
 *   - 遍历 !ref 范围内所有单元格，设置 s.alignment = { horizontal:'center', vertical:'center', wrapText:true }
 *   - 无 !ref（空 sheet）时跳过
 *   - 内容单元格已存在自定义 s 的，浅合并（只改 alignment，保留其他样式）
 */
function centerSheetCells(ws) {
  if (!ws || !ws['!ref']) return
  const range = XLSX.utils.decode_range(ws['!ref'])
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C })
      const cell = ws[addr]
      if (!cell) continue
      const baseStyle = (cell.s && typeof cell.s === 'object') ? cell.s : {}
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
   * 导出 a3 最终数据（阶段4：每 O 平台一个系统导入 xlsx + 一个「底价检查」人看合并 xlsx）
   *   - a3 每行带 _platform 标签 → 按 _platform 分组
   *   - 每组用该平台 adapter.exportTemplate.columns 决定列顺序
   *     （_platform 与 HR_FIELDS 附加列不写入系统导入文件）
   *   - 嵌套对象扁平化为 JSON 字符串，避免 Excel 显示成 [object Object]
   *   - 系统导入文件命名：{平台中文名}导入政策{日期}.xlsx（如 携程导入政策2026-08-21.xlsx）
   *   - 人看文件命名：底价检查({平台中文名}){日期}.xlsx（如 底价检查(携程)2026-08-21.xlsx）
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
  exportResult(dir, _filename = 'result.xlsx', onProgress = () => { }, opts = {}) {
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

      // ★ 统一序号：政策导入文件 + 底价检查文件用相同序号（取使所有文件都不冲突的最小序号）
      const bases = platformKeys.map(p => `${platformDisplayName(p)}导入政策${dateStr}`)
      // 预测底价检查文件 basename（mainKey 逻辑同 buildHumanReadableFile：trip 优先，否则第一个有数据的平台）
      const hrPresent = O_PLATFORMS.filter(p => (groups[p] || []).length > 0)
      if (hrPresent.length > 0) {
        const hrMainKey = (groups['trip'] || []).length > 0 ? 'trip' : hrPresent[0]
        bases.push(`${platformDisplayName(hrMainKey)}底价检查${dateStr}`)
      }
      const unifiedSeq = this._uniqueSeqForAll(dir, bases, '.xlsx')

      const files = []
      for (let i = 0; i < platformKeys.length; i++) {
        const p = platformKeys[i]
        const rows = groups[p]

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
              if (key === A3_FIELDS._platform || HR_FIELDS.includes(key)) continue
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

      // ===== 生成「底价检查」人看合并文件（失败不影响系统导入文件） =====
      const humanFile = this.buildHumanReadableFile(dir, dateStr, unifiedSeq)
      if (humanFile) files.push(humanFile)

      onProgress(100)
      return { success: true, files, dir }
    } catch (error) {
      onProgress(-1) // -1 表示出错，前端据此恢复按钮
      return { success: false, error: error.message }
    }
  }

  /**
   * 生成「底价检查」人看合并文件（给业务人员看价用）
   *   - 以 trip（携程）行为主体；其他平台（O2/O3）的底价按
   *     航班号|出发机场|到达机场|出发时间 匹配进主体行
   *   - 列结构：航班号, 舱位, 出发机场, 到达机场, 成人总票价_CNY,
   *     [各平台底价列(预计减价)...], 出发城市, 到达城市, 航司名, 出发时间, 到达时间, 仓等
   *   - 底价列紧跟在「成人总票价_CNY」后，有数据的平台才插列（几个插几个，没有不插）
   *   - 底价列的值形如「2050（-30）」：括号内预计减价 = 底价 - ceil(成人总票价_CNY) - 1
   *   - 其他平台有而主体平台没有的航班 → 追加为独立行（主体平台底价留空）
   * @returns {{path, filename, platform, count}|null} 没数据或生成失败返回 null
   */
  buildHumanReadableFile(dir, dateStr, seq = null) {
    try {
      // 1. 按平台分组（按标准 O 平台顺序取，保证底价列顺序稳定）
      const groups = {}
      for (const row of this.fileManager.a3) {
        const p = row?.[A3_FIELDS._platform] || 'trip'
        if (!groups[p]) groups[p] = []
        groups[p].push(row)
      }
      const presentKeys = O_PLATFORMS.filter(p => (groups[p] || []).length > 0)
      if (presentKeys.length === 0) return null

      // 2. 主体平台：有携程（trip）以携程为主，否则取第一个有数据的平台
      const mainKey = groups['trip'] ? 'trip' : presentKeys[0]

      // 匹配键：航班号|出发机场|到达机场|出发时间（航班级唯一标识）
      const matchKey = (r) =>
        [r[A3_FIELDS.H航班号], r[A3_FIELDS.C出发机场], r[A3_FIELDS.D到达机场], r[A3_FIELDS.C出发时间_Date]]
          .map(v => (v == null ? '' : String(v))).join('|')

      // 3. 其他平台底价 & 命中公式索引：platform → { 匹配键: value }
      const otherPriceMap = {}
      const otherMetaMap = {}
      for (const p of presentKeys) {
        if (p === mainKey) continue
        const pm = {}, mm = {}
        for (const r of groups[p]) {
          const k = matchKey(r)
          pm[k] = r[A3_FIELDS.XC_dijia]
          mm[k] = r[A3_FIELDS._floorMeta]
        }
        otherPriceMap[p] = pm
        otherMetaMap[p] = mm
      }

      // 4. 列顺序：航班号, 舱位, 出发机场, 到达机场, 成人总票价_CNY,
      //            [ 各平台底价列 | 该平台命中公式列 成对插入 ... ],
      //            出发城市, 到达城市, 航司名, 出发时间, 到达时间, 仓等
      const platformColGroups = presentKeys.map(p => ({
        priceHeader: `${platformDisplayName(p)}底价(预计减价)`,
        metaHeader: '底价公式命中',
        platform: p
      }))
      const interleavedPlatformCols = []
      for (const g of platformColGroups) interleavedPlatformCols.push(g.priceHeader, g.metaHeader)
      const header = ['航班号', '舱位', '出发机场', '到达机场', '成人总票价_CNY'].concat(
        interleavedPlatformCols,
        ['出发城市', '到达城市', '航司名', '出发时间', '到达时间', '仓等']
      )
      // 表头 → 属于哪类：fieldMap / 某平台 底价列 / 某平台 命中公式列
      const priceHeaderInfo = {}
      const metaHeaderInfo = {}
      for (const g of platformColGroups) {
        priceHeaderInfo[g.priceHeader] = g.platform
        metaHeaderInfo[g.metaHeader] = g.platform
      }
      // 中文表头 → 原始字段
      const fieldMap = {
        '航班号': A3_FIELDS.H航班号, '舱位': A3_FIELDS.C舱位, '成人总票价_CNY': A3_FIELDS.C成人总票价_CNY,
        '出发机场': A3_FIELDS.C出发机场, '到达机场': A3_FIELDS.D到达机场,
        '出发城市': A3_FIELDS.C出发城市, '到达城市': A3_FIELDS.D到达城市, '航司名': A3_FIELDS.H航司名,
        '出发时间': A3_FIELDS.C出发时间_Date, '到达时间': A3_FIELDS.D到达时间_Date, '仓等': A3_FIELDS.仓等
      }

      // 5. 逐行组装（对象 key 插入顺序 = 表头列顺序）
      const rows = []
      const usedKeys = new Set()
      const pushRow = (r, priceByPlat, metaByPlat) => {
        const out = {}
        for (const h of header) {
          if (fieldMap[h] != null) {
            out[h] = r[fieldMap[h]]
          } else if (priceHeaderInfo[h] != null) {
            // 底价列：底价（预计减价），如 2050（-30）
            out[h] = formatDijiaWithCut(priceByPlat[priceHeaderInfo[h]], r[A3_FIELDS.C成人总票价_CNY])
          } else if (metaHeaderInfo[h] != null) {
            // 命中公式列：区间[500,700] cost*0.48 / 全局 cost*0.2 / 降级 原价
            out[h] = formatFloorMeta(metaByPlat[metaHeaderInfo[h]])
          } else {
            out[h] = ''
          }
        }
        rows.push(out)
      }

      // 主体平台行（携程为主），其他平台底价/公式按匹配键补列
      for (const r of groups[mainKey]) {
        const key = matchKey(r)
        usedKeys.add(key)
        const priceByPlat = { [mainKey]: r[A3_FIELDS.XC_dijia] }
        const metaByPlat = { [mainKey]: r[A3_FIELDS._floorMeta] }
        for (const p of presentKeys) {
          if (p === mainKey) continue
          priceByPlat[p] = otherPriceMap[p][key] ?? ''
          metaByPlat[p] = otherMetaMap[p][key] ?? null
        }
        pushRow(r, priceByPlat, metaByPlat)
      }
      // 其他平台独有的航班（主体平台没有的行）追加，主体平台底价/公式留空
      for (const p of presentKeys) {
        if (p === mainKey) continue
        for (const r of groups[p]) {
          const key = matchKey(r)
          if (usedKeys.has(key)) continue
          usedKeys.add(key)
          pushRow(
            r,
            { [p]: r[A3_FIELDS.XC_dijia] },
            { [p]: r[A3_FIELDS._floorMeta] }
          )
        }
      }

      // 6. 写 xlsx：{主体平台中文名}底价检查{日期}.xlsx（如 携程底价检查2026-08-21.xlsx）
      //   表头/内容全部单元格水平垂直居中显示
      const worksheet = XLSX.utils.json_to_sheet(rows)
      centerSheetCells(worksheet)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, '底价检查')
      const finalPath = seq != null
        ? this._pathWithSeq(dir, `${platformDisplayName(mainKey)}底价检查${dateStr}`, '.xlsx', seq)
        : this.getUniqueFilePath(dir, `${platformDisplayName(mainKey)}底价检查${dateStr}.xlsx`)
      XLSX.writeFile(workbook, finalPath)
      return { path: finalPath, filename: path.basename(finalPath), platform: 'human', count: rows.length }
    } catch (error) {
      // 人看文件是附加产物，失败不影响系统导入文件
      console.warn(`[buildHumanReadableFile] 底价检查文件生成失败：${error.message}`)
      return null
    }
  }
}
