// ============================================================
// 全局 dialog 工具（基于 Naive UI 的 createDiscreteApi）
// 职责：在任意位置（包括 store、组件外）调用 dialog.warning/confirm 弹出软件内部确认框
//
// 使用方式：
//   import dialog from '@/shared/dialog.js'
//   dialog.warning({
//     title: '标题',
//     content: '内容',
//     positiveText: '确定按钮文字',
//     negativeText: '取消按钮文字',
//     onPositiveClick: () => { ...用户点确定时执行... }
//   })
//
//   或 promise 风格：
//   const ok = await dialog.confirm({ title, content, positiveText, negativeText })
//   if (ok) { ... }
//
// 设计要点：
//   - 和 message.js 同样的离散 API 方案，不依赖 <n-dialog-provider>
//     （可在 Pinia store 等非组件环境直接用）
//   - 必须显式传入 configProviderProps（哪怕是空对象），否则样式注入失败
// ============================================================

import { createDiscreteApi } from 'naive-ui'

const { dialog } = createDiscreteApi(
  ['dialog'],
  {
    configProviderProps: {
      // 如需切换深色主题，可改为 theme: darkTheme
      theme: null
    },
    dialogProviderProps: {
      // 点击遮罩不关闭（避免误触取消安装）
      maskClosable: false,
      // 按 Esc 不关闭
      closeOnEsc: false
    }
  }
)

/**
 * Promise 风格的确认框：返回 true=用户点了确定 / false=用户取消
 *   比事件回调风格更易读，也方便在 async 函数里 await
 */
function confirm({ title, content, positiveText = '确定', negativeText = '取消', type = 'warning' }) {
  return new Promise((resolve) => {
    dialog[type]({
      title,
      content,
      positiveText,
      negativeText,
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false) // 点右上角叉也当取消
    })
  })
}

export default {
  ...dialog,      // 保留 warning/success/error/info/create 等原生方法
  confirm         // 追加 promise 风格的 confirm
}
