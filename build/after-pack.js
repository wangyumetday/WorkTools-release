// ============================================================
// electron-builder afterPack 钩子：Windows 产物"极致减体积 + 防锁清理"专用
//
// 触发时机：electron-builder 把文件复制到 pack-out-dir（win-unpacked）后、
//         打包 nsis 安装器之前。
// 额外清理：nsis 打包完会复制一份 win-unpacked 到 win-unpacked.tmp，
//           然后想删除时被 Windows 资源管理器/杀毒软件锁着，就报 EBUSY rmdir；
//           这里在 afterPack 末尾顺手做一次"重试删 win-unpacked.tmp 兄弟目录"，
//           避免整个构建链路最后一步崩成红色日志（即使不影响安装包本身）。
//
// 参考业界做法：
//   - https://www.electron.build/configuration/configuration#afterpack
//   - electron 官方分发指南：locale 白名单、可选 dll 裁剪
// ============================================================

const fs = require('node:fs')
const path = require('node:path')

/**
 * 删除文件（不存在时静默，失败时 warn）
 * @param {string} filePath 绝对路径
 */
function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (e) {
    console.warn(`[afterPack] unlink 失败: ${filePath} → ${e.message}`)
  }
}

/**
 * 递归删除目录（带重试，最大 3 次，每次间隔 300ms）
 *   — Windows 下 Explorer / Defender / Indexer 偶发短暂锁目录，
 *     重试 + 短 sleep 能覆盖 90% 以上的 EBUSY rmdir
 * @param {string} dirPath
 * @param {number} retries
 */
function safeRmdir(dirPath, retries = 3) {
  if (!fs.existsSync(dirPath)) return true
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3 })
      return true
    } catch (e) {
      if (i === retries - 1) {
        console.warn(`[afterPack] rmdir 重试 ${retries} 次仍失败: ${dirPath} → ${e.message}`)
        return false
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    }
  }
  return false
}

/** 递归计算目录大小（字节） */
function dirSize(dir) {
  let s = 0
  const walk = (d) => {
    const list = fs.readdirSync(d, { withFileTypes: true })
    for (const e of list) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) s += fs.statSync(p).size
    }
  }
  try { walk(dir) } catch (_) {}
  return s
}

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const platformName = (packager.appInfo || packager.platform)
    ? (packager.platform?.nodeName ?? packager.platform?.buildConfigurationKey ?? 'unknown')
    : 'unknown'

  const isWin = platformName === 'win' || /win[\\/-]?unpacked/i.test(appOutDir)
  if (!isWin) {
    console.log(`[afterPack] 非 Windows 平台(${platformName})，跳过产物裁剪: ${appOutDir}`)
    return
  }

  const sizeBefore = dirSize(appOutDir)
  console.log(`[afterPack] 开始裁剪 Windows 产物，目录: ${appOutDir}`)

  // ====== 1. locales 目录精简：只保留中英（zh-CN、zh-TW、en-US）======
  const localesDir = path.join(appOutDir, 'locales')
  if (fs.existsSync(localesDir)) {
    const keep = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak'])
    const files = fs.readdirSync(localesDir)
    let deleted = 0
    for (const f of files) {
      if (!keep.has(f)) {
        safeUnlink(path.join(localesDir, f))
        deleted++
      }
    }
    console.log(`[afterPack] locales: 删除 ${deleted} 个，保留 ${keep.size} 个 (${[...keep].join(',')})`)
  }

  // ====== 2. 顶层可选 DLL / pak 精简 ======
  const optionalFiles = [
    // WebGPU / Vulkan / SwiftShader 硬件加速 fallback（办公表单应用用不上，约 15MB）
    'dxil.dll',
    'dxcompiler.dll',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
    // 200% DPI 高分屏 pak（约 4~5MB）；高 DPI 屏幕图标模糊时恢复即可
    'chrome_200_percent.pak'
  ]
  let removed = 0
  for (const fname of optionalFiles) {
    const full = path.join(appOutDir, fname)
    if (fs.existsSync(full)) { safeUnlink(full); removed++ }
  }
  console.log(`[afterPack] optional files: 删除 ${removed}/${optionalFiles.length} 个`)

  // ====== 3. 清理残留的 win-unpacked.tmp 临时目录（根治 EBUSY rmdir 报警）======
  const parentDir = path.dirname(appOutDir)
  const tmpSiblings = fs.readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^win-unpacked\.tmp(\.\d+)?$/i.test(e.name))
  for (const e of tmpSiblings) {
    const p = path.join(parentDir, e.name)
    console.log(`[afterPack] 清理残留临时目录: ${p}`)
    safeRmdir(p)
  }

  const sizeAfter = dirSize(appOutDir)
  const freed = Math.max(0, sizeBefore - sizeAfter)
  console.log(
    `[afterPack] 裁剪完成: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB → ${(sizeAfter / 1024 / 1024).toFixed(2)} MB，节省 ${(freed / 1024 / 1024).toFixed(2)} MB`
  )
}
