// ============================================================
// Feature 注册表
// 职责：声明所有 feature 的元信息，供 AppShell 生成左侧菜单
//
// 元信息字段：
//   - key:              feature 唯一标识（用于路由 key、IPC 命名空间）
//   - label:            菜单显示文字
//   - icon:             菜单图标（@vicons/ionicons5 的组件，null 表示暂无图标）
//   - path:             路由路径
//   - supportsFloating: 是否支持以悬浮窗模式打开
//
// 加新 feature 的步骤：
//   1. 在 src/features/<key>/ 下创建业务代码
//   2. 在 src/features/<key>/routes.js 导出 routes 数组
//   3. 在 src/router/index.js 合并该 feature 的 routes 到根路由 children（以及悬浮窗 children 如需）
//   4. 在本文件加入 features 数组
//
// 当前为骨架阶段：硬编码两个 feature 元信息
// 平移阶段：feature 的 routes 在 router/index.js 单独 import
// ============================================================

import { CubeOutline as CubeIcon, SwapHorizontalOutline as SwapIcon } from '@vicons/ionicons5'

export const features = [
  {
    key: 'pcp',
    label: '比价工具',
    name: 'PriceComparisonPolicy',
    icon: CubeIcon,
    path: '/pcp',
    supportsFloating: false
  },
  {
    key: 'erc',
    label: '汇率转换',
    name: 'ExchangeRateConversion',
    icon: SwapIcon,
    path: '/erc',
    supportsFloating: true
  },
  // {
  //   key: 'ass',
  //   name: 'AgentStatistics',
  //   label: '统计代理',
  //   icon: SwapIcon,
  //   path: '/ass',
  //   supportsFloating: false
  // }
]
