// ============================================================
// 数据文件管理器
// 职责：管理 a1/a2/a3 三个阶段的数据文件（JSON 持久化 + Excel 解析）
//   导出职责已抽离到 ExcelExporter.js（ARCH-1），本类仅保留数据管理 + exportResult 代理
//
// 数据流向：
//   a1: 上传的xlsx解析结果（原始数据）
//   a2: G1平台请求结果 + 原始数据 合并
//   a3: O平台组合请求结果 + a2数据 合并（最终数据，交 ExcelExporter 导出 xlsx）
//
// 持久化目录：userData/data/{a1,a2,a3}.json
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'
import * as registry from './platforms/registry.js'
import { O_PLATFORM_KEYS as O_PLATFORMS } from './platforms/registry.js'
import { A2_FIELDS, A3_FIELDS } from './fieldNames.js'
// ARCH-1：导出逻辑已抽离到 ExcelExporter，HR_FIELDS 由其统一导出（saveA3FromOTasks 仍要用）
import { ExcelExporter, HR_FIELDS } from './ExcelExporter.js'

// ===== JSDoc 类型定义：a1 / a2 / a3 数据 shape（文档 / IDE 提示用）=====

/**
 * @typedef {Object} A1Item - Excel 解析后的原始行数据（parseXlsx 产出，持久化于 a1.json）
 * @property {string} id - 唯一标识（形如 row_0）
 * @property {string} hangsi - 航司二字码（如 FA）
 * @property {string} CF_jichang - 出发机场三字码（如 JNB）
 * @property {string} DD_jichang - 到达机场三字码（如 DUR）
 * @property {string} CH_city - 出发城市
 * @property {string} DD_city - 到达城市
 * @property {string} cangwei_str - 舱位序列（逗号分隔，如 "Y,J,F"）
 */

/**
 * @typedef {Object} A2Item - a1 经锦绣国际（jxgj）增强后的数据（saveA2FromJxgjTasks 产出）
 * @property {string} id - 唯一标识（继承自 a1）
 * @property {string} hangsi - 航司二字码
 * @property {string} CF_jichang - 出发机场三字码
 * @property {string} DD_jichang - 到达机场三字码
 * @property {string} CH_city - 出发城市（继承自 a1）
 * @property {string} DD_city - 到达城市（继承自 a1）
 * @property {string} cangwei_str - 舱位序列（逗号分隔）
 * @property {Object[]} cangwei_arr - 舱位航班项数组（jxgj 返回的航班对象，每项含 C舱位 / C出发时间_Date / C出发日期 / C成人总票价_CNY / C成人总票价_CNY_INT / dijia / H航班号 / C出发机场 / D到达机场 等）
 * @property {Object.<string, Object[]>} date_obj - 按出发日期分组的航班项（键为 "YYYY-MM-DD" 形式的 C出发日期，值为 cangwei_arr 子集）
 */

/**
 * @typedef {Object} A3Item - O 平台比价结果行（saveA3FromOTasks 产出：exportTemplate 列 + HR_FIELDS 附加字段）
 * @property {string} _platform - 来源平台（trip / o2 / o3）
 * @property {string} H航班号 - 航班号
 * @property {string} H航司名 - 航司名
 * @property {string} C出发机场 - 出发机场三字码
 * @property {string} D到达机场 - 到达机场三字码
 * @property {string} C出发城市 - 出发城市
 * @property {string} D到达城市 - 到达城市
 * @property {string} C舱位 - 舱位
 * @property {string} C出发时间_Date - 出发时间（完整时间字符串）
 * @property {string} D到达时间_Date - 到达时间（完整时间字符串）
 * @property {string} 仓等 - 仓等
 * @property {number} C成人总票价_CNY - 成人总票价（CNY）
 * @property {number} XC_dijia - 底价
 * @property {number} CUT_VALUE - 差值（底价 - 成人总票价）
 */

// ARCH-1：HR_FIELDS / platformDisplayName / dateStamp / formatDijiaWithCut 已移至 ExcelExporter.js

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

    // ARCH-1：导出逻辑抽离到 ExcelExporter，此处注入自身（取 a3 数据）；
    //   exportResult 代理给它，controller.js / pipeline.js 等外部调用方无需改动
    this._excelExporter = new ExcelExporter(this)
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
  /** ARCH-3：便捷方法，直接返回 a1 数据数组（pipeline 不再访问 .data 内部结构） */
  getA1Data() {
    return this.a1
  }

  // 获取 a2 数据
  getA2() {
    return { data: this.a2, count: this.a2.length }
  }
  /** ARCH-3：便捷方法，直接返回 a2 数据数组 */
  getA2Data() {
    return this.a2
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
    const sampleLen = (sample[A2_FIELDS.cangwei_arr] || []).length
    const sampleDateCount = Object.keys(sample[A2_FIELDS.date_obj] || {}).length
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
        // 底价命中公式（jxgj 舱位项 _floorMeta 的文本化，同前端调试标签）
        //   系统导入文件里该字段因 exportTemplate.columns 未声明不会被写；
        //   仅底价检查(人看)文件会用到这列
        row[A3_FIELDS._floorMeta] = item[A3_FIELDS._floorMeta] || null
        // 比价结果标记：'won'（可以胜出）/ 'lost'（无法胜出）
        //   仅供 ExcelExporter 过滤导入政策文件用（底价检查文件全量导出）
        row[A3_FIELDS._outcome] = item[A3_FIELDS._outcome] || null
        // ★ 业务模式重构：底价检查文件为主行 + 套餐子行布局
        //   a3 行保留原始 行李信息（行李额列）与富化后的 套餐信息（套餐子行：
        //   套餐价_CNY / 我方底价 / 携程底价 / 差值 / _floorMeta）
        row['行李信息'] = item['行李信息']
        row['套餐信息'] = item['套餐信息']
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
   * 导出 a3 最终数据（ARCH-1：代理给 ExcelExporter，外部接口不变）
   *   实际逻辑见 ExcelExporter.exportResult：
   *   - 每 O 平台一个系统导入 xlsx（按 adapter.exportTemplate.columns 决定列序）
   *   - 一个「底价检查」人看合并 xlsx（跨平台底价对照）
   *   - 同名序号递增；进度推送 0→90→100（-1 = 失败）
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
    return this._excelExporter.exportResult(dir, _filename, onProgress, opts)
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
