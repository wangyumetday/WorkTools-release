// ============================================================
// 全局 message 工具（基于 Naive UI 的 createDiscreteApi）
// 职责：在任意位置（包括 store、组件外）调用 message.success/error/warning/info
//
// 使用方式：
//   import message from '@/shared/message.js'
//   message.success('保存成功')
//
// 设计要点：
//   - createDiscreteApi 创建独立于 <n-message-provider> 的 message 实例
//     （可在 Pinia store 等非组件环境直接用，不依赖组件树上下文）
//   - 必须显式传入 configProviderProps（哪怕是空对象），否则样式注入会失败
//     （Naive UI v2.40+ 的已知行为）
// ============================================================

import { createDiscreteApi } from 'naive-ui'

const { message } = createDiscreteApi(
  ['message'],
  {
    // 必须提供 configProviderProps，否则 createDiscreteApi 内部会因找不到注入上下文报错
    configProviderProps: {
      // 如需切换深色主题，可改为 theme: darkTheme
      theme: null
    },
    messageProviderProps: {
      // 消息默认停留时长（毫秒）
      duration: 2500,
      // 是否显示关闭按钮
      closable: false,
      // 最大显示数量，超过则关闭最早的
      max: 10
    }
  }
)

export default message
