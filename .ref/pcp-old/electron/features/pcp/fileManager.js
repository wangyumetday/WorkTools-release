// ============================================================
// PCP FileManager - 数据文件管理器
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

export class FileManager {
  /**
   * @param {string} userDataPath  Electron userData 路径（持久化目录）
   * @param {string} desktopPath   桌面路径（首次下载目录的兜底默认值，由 main.js 注入）
   */
  constructor(userDataPath, desktopPath = '') {
    this.userDataPath = userDataPath
    this.dataDir = path.join(userDataPath, 'data')
    this.configDir = path.join(userDataPath, 'config')
    this.ensureDataDir()
    this.ensureConfigDir()
    // 内存中的数据缓存（启动时从磁盘 JSON 加载，避免每次 IPC 都读盘）
    this.a1 = this.loadData('a1.json')
    this.a2 = this.loadData('a2.json')
    this.a3 = this.loadData('a3.json')

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
      // 最终兜底：避免 a1 的 hangsi/cangwei 为空 → JXGJ 请求 carrier 空 → O 阶段 processedData 全 0
      if (!cangwei) {
        // 常见模板：26 字母全舱位
        cangwei = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        console.warn('[parseXlsx] 未在 Excel 中找到 cabin/舱位列/值，兜底使用 26 字母全舱位')
      }
      if (!hangsi) {
        hangsi = ''
        console.warn('[parseXlsx] 未在 Excel 中找到 airline_code/航司列/值，JXGJ 请求会用 a1 里 hangsi 字段（如果为空，接口大概率返回空列表）')
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

      console.log(`[parseXlsx] FA-3.xlsx 解析完成：行数=${this.a1.length}，hangsi=${this.a1[0]?.hangsi || '(空)'}，cangwei_str 长度=${(this.a1[0]?.cangwei_str || '').length}`)
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
    console.log(`[saveA2FromJxgjTasks] 任务数=${tasks.length}；从 result.data.inputData 取=${hasInputData}；兜底 task.data=${fallbackCount} → A2 条数=${this.a2.length}`)
    console.log(`  → A2[0] 样例：hangsi=${sample.hangsi} 舱位=${sample.cangwei_str}；cangwei_arr 长度=${sampleLen}；date_obj 日期数=${sampleDateCount}`)
    this.saveData('a2.json', this.a2)
    return this.a2
  }

  /**
   * O 平台组合任务完成 → 生成 a3（O 结果 + 任务上下文合并）
   *   注意：O 任务是按 a2 项的 date_obj 每个日期拆分生成的（见 controller.js 的 task:addBatchByStage），
   *   所以 a3 每条对应"某条 a2 项的某一天"，携带 source(原a2项)/dateKey/dateValue/oData。
   *
   *   兼容性：携程OTA(TRIP) 没账号或调用失败时 result.trip 可能不存在 / 没有 processedData，
   *     用可选链 + Array.isArray 判断，跳过该任务，避免 TypeError 中断整个 a3 生成。
   *     若未来 O2/O3 平台也需要生成 a3，可在 forEach 里额外读取 result.o2.processedData / result.o3.processedData 合并。
   *
   *   ★ 调试埋点：用户遇到"没有结果数据，请先完成O平台阶段"时，直接看这一段汇总即可
   *     知道：有多少个 O 任务成功、trip 请求真正产出的 processedData 条数、
   *          O 任务失败数、失败数里哪些是"接口报错"哪些是"比价策略没比赢"。
   */
  saveA3FromOTasks(tasks) {
    const a3arr = []
    let okTasks = 0
    let failedTasks = 0
    let processedSum = 0
    tasks.forEach(task => {
      const tripResult = task?.result?.trip
      // 1. trip 请求级失败（抛异常走 runPlatformRequest catch）
      if (tripResult?.error) {
        failedTasks++
        console.warn(`  [saveA3FromOTasks] 任务=${task.id} trip 请求报错: ${tripResult.error}`)
        return
      }
      // 2. trip 没账号 → 被 executeOComboTask 跳过，不算失败
      if (!tripResult) return
      const processedData = tripResult.processedData
      if (!Array.isArray(processedData)) return
      okTasks++
      processedSum += processedData.length

      processedData.forEach(item => {
        a3arr.push({
          Name: `王宇_${item.H航司名}_携程/${item.C出发机场}-${item.D到达机场}`,
          Remark: "王宇_出官网",
          优先级: "90",
          是否启用: "TRUE",
          航程类型: null,
          航司匹配: item.H航司名,
          出发机场: item.C出发机场,
          到达机场: item.D到达机场,
          航班号: null,
          舱位: item.C舱位,
          起飞时间Start: null,
          起飞时间End: null,
          去程时间匹配排除: null,
          返程时间匹配排除: null,
          班期: null,
          销售时间Start: null,
          销售时间End: null,
          时间段匹配: null,
          提前销售天数: null,
          出票时长匹配: null,
          儿童人数最小: 0,
          儿童人数最大: 0,
          成人人数最小: 0,
          成人人数最大: 0,
          乘客人数最小: null,
          乘客人数最大: null,
          数据有效期Start: null,
          数据有效期End: null,
          出发城市: null,
          到达城市: null,
          出发国家: null,
          到达国家: null,
          最低票面价: null,
          最高票面价: null,
          销售天数: null,
          套餐索引v2: null,
          座位数: null,
          是否中转: null,
          是否国内: null,
          OTAType: "携程",
          OTAConfigID: 11,
          行程索引: null,
          数据来源: "爬虫",
          政策代码: null,
          爬虫名: null,//item.P爬虫名
          去程时间匹配: null,
          返程时间匹配: null,
          搜索出发城市: null,
          搜索到达城市: null,
          最长停留时间: null,
          最短停留时间: null,
          去程班期: null,
          返程班期: null,
          调价阶段: "搜索",
          调价增加百分比: 0,
          调价固定加减钱: item.CUT_VALUE,
          儿童调价增加百分比: 0,
          儿童调价固定加减钱: 0,
          价格基础类型: "总价",
          市场: null, ID: 0
        })
      })
    })
    console.log(`[saveA3FromOTasks] 总 O 任务数=${tasks.length}；trip 成功任务=${okTasks}；trip 请求失败=${failedTasks}；processedData 合计=${processedSum} → a3 条数=${a3arr.length}`)
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

  /**
   * 导出 a3 最终数据为 xlsx
   * a3 数组中的每个对象 = xlsx 一行，属性 key = 第一行标题行，数据行从第二行开始
   * 嵌套对象会扁平化为 JSON 字符串，避免 Excel 显示成 [object Object]
   *
   * 改造点：
   *   - 入参从 filePath 改为 (dir, filename)，由 FileManager 内部用 getUniqueFilePath 决定最终路径
   *   - 新增 onProgress 回调，分阶段推送进度（0/30/60/100），供前端按钮按进度填充颜色
   *   - 返回值带最终文件名（可能是 result (1).xlsx），前端可显示给用户
   */
  exportResult(dir, filename = 'result.xlsx', onProgress = () => { }) {
    try {
      onProgress(0)
      // 阶段1：将嵌套对象扁平化，方便 Excel 展示
      const flatData = this.a3.map(item => {
        const flat = {}
        for (const key of Object.keys(item)) {
          if (typeof item[key] === 'object' && item[key] !== null) {
            flat[key] = JSON.stringify(item[key])
          } else {
            flat[key] = item[key]
          }
        }
        return flat
      })
      onProgress(30)

      // 阶段2：构建 worksheet / workbook
      const worksheet = XLSX.utils.json_to_sheet(flatData)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, '结果')
      onProgress(60)

      // 阶段3：检查同名 + 写入文件（最终文件名可能是 result (1).xlsx）
      const finalPath = this.getUniqueFilePath(dir, filename)
      XLSX.writeFile(workbook, finalPath)
      onProgress(100)

      return {
        success: true,
        path: finalPath,
        filename: path.basename(finalPath),
        dir
      }
    } catch (error) {
      onProgress(-1) // -1 表示出错，前端据此恢复按钮
      return { success: false, error: error.message }
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
