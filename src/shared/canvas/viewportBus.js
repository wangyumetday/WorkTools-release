// 画布视口变化总线（ComfyUI 式画布）
// 职责：FeatureCanvas 在缩放/平移结束后广播「视口已变化」，
// 节点内依赖视觉像素测量的组件（TaskList 虚拟列表等）订阅后强制重新测量，
// 消除 CSS transform 缩放导致的测量缓存失真。
//
// 为什么不用 provide/inject：节点内容经 VueFlow 内部 slot 渲染，
// 组件级 provide 无法可靠穿透到节点内部组件，故用模块级轻量总线。

const listeners = new Set()

/** 订阅视口变化；返回取消订阅函数 */
export function onCanvasViewportChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** FeatureCanvas 在缩放/平移静止后调用（内部已防抖） */
export function notifyCanvasViewportChange() {
  for (const fn of listeners) {
    try { fn() } catch (e) { console.warn('[canvas] viewport change listener error:', e?.message) }
  }
}