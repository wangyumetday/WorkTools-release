// ============================================================
// ASS 模块 E2E 快速自测（不走 Electron UI，直接调 runAssTask）
// 使用：
//   node ass-e2e-test.mjs
// ============================================================

import { runAssTask } from './electron/features/ass/queryEngine.js'
import { readFileSync, existsSync } from 'node:fs'

const XLSX = 'D:/WorkTools-release/src/features/ass/testExcel/LJ-5.xlsx'
const OUT  = 'D:/WorkTools-release/ass_outputs_e2e'

if (!existsSync(XLSX)) {
  console.error('测试 Excel 不存在:', XLSX)
  process.exit(1)
}

const opts = {
  filePath:  XLSX,
  airline:   '',        // 不指定，看更多航线数据
  startDate: '2026-09-01',
  endDate:   '2026-09-02', // 2 天即可
  outputDir: OUT,
  onProgress: (p) => {
    if (p.type) {
      console.log(`[${p.type}]`, p.result ? `result(ts=${p.result?.ts})` : '', p.error || p.outputDir || '')
      return
    }
    const qp = p.qp || {}
    console.log(
      `[${p.phase}] ${String(p.index).padStart(4)}/${p.total}  ` +
      `${qp.dep}→${qp.arr} ${qp.date}  ${p.result}${p.message ? '  err=' + p.message : ''}`
    )
  },
}

try {
  const r = await runAssTask(opts)
  console.log('\n======== DONE ========')
  console.log('TS            :', r.ts)
  console.log('parseInfo     :', r.parseInfo)
  console.log('日期数 / 总 QP:', r.dateCount, '/', r.queryParamTotal)
  console.log('counts        :', JSON.stringify(r.counts, null, 2))
  console.log('P1 路径       :', r.p1FilePath)
  console.log('P2 路径       :', r.p2FilePath)

  // 快速看 P1/P2 各前 2 行
  for (const f of [r.p1FilePath, r.p2FilePath]) {
    console.log(`\n--- ${f} 前 2 行预览 ---`)
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(0, 2)
    lines.forEach((ln, i) => {
      const obj = JSON.parse(ln)
      console.log(`#${i + 1} queryParam=`, obj.queryParam,
        'hasFlight' in obj ? ` hasFlight=${obj.hasFlight}` : ` status=${obj.status}`)
      if (obj.error) console.log('   error:', obj.error)
    })
  }
} catch (e) {
  console.error('FATAL:', e)
  process.exit(2)
}
