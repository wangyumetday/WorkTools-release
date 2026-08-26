// ============================================================
// 全局 notification 工具（基于 Naive UI 的 createDiscreteApi）
// 职责：在任意位置（包括 store、组件外）调用 notification.error/warning/info
//
// 使用方式：
//   import notification from '@/shared/notification.js'
//   notification.error({ title: '错误', content: '...', duration: null })
//
// 设计要点：
//   - createDiscreteApi 创建独立于 <n-notification-provider> 的 notification 实例
//     （可在 Pinia store 等非组件环境直接用，不依赖组件树上下文）
//   - duration: null 表示不自动关闭（用于错误弹窗，需用户手动关闭）
//   - 同类型错误堆叠：调用方用 key 控制去重，这里不做内部去重
// ============================================================

import { createDiscreteApi } from 'naive-ui'

const { notification } = createDiscreteApi(
  ['notification'],
  {
    configProviderProps: {
      theme: null
    },
    notificationProviderProps: {
      // 默认不自动关闭（用于错误弹窗，需用户手动关闭）
      duration: null,
      closable: true,
      // 最大显示数量，超过则关闭最早的（避免错误多时堆满屏幕）
      max: 8
    }
  }
)

export default notification
