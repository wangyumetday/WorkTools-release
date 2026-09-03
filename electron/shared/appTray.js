// ============================================================
// 系统托盘（后台挂起）
// 职责：
//   - 在系统托盘驻留图标。主窗口"后台挂起"（hide）后用户仍可：
//       左键点击 / 菜单"显示主窗口" → 恢复并聚焦主窗口
//       菜单"退出 Work Tools"       → 真正退出应用
//   - 托盘图标运行时生成（零依赖 PNG 编码器 + nativeImage），
//     不依赖静态图标文件 / 打包资源路径，dev 与打包后表现一致
// 注意：tray 必须保持模块级引用，否则被 V8 GC 回收后图标会消失、
//       右键菜单失效（Electron Tray 是宿主资源，JS 侧无引用即释放）
// ============================================================
import { Tray, Menu, nativeImage } from 'electron'
import zlib from 'node:zlib'

let tray = null
// 菜单回调（createAppTray 注入，模块级持有以便 rebuild 菜单时复用）
let handlers = {}

// ---------------- 极简 PNG 编码器（32x32 RGBA 青色圆环） ----------------
// 为什么自己编码：项目没有任何应用图标文件，且不应在 JS 里硬编码伪造的
// 二进制图标。PNG = 签名 + IHDR/IDAT/IEND 块，IDAT 是 zlib 压缩的原始
// 扫描行，用 node:zlib 即可合法生成，dev/打包路径无关。
function buildCrcTable() {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
}
const CRC_TABLE = buildCrcTable()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

// 生成青色圆环（硬币感）图标 → NativeImage。外圈半径 14、内孔半径 8.5，
// 内外缘各做 1px 抗锯齿；颜色取悬浮窗强调色 #00ffff，深/浅任务栏都醒目。
function buildTrayIcon() {
  const size = 32
  const c = (size - 1) / 2
  const outer = 14
  const inner = 8.5
  const raw = Buffer.alloc((size * 4 + 1) * size)
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // 每行首字节：PNG filter type 0（无滤波）
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - c, y - c)
      let a = 0
      if (dist <= outer && dist >= inner) a = 255
      // 外缘抗锯齿（由外向内渐显）
      if (dist > outer - 1 && dist <= outer + 0.5) {
        a = Math.round(255 * Math.max(0, Math.min(1, outer + 0.5 - dist)))
      }
      // 内缘抗锯齿（内孔边界由透明渐入青色）
      if (dist < inner + 1 && dist > inner - 0.5) {
        a = Math.round(255 * Math.max(0, Math.min(1, dist - (inner - 0.5))))
      }
      if (dist > outer + 0.5 || dist < inner - 0.5) a = 0
      raw[p++] = 0     // R
      raw[p++] = 255   // G  #00ffff
      raw[p++] = 255   // B
      raw[p++] = a     // A
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0) // 宽
  ihdr.writeUInt32BE(size, 4) // 高
  ihdr[8] = 8                 // bit depth = 8
  ihdr[9] = 6                 // color type = 6（RGBA）
  // [10] compression 0 / [11] filter 0 / [12] interlace 0，Buffer 默认 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return nativeImage.createFromBuffer(png)
}

// 构建托盘右键菜单。关闭行为三个 radio 每次都读 getClosePref() 的最新值，
// 保证偏好被对话框/别处修改后，重建菜单即可同步勾选态。
function buildMenu() {
  const pref = handlers.getClosePref?.() ?? 'ask'
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => handlers.onShow?.() },
    {
      label: '关闭主窗口时',
      submenu: [
        { label: '每次询问', type: 'radio', checked: pref === 'ask',
          click: () => handlers.onSetClosePref?.('ask') },
        { label: '后台挂起（保留悬浮窗）', type: 'radio', checked: pref === 'tray',
          click: () => handlers.onSetClosePref?.('tray') },
        { label: '直接关闭软件', type: 'radio', checked: pref === 'quit',
          click: () => handlers.onSetClosePref?.('quit') }
      ]
    },
    { type: 'separator' },
    { label: '退出 Work Tools', click: () => handlers.onQuit?.() }
  ])
}

// 创建系统托盘。重复调用幂等（已存在则直接返回）。
//   onShow：恢复主窗口；onQuit：真正退出；
//   getClosePref/onSetClosePref：关闭偏好（ask/tray/quit）的读写，供 radio 子菜单
export function createAppTray(opts = {}) {
  handlers = opts
  if (tray) { tray.setContextMenu(buildMenu()); return tray }
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('Work Tools（点击恢复主窗口）')
  tray.setContextMenu(buildMenu())
  // Windows 左键点击托盘图标 = 恢复主窗口
  tray.on('click', () => handlers.onShow?.())
  return tray
}

// 偏好变更后重建菜单，让 radio 勾选态与持久化值保持一致
export function refreshAppTrayMenu() {
  if (tray) tray.setContextMenu(buildMenu())
}

export function destroyAppTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
