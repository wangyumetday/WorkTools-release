// ============================================================
// PCP Feature Manifest
// 职责：声明本 feature 的元信息（key/label/icon/path/supportsFloating）
//        供 featureRegistry 静态 import 后生成左侧菜单
// ============================================================

import { ScaleOutline as ScaleIcon } from '@vicons/ionicons5'

export const manifest = {
  key: 'pcp',
  label: '比价工具',
  icon: ScaleIcon,
  path: '/pcp',
  supportsFloating: false
}
