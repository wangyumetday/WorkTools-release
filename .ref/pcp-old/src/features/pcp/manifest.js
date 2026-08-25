// ============================================================
// PCP Feature Manifest
// 职责：声明本 feature 的元信息（key/label/icon/path/supportsFloating）
//        供 featureRegistry 静态 import 后生成左侧菜单
// ============================================================

import { CubeOutline as CubeIcon } from '@vicons/ionicons5'

export const manifest = {
  key: 'pcp',
  label: '数据处理',
  icon: CubeIcon,
  path: '/pcp',
  supportsFloating: false
}
