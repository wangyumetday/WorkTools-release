// ============================================================
// ERC 路由定义
// 职责：声明 ERC feature 的所有子路由，挂载到主壳 / 和悬浮窗壳 /floating 的 children
//
// 路由表：
//   /erc  →  Home.vue（汇率转换主页：顶部 tabs 切换"汇率转换/全部币种"）
//
// 悬浮窗复用：/floating 的 children 由 router/index.js 单独定义并指向
//   FloatingHome.vue（悬浮窗专用紧凑布局），不复用本 routes 引用，
//   避免与主壳 /erc 路由互相覆盖，且让悬浮窗有独立的紧凑 UI
// ============================================================

import Home from './views/Home.vue'

export const routes = [
  {
    // 相对路径：作为父路由 children 时由父路由决定前缀
    //   - 挂到 AppShell（path '/'）下 → 最终路径 /erc
    //   - 挂到 FloatingShell（path '/floating'）下 → 最终路径 /floating/erc
    path: 'erc',
    name: 'ExchangeRateConversion',
    component: Home
  }
]
