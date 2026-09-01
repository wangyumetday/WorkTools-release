// ============================================================
// 隐藏功能入口解锁（组合键开关）
//
// 需求：ass 模块在左侧功能栏默认不显示入口；
//       用户在主窗口内依次键入组合键 tj3599：
//         第一次 → 显示 ass 入口并跳转选中
//         再按一次 → 隐藏 ass 入口（若当前停在 ass 页则跳回第一个功能）
//
// 实现：全局 keydown 监听 + 滚动缓冲后缀匹配（作弊码式），
//       状态为内存态：每次启动应用都回到隐藏状态。
// ============================================================

import { reactive } from 'vue'

const SEQUENCE = 'tj3599'

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