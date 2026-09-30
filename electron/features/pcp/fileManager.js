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

import fs from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'
import * as registry from './platforms/registry.js'
import { O_PLATFORM_KEYS as O_PLATFORMS } from './platforms/registry.js'
import { A2_FIELDS, A3_FIELDS } from './fieldNames.js'
// ARCH-1：导出逻辑已抽离到 ExcelExporter，HR_FIELDS 由其统一导出（saveA3FromOTasks 仍要用）
import { ExcelExporter, HR_FIELDS } from './ExcelExporter.js'
// ★ 2026-09-29 异常航线判定已改为任务级实时（TaskManager.reloadRuntimeConfigs 注入政策条目、
//   trip adapter 在 mergeResult 内即时修正 summary）→ 本文件不再需要异常判定相关函数
// ★ 2026-09-30：政策解析口径收敛到 parsePolicyAoa（worker 线程读盘与进程内读盘共用）
import { buildHeaderKeyMap, POLICY_REQUIRED_HEADERS, parsePolicyAoa } from './policyWriteback.js'
// ★ 2026-09-30：SheetJS 同步读/写移到 worker 线程（失败自动回退进程内）
import { readPolicyFileOffThread, writeSheetOffThread } from './xlsxWorkerClient.js'

// ===== JSDoc 类型定义：a1 / a2 / a3 数据 shape（文档 / IDE 提示用）=====

