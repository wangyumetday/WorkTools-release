// ============================================================
// ass Feature Manifest
// 职责：声明本 feature 的元信息（key/label/icon/path/supportsFloating）
//        供 featureRegistry 静态 import 后生成左侧菜单
//
// supportsFloating: true 表示 ass 支持以半透明悬浮窗模式打开
// ============================================================

import { SwapHorizontalOutline as SwapIcon } from '@vicons/ionicons5'

export const manifest = {
  key: 'ass',
  label: '统计代理',
  icon: SwapIcon,
  path: '/ass',
  supportsFloating: false
}
