// Canvas 布局持久化（ComfyUI 式画布）
// 职责：读写 userData/canvas-layouts.json，按功能 key 分区存节点布局与视口
//
// 文件结构：
//   {
//     "pcp": { "nodes": [{ "id", "position": {x,y}, "dimensions": {width,height} }], "viewport": {x,y,zoom} },
//     "erc": { ... }, "ass": { ... }
//   }
//
// 设计要点：
//   - 纯 UI 布局数据，无业务校验负担；读失败/文件不存在一律返回空对象，
//     渲染层拿不到记录时回退硬编码默认布局（无 fallback 数据约束只针对业务数据，此处为界面偏好）
//   - 写失败仅告警：布局保存不成功不影响功能运行
//   - 整文件读-改-写：三个功能的布局共用一个文件，避免文件碎片

import fs from 'node:fs'
import path from 'node:path'

let layoutsFilePath = null
let cached = null

/** 初始化（app ready 后调用一次），绑定 userData 下的布局文件路径 */
export function initCanvasLayouts(userDataPath) {
  layoutsFilePath = path.join(userDataPath, 'canvas-layouts.json')
  cached = null
}

/** 读取全部功能画布布局；文件不存在/损坏 → 空对象（渲染层走默认布局） */
export function getCanvasLayouts() {
  if (!layoutsFilePath) return {}
  if (cached) return cached
  try {
    cached = JSON.parse(fs.readFileSync(layoutsFilePath, 'utf8'))
  } catch {
    cached = {}
  }
  return cached
}

/** 保存单个功能的画布布局（合并写回整个文件） */
export function setCanvasLayout(featureKey, layout) {
  if (!layoutsFilePath || !featureKey || layout == null) return
  try {
    const all = getCanvasLayouts()
    all[featureKey] = layout
    fs.mkdirSync(path.dirname(layoutsFilePath), { recursive: true })
    fs.writeFileSync(layoutsFilePath, JSON.stringify(all, null, 2), 'utf8')
    cached = all
  } catch (e) {
    console.warn('[canvas-layout] save failed:', e?.message)
  }
}