/**
 * @typedef {Object} A1Item - Excel 解析后的原始行数据（parseXlsx 产出，持久化于 a1.json）
 * 新格式说明：文件表头只有 出发机场 / 到达机场 两列；航司/舱位由用户在 TopToolbar 输入，全局应用到所有行
 * @property {string} id - 唯一标识（形如 row_0）
 * @property {string} hangsi - 航司二字码（来自用户输入，如 FA）
 * @property {string} CF_jichang - 出发机场三字码（如 JNB）
 * @property {string} DD_jichang - 到达机场三字码（如 DUR）
 * @property {string} CH_city - 出发城市（新格式无此列，恒为空）
 * @property {string} DD_city - 到达城市（新格式无此列，恒为空）
 * @property {string} cangwei_str - 舱位序列（来自用户输入，逗号分隔，如 "Y,J,F"）
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
 * @property {string} _platform - 来源平台（trip / reserved）
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

    // 用户上传的外部政策文件路径（仅内存、不持久化）
    //   注意：不随 clearAll 清空（换航线文件会触发 clearAll，若在此清掉会导致回写被静默跳过）；
    //         仅在上传新政策文件时覆盖、下载成功后由 controller 显式清空
    this.policyFilePath = ''
    // ★ 2026-09-29 起：上传时即解析驻留的 { headers, keyColMap, rows }（异常航线判定任务期用）
    this.policyFileData = null
    // ★ 2026-09-30：驻留解析结果对应的文件指纹，导出时用它判断能否复用（省一次同步读盘）
    this.policyFileStat = null

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
   * 解析规则（新格式：航司/舱位/航线都在文件内）：
   *   第 1 行：["航司", "<航司二字码>"]        全局航司，应用到所有航线
   *   第 2 行：["舱位", "<舱位序列逗号分隔>"]  全局舱位，应用到所有航线
   *   第 3 行：["航线", null]                  表头（仅占位，内容不校验）
   *   第 4 行起：每行一条航线 [出发机场, 到达机场]
   * @param {string} filePath xlsx 文件路径
   */
  parseXlsx(filePath) {
    try {
      const workbook = XLSX.readFile(filePath)
      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      const aoa = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null })
      if (!Array.isArray(aoa) || aoa.length < 4) {
        return { success: false, error: 'Excel 内容不足 4 行（航司/舱位/表头/航线至少各 1 行），请用标准模板' }
      }

      // ------- R1 航司 / R2 舱位：全局值，应用到所有航线 -------
      const hangsi = String(aoa[0]?.[1] ?? '').trim()
      const cangwei = String(aoa[1]?.[1] ?? '').trim()
      if (!hangsi) return { success: false, error: '第 1 行缺少航司（B 列）' }
      if (!cangwei) return { success: false, error: '第 2 行缺少舱位（B 列）' }

      // ------- R3 表头 / R4+ 航线数据 -------
      const dataRows = aoa.slice(3).filter(r => r && r.some(c => c != null && String(c).trim() !== ''))

      // 遍历每条航线，每条航线生成一个任务进队列
      this.a1 = dataRows.map((row, index) => ({
        id: `row_${index}`,
        CF_jichang: String(row[0] ?? '').trim(),
        DD_jichang: String(row[1] ?? '').trim(),
        CH_city: '',
        DD_city: '',
        hangsi,
        cangwei_str: cangwei
      }))

      // 校验航线完整性
      const incomplete = this.a1.filter(r => !r.CF_jichang || !r.DD_jichang)
      if (incomplete.length > 0) {
        return { success: false, error: `第 ${incomplete.length} 条航线缺少出发机场或到达机场` }
      }

      this.saveData('a1.json', this.a1)

      // console.log(`[parseXlsx] 解析完成：行数=${this.a1.length}，hangsi=${hangsi}，cangwei_str=${cangwei}`)
      return {
        success: true,
        fileName: path.basename(filePath),
        count: this.a1.length,
        hangsi,
        cangwei,
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

  /**
   * 记录政策文件路径并**同步**解析驻留（进程内变体）
   *   ★ 2026-09-30 起上传走 preparePolicyFile（worker 线程解析，避免 2.6s 主线程阻塞）；
   *     本方法保留给进程内场景/测试用，行为与改造前一致。
   * @param {string} filePath xlsx 文件路径
   */
  setPolicyFilePath(filePath) {
    this.policyFilePath = filePath || ''
    // ★ 2026-09-29 起：上传即解析驻留（异常航线判定在任务期就要用；下载回写仍可复用本数据）
    if (this.policyFilePath) {
      const parsed = this.readPolicyFile(this.policyFilePath)
      this.policyFileData = parsed.success ? parsed : null
      // ★ 2026-09-30：记下解析时的文件指纹 → 导出时文件没变就直接复用，不再同步读盘
      this.policyFileStat = this._policyFileFingerprint(this.policyFilePath)
    } else {
      this.policyFileData = null
      this.policyFileStat = null
    }
  }

  /** 政策文件指纹（mtimeMs + size）：判断驻留的解析结果是否仍对应当前文件 */
  _policyFileFingerprint(filePath) {
    try {
      const st = fs.statSync(filePath)
      return { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  }

  /**
   * 记录政策文件路径并**在 worker 线程**完成解析驻留（2026-09-30，上传时调用）
   *   为什么放 worker：SheetJS readFile 是同步调用，真实政策文件（4935 行 × 147 列 / 23.68MB）
   *   实测 readFile 2.6s + sheet_to_json 0.2s，是一段不可打断的主线程阻塞（窗口"未响应"）。
   *   worker 不可用/失败 → 自动回退到进程内 readPolicyFile（= 改造前行为）。
   * @param {string} filePath xlsx 路径
   * @returns {Promise<{success:boolean, fileName?:string, error?:string}>}
   */
  async preparePolicyFile(filePath) {
    this.policyFilePath = filePath || ''
    if (!this.policyFilePath) {
      this.policyFileData = null
      this.policyFileStat = null
      return { success: true, fileName: '' }
    }
    const stat = this._policyFileFingerprint(this.policyFilePath)
    const offThread = await readPolicyFileOffThread(this.policyFilePath)
    const parsed = offThread || this.readPolicyFile(this.policyFilePath)
    this.policyFileData = parsed.success ? parsed : null
    this.policyFileStat = stat
    if (!parsed.success) console.warn('[FileManager] 政策文件解析失败:', parsed.error)
    return parsed
  }

  /**
   * 取当前政策文件的解析结果 { headers, keyColMap, rows }：
   *   优先复用上传时驻留的 policyFileData（文件未变化时）—— 避免导出阶段再跑一次
   *   同步 XLSX.readFile + sheet_to_json（实测 2 万行 ≈ 2.2 s、10 万行 ≈ 11 s 的
   *   **不可打断**主线程阻塞，正是下载时窗口"未响应"的主因）；
   *   文件被外部改动过（mtime/size 变了）→ 才真正重新读盘并刷新驻留。
   * @returns {{success:true,...}|{success:false,error:string}}
   */
  getPolicyFileData() {
    const p = this.policyFilePath
    if (!p) return { success: false, error: '未记录政策文件路径' }
    const fp = this._policyFileFingerprint(p)
    if (this.policyFileData && fp && this.policyFileStat &&
        fp.mtimeMs === this.policyFileStat.mtimeMs && fp.size === this.policyFileStat.size) {
      return this.policyFileData
    }
    const parsed = this.readPolicyFile(p)
    if (parsed.success) {
      this.policyFileData = parsed
      this.policyFileStat = fp
    }
    return parsed
  }

  /** 是否已记录政策文件路径（下载回写模式的开关） */
  hasPolicyFilePath() {
    return !!this.policyFilePath
  }

  /** 取已记录的政策文件路径（未上传为 ''） */
  getPolicyFilePath() {
    return this.policyFilePath
  }

  /** 清空已记录的政策文件路径（下载成功后调用） */
  clearPolicyFilePath() {
    this.policyFilePath = ''
    this.policyFileData = null
    this.policyFileStat = null
  }

  /**
   * 读取并解析外部系统（携程）导出的政策文件（xlsx），供下载回写使用
   *   惰性加载：上传时只记路径，真正要用时（下载）才调本方法读盘。
   *   表头按列名匹配（buildHeaderKeyMap）：9 匹配键 + ID + CreateTime 共 11 列必须齐全；
   *   表头默认第一行，若首行无 OTAConfigID/航程类型 则顺延试下一行（至多两行）。
   *   数据行保留原始单元格类型（number/string/null），供回写 aoa 保真。
   *   纯读取：不写任何实例状态（无副作用），失败时返回可读错误由调用方决定如何处理。
   * @param {string} filePath xlsx 文件路径
   * @returns {{success:true, headers:string[], keyColMap:object, rows:any[][]} | {success:false, error:string}}
   */
  readPolicyFile(filePath) {
    if (!filePath) return { success: false, error: '未记录政策文件路径' }
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `政策文件已不存在（可能被移动或删除）: ${filePath}` }
      }
      const workbook = XLSX.readFile(filePath)
      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      const aoa = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null })
      // ★ 2026-09-30：表头定位/必填列校验/空行过滤收敛到纯函数 parsePolicyAoa，
      //   与 worker 线程读盘共用同一实现（两条路径结果必然一致）
      return parsePolicyAoa(aoa, path.basename(filePath))
    } catch (error) {
      return { success: false, error: error.message }
    }
  }

  // 获取 a2 数据
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
   *     不动 policyFilePath（已记录的政策回写文件路径；换航线文件也会触发本方法，
   *       若在此清掉会导致下载时回写被静默跳过 → ID/CreateTime 为空）
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
   *   阶段4 重构：每 O 平台一份异构 xlsx 列模板（trip/reserved 各自 adapter.exportTemplate）
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
    //   （旧版 runCombo 返回 { trip:{...}, ... } 聚合体，此处按 task.type 直接取）
    const a3arr = []
    const stats = {}
    O_PLATFORMS.forEach(p => { stats[p] = { okTasks: 0, failedTasks: 0, processedSum: 0 } })

    // ★ 无匹配携程数据（2026-09-23 起）：trip 任务 quoteRows 附加行（kind='other'，
    //   品牌对不上/无套餐可归属的报价）收集起来供底价检查文件展示
    //   （任务列表/运行日志已展示；此处补齐人看文件，导出时读 this.tripOtherQuotes）
    const tripOtherQuotes = []
    // ★ 完整对比行（2026-09-26 起）：saveA3FromOTasks 把 trip 任务的全部 quoteRows
    //   （官网行 + 携程行 + 附加行）收集起来，供底价检查文件按「官网行 + 匹配携程行」展开
    const tripQuoteRows = []
    // ★ 无投放对比块（2026-09-29 起）：trip 任务 summary.noBidBlocks（携程无任何投放的
    //   官网对比块），供导出阶段与用户政策文件五列（航司名/机场航线匹配/舱位/去程套餐索引v2/
    //   航程类型）比对后生成「异常航线（无投放）」文件
    //   （判定本身已在任务期由 trip adapter 完成，见 policyWriteback.adjustAbnormalPackageSummary；
    //    此处仅收集原料供导出用）
    const tripNoBidBlocks = []

    // 预取各平台配置 + exportTemplate + 锦绣政策字段配置（航司私有化：按当前文件航司取）
    //   from(item, ctx) 的 ctx = { ...平台配置, policyFields }：
    //     - 平台配置（cfg）：adapter 内部用（如 trip 无）
    //     - policyFields：锦绣政策字段配置（新格式 Name/航司名 等 10 字段的用户填写值）
    //       导出模板里 pf(key) 列经 resolvePolicyField 解析 ${变量} 拼接
    const hangsi = String(this.a1?.[0]?.hangsi || '').trim()
    const airline = (hangsi && this.configManager)
      ? this.configManager.getAirlineConfig(hangsi)
      : null
    const policyFields = airline?.policyFields || {}
    const airlinePlatform = airline?.platform || {}
    const platformCtx = {}
    for (const p of O_PLATFORMS) {
      let template = null
      try { template = registry.get(p)?.exportTemplate || null } catch { template = null }
      const cfg = airlinePlatform[p] || {}
      platformCtx[p] = { template, ctx: { ...cfg, policyFields } }
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
      // ★ 收集携程对比行：附加行（无对应）+ 完整 quoteRows（官网行/携程行，供底价检查文件）
      if (p === 'trip' && Array.isArray(result.quoteRows)) {
        for (const q of result.quoteRows) {
          if (q && q.kind === 'other') tripOtherQuotes.push(q)
          if (q) tripQuoteRows.push(q)
        }
      }
      if (p === 'trip' && Array.isArray(result?.summary?.noBidBlocks)) {
        for (const b of result.summary.noBidBlocks) tripNoBidBlocks.push(b)
      }
      // ★ 异常航线统计（2026-09-29 改）：已由 trip adapter 在任务完成时即时计入 summary
      //   （政策条目随运行时配置快照注入），此处不再修正，避免重复计数
      const processedData = result.processedData
      if (!Array.isArray(processedData)) return
      stats[p].okTasks++
      stats[p].processedSum += processedData.length

      // 2. 没配 exportTemplate（如 O2/O3 未实现）→ 跳过，不产出政策行
      const { template, ctx } = platformCtx[p]
      if (!template || !Array.isArray(template.columns)) return

      // 3. 按 template.columns 生成每行（保持列顺序，xlsx 标题行由此决定）
      //    from(item, ctx)：ctx 含平台配置 + policyFields，新格式锦绣字段在此解析 ${变量}
      for (const item of processedData) {
        const row = { _platform: p }
        for (const col of template.columns) {
          if (typeof col.from === 'function') {
            row[col.key] = col.from(item, ctx)
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
        // 是否显示（2026-09-26）：showState 供底价检查文件「是否显示」列；
        //   ownShowState = 我方报价自身的 showState（isOwn=true 行用，与 isOwn 同源）
        row['showState'] = item['showState']
        row['ownShowState'] = item['ownShowState']
        a3arr.push(row)
      }
    })

    const summary = O_PLATFORMS.map(p => `${p}: ok=${stats[p].okTasks} fail=${stats[p].failedTasks} processed=${stats[p].processedSum}`).join('；')
    // console.log(`[saveA3FromOTasks] 总 O 任务数=${tasks.length}；${summary} → a3 条数=${a3arr.length}`)
    this.a3 = a3arr
    this.tripOtherQuotes = tripOtherQuotes
    this.tripQuoteRows = tripQuoteRows
    this.tripNoBidBlocks = tripNoBidBlocks
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
  async exportResult(dir, _filename = 'result.xlsx', onProgress = () => { }, opts = {}) {
    return await this._excelExporter.exportResult(dir, _filename, onProgress, opts)
  }

  // 写入 JSON 数据到 data 目录
  //   ★ 2026-09-30：改「异步写 + 不缩进」——原来 JSON.stringify(data, null, 2) + writeFileSync
  //     是同步大调用，且落盘时机正好在"跑完任务瞬间"（saveStageResults），
  //     真实跑批 a3 可达数十 MB（缩进还会让体积再放大约 1.4 倍、CPU 翻倍），
  //     会在主进程造成秒级不可打断阻塞。缩进对 data 目录缓存没有意义（人是看导出的 xlsx）。
  //     注：JSON.stringify 本身仍是同步的（百毫秒量级）；如需彻底消除，见"导出/落盘移出主线程"方案。
  saveData(filename, data) {
    const filePath = path.join(this.dataDir, filename)
    Promise.resolve()
      .then(() => fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8'))
      .catch(e => console.warn(`[FileManager.saveData] ${filename} 落盘失败:`, e?.message))
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
