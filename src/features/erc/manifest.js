// ============================================================
// ERC Feature Manifest
// 职责：声明本 feature 的元信息（key/label/icon/path/supportsFloating）
//        供 featureRegistry 静态 import 后生成左侧菜单
//
// supportsFloating: true 表示 ERC 支持以半透明悬浮窗模式打开
// ============================================================

import { SwapHorizontalOutline as SwapIcon } from '@vicons/ionicons5'

export const manifest = {
  key: 'erc',
  label: '汇率转换',
  icon: SwapIcon,
  path: '/erc',
  supportsFloating: true
}
