// ============================================================
// ASS 路由定义
// 职责：声明 ASS feature 的入口路由，挂载到主壳 / 的 children
//
// 路由表：
//   /ass  →  HomeCanvas.vue（统计代理画布：单节点挂载 Home.vue 整页）
// ============================================================

import HomeCanvas from './views/HomeCanvas.vue'

export const routes = [
  {
    path: 'ass',
    name: 'AgentStatistics',
    component: HomeCanvas
  }
]
