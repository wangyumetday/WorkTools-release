// xlsx 工作表样式工具（2026-09-30 从 ExcelExporter 抽出）
//   抽出原因：导出写盘移到 worker 线程后，worker 需要与主进程**完全相同的**样式处理；
//   把实现收敛到本模块，两条路径共用一份代码 → 产出文件零差异。
import XLSX from 'xlsx'

/**
 * xlsx sheet 所有单元格 水平垂直居中 + 行背景色 + 列宽
 *   - 遍历 !ref 范围内所有单元格，设置 alignment + fill（根据 rowBgColors）
 *   - 无 !ref（空 sheet）时跳过
 *   - rowBgColors：与数据行对齐的数组，row 0 是表头不算
 *     true → 浅绿 C6EFCE / false → 浅红 FFC7CE / null → 不着色
 */
export function centerSheetCells(ws, rowBgColors = []) {
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
