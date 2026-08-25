<!-- ============================================================
     AppShell.vue - 主壳
     职责：左侧边栏（可折叠）+ 内容区 router-view（带 keep-alive 保活）
     数据流：
       - 从 featureRegistry 读 features 列表生成菜单
       - 点击菜单项 → router.push(feature.path) 切换 feature
       - router-view 用 keep-alive 包裹：切走的 feature 组件不卸载
         状态/定时器/订阅/滚动位置全保留，符合"功能独立运行、切换不中断"需求
     说明：supportsFloating 的"打开悬浮窗"按钮放在各 feature 视图内部，
           不放在侧边栏，符合"功能独立"原则
     ============================================================ -->

<template>
  <n-layout has-sider class="app-shell">
    <!-- 左侧边栏：可折叠 -->
    <n-layout-sider
      bordered
      collapse-mode="width"
      :collapsed-width="52"
      :width="180"
      :collapsed="collapsed"
      show-trigger
      @collapse="collapsed = true"
      @expand="collapsed = false"
    >
      <n-menu
        :collapsed="collapsed"
        :collapsed-width="52"
        :collapsed-icon-size="22"
        :options="menuOptions"
      />
    </n-layout-sider>

    <!-- 内容区：渲染当前 feature 的视图，keep-alive 让切走的 feature 不卸载 -->
    <n-layout-content class="content" :native-scrollbar="false">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { h, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { NIcon, NMenu, NLayout, NLayoutSider, NLayoutContent } from 'naive-ui'
import { features } from '@/shared/featureRegistry'

// 侧边栏折叠态：默认折叠（只显示图标）
const collapsed = ref(true)

// 渲染图标的工厂函数（n-menu 的 icon 字段需要返回渲染函数）
function renderIcon(icon) {
  return () => h(NIcon, null, { default: () => h(icon) })
}

// 从 features 生成菜单项：每个 feature 一项，点击跳转到对应 path
const menuOptions = features.map(feature => ({
  label: () => h(RouterLink, { to: feature.path }, { default: () => feature.label }),
  key: feature.key,
  icon: feature.icon ? renderIcon(feature.icon) : undefined
}))
</script>

<style scoped>
.app-shell {
  width: 100%;
  height: 100vh;
}

.content {
  width: 100%;
  height: 100%;
  overflow: auto;
}
</style>
