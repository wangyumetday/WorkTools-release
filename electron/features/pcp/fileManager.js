// ============================================================
// 数据文件管理器
// 职责：管理 a1/a2/a3 三个阶段的数据文件（JSON 持久化 + Excel 解析/导出）
//
// 数据流向：
//   a1: 上传的xlsx解析结果（原始数据）
//   a2: G1平台请求结果 + 原始数据 合并
//   a3: O平台组合请求结果 + a2数据 合并（最终数据，直接导出 xlsx）
//
// 持久化目录：userData/data/{a1,a2,a3}.json
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'
import * as registry from './platforms/registry.js'

// 「底价检查」人看文件需要保留的原始字段（附加在 a3 每行上）
//   exportResult 只按 template.columns 的 key 导列，这些附加字段不会被写进系统导入文件
const HR_FIELDS = [
  'H航班号', 'C舱位', 'C成人总票价_CNY', 'XC_dijia', 'CUT_VALUE',
  'C出发机场', 'D到达机场', 'C出发城市', 'D到达城市', 'H航司名',
  'C出发时间_Date', 'D到达时间_Date', '仓等'
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

export class FileManager {
  /**
   * @param {string} userDataPath  Electron userData 路径（持久化目录）
   * @param {string} desktopPath   桌面路径（首次下载目录的兜底默认值，由 main.js 注入）
   * @param {object} [configManager] ConfigManager 实例（导出时取各平台 agentName/agentRemark 等业务员信息）
   */
  constructor(userDataPath, desktopPath = '', configManager = null) {
    this.userDataPath = userDataPath
    this.dataDir = path.join(userDataPath, 'data')
    this.configDir = path.join(userDataPath, 'config')
    this.ensureDataDir()
    this.ensureConfigDir()
    // 内存中的数据缓存（启动时从磁盘 JSON 加载，避免每次 IPC 都读盘）
    this.a1 = this.loadData('a1.json')
    this.a2 = this.loadData('a2.json')
    this.a3 = this.loadData('a3.json')

    // ConfigManager 注入（阶段4：导出时取平台配置 agentName/agentRemark 写入政策列）
    this.configManager = configManager

    // 上次选择文件的文件夹（首次为空字符串，dialog 不传 defaultPath 时 Electron 用 OS 默认）
    //   用途：步骤1选 xlsx 时，defaultPath = lastDirectory，下次直接打开同一文件夹
    this.desktopPath = desktopPath
    this.lastDirectory = this.loadSetting('lastDirectory.json', '')
    // 下载目录（首次默认桌面，用户在步骤4选过之后记住）
    this.downloadDir = this.loadSetting('downloadDir.json', desktopPath)
  }

  // 确保 data 目录存在
  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }
  }

  // 确保 config 目录存在（存放 lastDirectory.json / downloadDir.json 等设置文件）
  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
  }

  /**
   * 通用设置读写：把简单值（字符串/数字/布尔）包装成 JSON 存到 configDir
   *   - loadSetting：文件不存在或解析失败时返回 defaultValue
   *   - saveSetting：写 JSON.stringify(value)，便于跨类型复用
   */
  loadSetting(filename, defaultValue) {
    const filePath = path.join(this.configDir, filename)
    if (!fs.existsSync(filePath)) return defaultValue
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      // 兼容两种格式：直接值 { value: "xxx" }，或裸 JSON（字符串被双引号包裹）
      if (raw && typeof raw === 'object' && 'value' in raw) return raw.value
      return raw
    } catch {
      return defaultValue
    }
  }

  saveSetting(filename, value) {
    const filePath = path.join(this.configDir, filename)
    // 包装成 { value } 结构，避免字符串裸存时 JSON.parse 解析成"字符串内容"歧义
    fs.writeFileSync(filePath, JSON.stringify({ value }), 'utf-8')
  }

  // ==================== 上次文件夹记忆 ====================
  // 步骤1选 xlsx 时用 lastDirectory 作 defaultPath，方便用户连续操作
  getLastDirectory() {
    return this.lastDirectory || this.desktopPath || ''
  }

  setLastDirectory(dir) {
    this.lastDirectory = dir || ''
    this.saveSetting('lastDirectory.json', this.lastDirectory)
  }

  // ==================== 下载目录 ====================
  getDownloadDir() {
    // 兜底：用户删了目录 / 配置丢失时回退桌面
    return this.downloadDir || this.desktopPath || ''
  }

  setDownloadDir(dir) {
    this.downloadDir = dir || ''
    this.saveSetting('downloadDir.json', this.downloadDir)
    return this.downloadDir
  }

  /**
   * 解析 xlsx 文件，生成 a1（原始数据数组）
   * 解析规则：第一行第一列的 cabin / airline_code 作为全局航线/舱位上下文，
   *           每一行生成一条 a1 数据（id/CF_jichang/DD_jichang/hangsi/cangwei_str）
   */
  parseXlsx(filePath) {
    try {
      const workbook = XLSX.readFile(filePath)
      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      // header:1 → 输出二维数组，能拿到所有原始列名（兼容 cabin/airline_code 不在第 1 行/第 1 列的情况）
      const aoa = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null })
      if (!Array.isArray(aoa) || aoa.length < 2) {
        return { success: false, error: 'Excel 内容为空或只有标题行，请用标准模板' }
      }

      // ------- 兼容各种列名/格式：先猜"标题行在哪一行" -------
      // 常见两种：
      //   1) 第 1 行 = cabin/airline_code 元数据，第 2 行才是 origin/arrival 等航线标题行（第 3 行起数据）
      //   2) 第 1 行 = 就是航线标题行（元数据不存在或在文件其它位置）
      let titleRowIdx = 0
      // 找到第一个含 origin/arrival/出发/到达/orig/dest 等关键字的行作为真正的标题行
      const headerKeywords = [
        /origin/i, /arrival/i, /出发/, /到达/, /城市/, /机场/,
        /from/i, /to/i, /dep|depart/i, /arr|arrive/i
      ]
      const scanLimit = Math.min(aoa.length - 1, 5)  // 最多在最前 5 行里找标题
      for (let i = 0; i <= scanLimit; i++) {
        const row = aoa[i] || []
        const hasKey = row.some(cell => {
          if (cell == null) return false
          const s = String(cell).trim()
          return headerKeywords.some(re => re.test(s))
        })
        if (hasKey) { titleRowIdx = i; break }
      }
      const titles = (aoa[titleRowIdx] || []).map(c => (c == null ? '' : String(c).trim()))
      const dataRows = aoa.slice(titleRowIdx + 1).filter(r => r && r.some(c => c != null && String(c).trim() !== ''))

      // ------- cabin / airline_code / hangsi / 舱位 / 航司 -------
      // 优先从标题行上方的元数据行里找（第 0..titleRowIdx-1 行）
      let cangwei = ''
      let hangsi = ''
      for (let i = 0; i < titleRowIdx; i++) {
        const row = aoa[i] || []
        for (let j = 0; j < row.length - 1; j++) {
          const k = String(row[j] || '').trim().toLowerCase()
          const v = String(row[j + 1] || '').trim()
          if (!v) continue
          if (/^(cabin|舱位|cangwei|cabin_code)$/.test(k)) cangwei = v
          if (/^(airline_code|airline|航司|hangsi|carrier|航空公司|航司二字码)$/.test(k)) hangsi = v
        }
      }
      // 然后看"标题行"里有没有 cabin/airline_code 列，有就取第一行数据的值
      const cabinIdx = titles.findIndex(t => /^(cabin|舱位|cangwei)$/i.test(t))
      const airlineIdx = titles.findIndex(t => /^(airline_code|airline|航司|hangsi|carrier|航空公司|航司二字码)$/i.test(t))
      const row0 = dataRows[0] || []
      if (!cangwei && cabinIdx >= 0 && row0[cabinIdx]) cangwei = String(row0[cabinIdx]).trim()
      if (!hangsi && airlineIdx >= 0 && row0[airlineIdx]) hangsi = String(row0[airlineIdx]).trim()
      // 不兜底：用户文件里拆不出 cangwei/hangsi 就是空，a1 该字段为空 → JXGJ 阶段 cangwei_arr/date_obj 空
      // → 后续 O 阶段 0 任务 → 0 条结果。这是用户语义：用户给什么用什么，拆不出就跑 0 个
      if (!cangwei) {
        cangwei = ''
        console.warn('[parseXlsx] 未在 Excel 中找到 cabin/舱位列/值，cangwei_str 将为空 → 跑出 0 条结果')
      }
      if (!hangsi) {
        hangsi = ''
        console.warn('[parseXlsx] 未在 Excel 中找到 airline_code/航司列/值，hangsi 将为空（JXGJ 接口大概率返回空列表）')
      }

      // ------- 列名映射：兼容各种 Excel 中文列头 -------
      const colMap = {
        CF_jichang: ['origin', '出发机场', '出发地机场', '起飞机场', '出发港', 'dep_airport', 'depart_airport', 'depairport', '始发机场'],
        DD_jichang: ['arrival', '到达机场', '目的地机场', '降落机场', '到达港', 'arr_airport', 'arrive_airport', 'arrairport', '终到机场'],
        CH_city: ['出发城市', 'city_from', '出发地城市', '起始城市', 'origincity'],
        DD_city: ['到达城市', 'city_to', '目的地城市', '终到城市', 'arrivalcity'],
        hangsi: ['hangsi', 'airline_code', 'carrier', '航司', '承运航司', '航空公司'],
        cangwei_str: ['cabin', '舱位', '舱位代码']
      }
      function pickField(row, keys) {
        for (const k of keys) {
          // 精确匹配（大小写不敏感 + 去空格）
          const idx = titles.findIndex(t => t.replace(/\s+/g, '').toLowerCase() === k.replace(/\s+/g, '').toLowerCase())
          if (idx >= 0 && row[idx] != null) {
            const v = String(row[idx]).trim()
            if (v) return v
          }
        }
        // 再试一次"包含"
        for (const k of keys) {
          const idx = titles.findIndex(t => {
            const tl = t.replace(/\s+/g, '').toLowerCase()
            const kl = k.replace(/\s+/g, '').toLowerCase()
            return tl && (tl.includes(kl) || kl.includes(tl))
          })
          if (idx >= 0 && row[idx] != null) {
            const v = String(row[idx]).trim()
            if (v) return v
          }
        }
        return ''
      }

      // 遍历每条航线，每条航线生成一个任务进队列
      this.a1 = dataRows.map((row, index) => ({
        id: `row_${index}`,
        CF_jichang: pickField(row, colMap.CF_jichang),
        DD_jichang: pickField(row, colMap.DD_jichang),
        CH_city: pickField(row, colMap.CH_city),
        DD_city: pickField(row, colMap.DD_city),
        hangsi: hangsi || pickField(row, colMap.hangsi),
        cangwei_str: cangwei || pickField(row, colMap.cangwei_str)
      }))

      this.saveData('a1.json', this.a1)

      // console.log(`[parseXlsx] FA-3.xlsx 解析完成：行数=${this.a1.length}，hangsi=${this.a1[0]?.hangsi || '(空)'}，cangwei_str 长度=${(this.a1[0]?.cangwei_str || '').length}`)
      return {
        success: true,
        fileName: path.basename(filePath),
        count: this.a1.length,
        data: this.a1.slice(0, 100)
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  // 获取 a1 数据
  getA1() {
    return { data: this.a1, count: this.a1.length }
  }

  // 获取 a2 数据
  getA2() {
    return { data: this.a2, count: this.a2.length }
  }

  // 获取 a3 数据
  getA3() {
    return { data: this.a3, count: this.a3.length }
  }

  /**
   * 清空全部阶段数据（a1/a2/a3 内存 + 磁盘）
   * 用途：下载完成后 pipeline.reset() 调用，让流程回到初始态，
   *       步骤流不再显示"已完成"，用户可重新选文件开始新一轮
   * 注：不动 lastDirectory / downloadDir（用户偏好保留）
   */
  clearAll() {
    this.a1 = []
    this.a2 = []
    this.a3 = []
    this.saveData('a1.json', [])
    this.saveData('a2.json', [])
    this.saveData('a3.json', [])
  }

  /**
   * 按阶段保存结果（全部任务完成后由 TaskManager.onAllComplete 触发一次性写入）
   *   - stage='jxgj'    → 调 saveA2FromJxgjTasks（锦绣国际结果 → a2）
   *   - stage='o_combo' → 调 saveA3FromOTasks（O 组合结果 → a3）
   */
  saveStageResults(stage, tasks) {
    switch (stage) {
      case 'jxgj':
        this.saveA2FromJxgjTasks(tasks)
        break
      case 'o_combo':
        this.saveA3FromOTasks(tasks)
        break
      default:
        break
    }
  }

  /**
   * 锦绣国际（JXGJ）任务完成 → 生成 a2（结果 + a1 原始数据合并）
   *   JXGJ 请求的返回结构是 { data: { inputData, result, ... } }，但在 taskManager 里
   *   我们执行 task.result = g1Request() 返回值，result.data.inputData 里才是含
   *   date_obj / cangwei_arr 的完整 a2 源数据，而不是 task.data（原始 a1 那一行，不含 date_obj！）
   *   这是 downloadResult 报「没有结果数据」的根因：之前直接 map(task.data) 导致
   *   a2 里的 item 没有 date_obj，O 阶段拆分任务时走 dateKey=null/dateValue=null 兜底，
   *   o1Request 读 data.dateValue[0] → 空数组报错 → processedData 空数组 → saveA3FromOTasks
   *   push 不进任何数据 → a3.length === 0
   */
  saveA2FromJxgjTasks(tasks) {
    let hasInputData = 0
    let fallbackCount = 0
    this.a2 = tasks.map(task => {
      // JXGJ 请求返回值：result.data.inputData 才是处理后含 date_obj / cangwei_arr 的对象
      const inputData = task?.result?.data?.inputData
      if (inputData && typeof inputData === 'object') {
        hasInputData++
        return inputData
      }
      // 兜底（异常任务没有 inputData 时用原始 task.data，避免 saveStageResults 崩）
      fallbackCount++
      return task.data
    })
    const sample = this.a2[0] || {}
    const sampleLen = (sample.cangwei_arr || []).length
    const sampleDateCount = Object.keys(sample.date_obj || {}).length
    // console.log(`[saveA2FromJxgjTasks] 任务数=${tasks.length}；从 result.data.inputData 取=${hasInputData}；兜底 task.data=${fallbackCount} → A2 条数=${this.a2.length}`)
    // console.log(`  → A2[0] 样例：hangsi=${sample.hangsi} 舱位=${sample.cangwei_str}；cangwei_arr 长度=${sampleLen}；date_obj 日期数=${sampleDateCount}`)
    this.saveData('a2.json', this.a2)
    return this.a2
  }

  /**
   * O 平台组合任务完成 → 生成 a3（按 O 平台分组，每平台用各自 exportTemplate 生成行）
   *   阶段4 重构：每 O 平台一份异构 xlsx 列模板（trip/o2/o3 各自 adapter.exportTemplate）
   *     - 行值由 exportTemplate.columns 的 from(item, cfg) / value 计算
   *     - cfg = 该平台配置（agentName/agentRemark 等业务员信息写入政策 Name/Remark 列）
   *     - 每行打 _platform 标签，exportResult 据此分组导出每平台一个 xlsx
   *
   *   兼容性：某 O 平台没账号 / 调用失败 / mergeResult 抛错 → result[platform].error 或不存在，
   *     用可选链 + Array.isArray 跳过，不影响其他平台。
   *
   *   ★ 调试埋点：汇总每平台成功任务数 / processedData 合计 / 失败数，方便排查"没有结果数据"
   */
  saveA3FromOTasks(tasks) {
    // ★ O 平台任务拆分后：每个 task 是单平台任务，task.type 即平台，task.result 是该平台单次结果
    //   （旧版 runCombo 返回 { trip:{...}, o2:{...}, o3:{...} } 聚合体，此处按 task.type 直接取）
    const a3arr = []
    const O_PLATFORMS = ['trip', 'o2', 'o3']
    const stats = {}
    O_PLATFORMS.forEach(p => { stats[p] = { okTasks: 0, failedTasks: 0, processedSum: 0 } })

    // 预取各平台配置 + exportTemplate（cfg 注入 exportTemplate.from(item, cfg)）
    const platformCtx = {}
    for (const p of O_PLATFORMS) {
      let template = null
      try { template = registry.get(p)?.exportTemplate || null } catch { template = null }
      const cfg = this.configManager?.getPlatformConfig(p) || {}
      platformCtx[p] = { template, cfg }
    }

    tasks.forEach(task => {
      const p = task.type
      if (!O_PLATFORMS.includes(p)) return
      const result = task?.result || {}
      // 1. 该平台请求级失败（run 抛异常 → scheduler catch → task.result = { error }）
      if (result.error) {
        stats[p].failedTasks++
        console.warn(`  [saveA3FromOTasks] 任务=${task.id} ${p} 请求报错: ${result.error}`)
        return
      }
      const processedData = result.processedData
      if (!Array.isArray(processedData)) return
      stats[p].okTasks++
      stats[p].processedSum += processedData.length

      // 2. 没配 exportTemplate（如 O2/O3 未实现）→ 跳过，不产出政策行
      const { template, cfg } = platformCtx[p]
      if (!template || !Array.isArray(template.columns)) return

      // 3. 按 template.columns 生成每行（保持列顺序，xlsx 标题行由此决定）
      for (const item of processedData) {
        const row = { _platform: p }
        for (const col of template.columns) {
          if (typeof col.from === 'function') {
            row[col.key] = col.from(item, cfg)
          } else {
            row[col.key] = col.value
          }
        }
        // 附带「底价检查」人看文件需要的原始字段（系统导入导出时这些列会被过滤掉）
        for (const f of HR_FIELDS) {
          row[f] = item[f]
        }
        a3arr.push(row)
      }
    })

    const summary = O_PLATFORMS.map(p => `${p}: ok=${stats[p].okTasks} fail=${stats[p].failedTasks} processed=${stats[p].processedSum}`).join('；')
    // console.log(`[saveA3FromOTasks] 总 O 任务数=${tasks.length}；${summary} → a3 条数=${a3arr.length}`)
    this.a3 = a3arr
    this.saveData('a3.json', a3arr)
    return a3arr
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
      for (const row of this.a3) {
        const p = row?._platform || 'trip'
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
      const O_PLATFORMS = ['trip', 'o2', 'o3']
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
              if (key === '_platform' || HR_FIELDS.includes(key)) continue
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
      const O_PLATFORMS = ['trip', 'o2', 'o3']
      const groups = {}
      for (const row of this.a3) {
        const p = row?._platform || 'trip'
        if (!groups[p]) groups[p] = []
        groups[p].push(row)
      }
      const presentKeys = O_PLATFORMS.filter(p => (groups[p] || []).length > 0)
      if (presentKeys.length === 0) return null

      // 2. 主体平台：有携程（trip）以携程为主，否则取第一个有数据的平台
      const mainKey = groups['trip'] ? 'trip' : presentKeys[0]

      // 匹配键：航班号|出发机场|到达机场|出发时间（航班级唯一标识）
      const matchKey = (r) =>
        [r['H航班号'], r['C出发机场'], r['D到达机场'], r['C出发时间_Date']]
          .map(v => (v == null ? '' : String(v))).join('|')

      // 3. 其他平台底价索引：platform → { 匹配键: 底价 }
      const otherPriceMap = {}
      for (const p of presentKeys) {
        if (p === mainKey) continue
        const m = {}
        for (const r of groups[p]) m[matchKey(r)] = r['XC_dijia']
        otherPriceMap[p] = m
      }

      // 4. 列顺序：航班号, 舱位, 出发机场, 到达机场, 成人总票价_CNY,
      //            底价列(含预计减价), 出发城市, 到达城市, 航司名, 出发时间, 到达时间, 仓等
      const priceHeaders = presentKeys.map(p => `${platformDisplayName(p)}底价(预计减价)`)
      const header = ['航班号', '舱位', '出发机场', '到达机场', '成人总票价_CNY'].concat(
        priceHeaders,
        ['出发城市', '到达城市', '航司名', '出发时间', '到达时间', '仓等']
      )
      const priceHeaderKeys = {}
      presentKeys.forEach(p => { priceHeaderKeys[`${platformDisplayName(p)}底价(预计减价)`] = p })
      // 中文表头 → 原始字段
      const fieldMap = {
        '航班号': 'H航班号', '舱位': 'C舱位', '成人总票价_CNY': 'C成人总票价_CNY',
        '出发机场': 'C出发机场', '到达机场': 'D到达机场',
        '出发城市': 'C出发城市', '到达城市': 'D到达城市', '航司名': 'H航司名',
        '出发时间': 'C出发时间_Date', '到达时间': 'D到达时间_Date', '仓等': '仓等'
      }

      // 5. 逐行组装（对象 key 插入顺序 = 表头列顺序）
      const rows = []
      const usedKeys = new Set()
      const pushRow = (r, priceByPlat) => {
        const out = {}
        for (const h of header) {
          if (fieldMap[h] != null) {
            out[h] = r[fieldMap[h]]
          } else {
            // 底价列：底价（预计减价），如 2050（-30）
            out[h] = formatDijiaWithCut(priceByPlat[priceHeaderKeys[h]], r['C成人总票价_CNY'])
          }
        }
        rows.push(out)
      }

      // 主体平台行（携程为主），其他平台底价按匹配键补列
      for (const r of groups[mainKey]) {
        const key = matchKey(r)
        usedKeys.add(key)
        const priceByPlat = { [mainKey]: r['XC_dijia'] }
        for (const p of presentKeys) {
          if (p === mainKey) continue
          priceByPlat[p] = otherPriceMap[p][key] ?? ''
        }
        pushRow(r, priceByPlat)
      }
      // 其他平台独有的航班（主体平台没有的行）追加，主体平台底价留空
      for (const p of presentKeys) {
        if (p === mainKey) continue
        for (const r of groups[p]) {
          const key = matchKey(r)
          if (usedKeys.has(key)) continue
          usedKeys.add(key)
          pushRow(r, { [p]: r['XC_dijia'] })
        }
      }

      // 6. 写 xlsx：{主体平台中文名}底价检查{日期}.xlsx（如 携程底价检查2026-08-21.xlsx）
      const worksheet = XLSX.utils.json_to_sheet(rows)
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

  // 写入 JSON 数据到 data 目录
  saveData(filename, data) {
    const filePath = path.join(this.dataDir, filename)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  // 从 data 目录加载 JSON 数据（不存在或解析失败返回空数组）
  loadData(filename) {
    const filePath = path.join(this.dataDir, filename)
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      } catch {
        return []
      }
    }
    return []
  }
}
