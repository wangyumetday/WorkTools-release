// ============================================================
// 隐藏功能入口解锁（组合键开关）
//
// 需求1：ass 模块在左侧功能栏默认不显示入口；
//        用户在主窗口内依次键入组合键 tj3599：
//          第一次 → 显示 ass 入口并跳转选中
//          再按一次 → 隐藏 ass 入口（若当前停在 ass 页则跳回第一个功能）
//
// 需求2：PCP 的 Dev 模式切换由密码驱动；
//        用户按住左 Ctrl 不松，再依次按 8 8 8 8 → 翻转 auto/dev 模式；
//        Dev 开启时左下角显示 <n-tag>Dev:On</n-tag> 标识，关闭则不显示。
//
// 实现：全局 keydown 监听 + 滚动缓冲后缀匹配（作弊码式），
//       状态为内存态：每次启动应用都回到隐藏状态。
// ============================================================

import { reactive } from 'vue'

const SEQUENCE = 'tj3599'
const DEV_DIGITS = '8888'

/** 隐藏功能解锁状态（内存态；key = featureKey） */
export const unlockedState = reactive({
  ass: false,
})

/**
 * 安装组合键监听（AppShell 挂载时调用一次）
 * @param {(visible: boolean) => void} onToggle 状态翻转后的回调
 * @returns {() => void} 卸载函数
 */
export function installSecretCodeListener(onToggle) {
  let buffer = ''
  const handler = (e) => {
    const key = e.key ?? ''
    // 只累计可打印单字符（忽略 Shift/Ctrl 等修饰键与组合键）
    if (key.length !== 1) return
    buffer = (buffer + key.toLowerCase()).slice(-SEQUENCE.length)
    if (buffer === SEQUENCE) {
      unlockedState.ass = !unlockedState.ass
      buffer = '' // 触发后清空，避免连按重复翻转
      if (typeof onToggle === 'function') onToggle(unlockedState.ass)
    }
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}

/**
 * 安装 PCP Dev 模式组合键监听（Home.vue 挂载时调用一次）
 * 密码：按住左 Ctrl 不松，再依次按 8 8 8 8 → 触发 onToggle 回调
 *   由 Home.vue 回调内翻转 store 的 auto/dev 模式
 * @param {() => void} onToggle 触发回调（无参，由调用方自行决定翻转方向）
 * @returns {() => void} 卸载函数
 */
export function installPcpDevListener(onToggle) {
  let buffer = ''
  let leftCtrlHeld = false
  const onKeyDown = (e) => {
    // 跟踪左 Ctrl 按下（右 Ctrl 不算）
    if (e.code === 'ControlLeft') { leftCtrlHeld = true; return }
    // 仅在左 Ctrl 按住时累计数字 8
    if (!leftCtrlHeld || !e.ctrlKey) return
    // 中途按别的键则清空序列
    if (e.key !== '8') { buffer = ''; return }
    buffer = (buffer + e.key).slice(-DEV_DIGITS.length)
    if (buffer === DEV_DIGITS) {
      buffer = '' // 触发后清空，避免连按重复翻转
      if (typeof onToggle === 'function') onToggle()
    }
  }
  const onKeyUp = (e) => {
    // 松开左 Ctrl → 重置状态与缓冲
    if (e.code === 'ControlLeft') { leftCtrlHeld = false; buffer = '' }
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
  }
}