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
        :value="activeKey"
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
import { h, ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { NIcon, NMenu, NLayout, NLayoutSider, NLayoutContent } from 'naive-ui'
import { features } from '@/shared/featureRegistry'
import { unlockedState, installSecretCodeListener } from '@/shared/secretUnlock'

// 侧边栏折叠态：默认折叠（只显示图标）
const collapsed = ref(true)

const route = useRoute()
const router = useRouter()

// 渲染图标的工厂函数（n-menu 的 icon 字段需要返回渲染函数）
function renderIcon(icon) {
  return () => h(NIcon, null, { default: () => h(icon) })
}

// 可见菜单项：默认隐藏（menuHidden）的功能需通过组合键解锁后才显示
const menuOptions = computed(() =>
  features
    .filter((f) => !f.menuHidden || !!unlockedState[f.key])
    .map(feature => ({
      label: () => h(RouterLink, { to: feature.path }, { default: () => feature.label }),
      key: feature.key,
      icon: feature.icon ? renderIcon(feature.icon) : undefined
    }))
)

// 当前路由 → 菜单选中 key（补上此前缺失的菜单高亮）
const activeKey = computed(() => {
  const p = route.path
  const hit = features.find((f) => p === f.path || p.startsWith(f.path + '/'))
  return hit ? hit.key : null
})

// 组合键 tj3599：显示/隐藏 ass 入口（显示时切换选中到 ass；隐藏时若正停在 ass 则跳回第一个功能）
let removeKeyListener = null
onMounted(() => {
  removeKeyListener = installSecretCodeListener((visible) => {
    if (visible) {
      router.push('/ass')
    } else if (route.path.startsWith('/ass')) {
      const first = features[0]
      if (first) router.push(first.path)
    }
  })
})
onBeforeUnmount(() => {
  if (removeKeyListener) removeKeyListener()
})
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
