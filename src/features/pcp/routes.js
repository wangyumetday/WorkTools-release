// ============================================================
// PCP 路由定义
// 职责：声明 PCP feature 的所有子路由，挂载到主壳 / 和悬浮窗壳 /floating 的 children
//
// 路由表：
//   /pcp  →  Home.vue（比价工具主页：账密管理 + 平台配置 + 步骤器 + 任务监控）
// ============================================================

import Home from './views/Home.vue'

export const routes = [
  {
    // 相对路径：作为父路由 children 时由父路由决定前缀
    //   - 挂到 AppShell（path '/'）下 → 最终路径 /pcp
    path: 'pcp',
    name: 'PriceComparisonPolicy',
    component: Home
  }
]
