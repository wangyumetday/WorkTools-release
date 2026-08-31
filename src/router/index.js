// ============================================================
// 路由表
// 职责：定义主壳（左侧边栏）和悬浮窗壳两套路由
//
// 设计要点（保活架构）：
//   - 主壳 / 用 AppShell 包裹，children 是各 feature 路由
//   - AppShell 内 <router-view> 用 <keep-alive> 包裹（见 AppShell.vue）
//     → 切换功能时组件不卸载，状态/定时器/订阅全保留
//   - Pinia store 本就是全局单例，数据层也不丢
//   - 悬浮窗 /floating 用 FloatingShell，children 单独定义 ERC 路由
//     （不复用 ercRoutes 引用，避免与主壳 /erc 路由冲突被覆盖）
//
// 路由匹配关键约定（vue-router 4）：
//   - 父路由不能同时有 redirect + children，否则 children 失效
//     → 默认跳转用空子路径 '' redirect 实现
//   - route name 全局唯一，悬浮窗那份用 'floating-' 前缀
//   - 子路由用相对路径，由父路径决定前缀（/pcp、/erc、/floating/erc）
// ============================================================

import { createRouter, createWebHashHistory } from 'vue-router'
import AppShell from '@/shell/AppShell.vue'
import FloatingShell from '@/shell/FloatingShell.vue'
import { routes as pcpRoutes } from '@/features/pcp/routes'
import { routes as ercRoutes } from '@/features/erc/routes'
import { routes as assRoutes } from '@/features/ass/routes'
// 悬浮窗单独 import ERC Home：不复用 ercRoutes 引用，避免 vue-router
// 内部基于 path 做匹配记录时与主壳 /erc 路由互相覆盖
import ErcHome from '@/features/erc/views/Home.vue'

const routes = [
  {
    // 主壳：带左侧边栏，children 是各 feature 路由
    path: '/',
    component: AppShell,
    children: [
      // 空子路径 redirect 到 PCP（访问 / 时默认进比价工具）
      //   注意：必须放在 children 里，不能写在父路由 redirect 上
      //   （vue-router 4 父路由 redirect + children 共存时 children 会失效）
      { path: '', redirect: '/pcp' },
      ...pcpRoutes,
      ...ercRoutes,
      ...assRoutes
    ]
  },
  {
    // 悬浮窗壳：紧凑布局，不套 AppShell，独立窗口
    path: '/floating',
    component: FloatingShell,
    children: [
      // 空子路径 redirect 到 /floating/erc（悬浮窗承载 ERC 界面）
      { path: '', redirect: '/floating/erc' },
      // 单独定义路由对象，name 加 'floating-' 前缀避免与主壳 'erc' 冲突
      { path: 'erc', name: 'floating-erc', component: ErcHome }
    ]
  }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
