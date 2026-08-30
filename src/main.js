// ============================================================
// 渲染层入口
// 职责：创建 Vue 应用，挂载 Pinia（含持久化插件）、Vue Router、Naive UI
//
// 设计要点：
//   - Pinia + persistedstate：ERC store 用 persist:true 持久化汇率数据，避免每次启动都重新拉接口
//   - Vue Router 用 createWebHashHistory（Electron 本地文件场景稳，刷新/直接访问子路由不会 404）
//   - Naive UI 用 app.use(naive) 全量注册：内部工具场景省心，避免每个组件按需 import 的样板代码
// ============================================================

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createPersistedState } from 'pinia-plugin-persistedstate'
// import naive from 'naive-ui'
//   .use(naive)

import App from './App.vue'
import router from './router'

// 创建 Pinia 实例，并启用 persistedstate 插件
const pinia = createPinia()
pinia.use(createPersistedState())

// ⚠️ 临时预览：延迟 1 秒再挂载，方便查看 index.html 启动遮罩样式；预览完删除此 setTimeout 包裹
// setTimeout(() => {
  createApp(App)
    .use(router)
    .use(pinia)
    .mount('#app')
// }, 1000)
