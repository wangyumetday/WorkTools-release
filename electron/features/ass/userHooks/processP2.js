// ============================================================
// 用户可编辑区：Phase 2 数据处理函数
// ------------------------------------------------------------
// 【使用说明】
//   此文件专门给你自己编写 Phase 2 的处理逻辑。
//   ASS 框架保证：P1 结束后进入 P2，每个 QueryParam 会处理一次：
//     - hasFlight=false → 不请求携程，status="SKIP"
//     - hasFlight=true  → 真实调用携程查询，status="OK"
//     - 请求出错        → status="ERROR"
//   三种情况都会调 processP2(ctx)，返回值写入 p2_<timestamp>.jsonl。
//
//   当前默认实现：原样透传。你可以在此处自由编写携程低价数据的
//   字段抽取 / 合并 / 格式化逻辑。
// ============================================================

/**
 * Phase 2 数据处理函数
 *
 * @param   {object}  ctx
 * @param   {object}  ctx.queryParam      当前查询参数 { dep, arr, airline, date }
 * @param   {any}     ctx.rawResponse     携程的原始响应；status=SKIP/ERROR 时为 null
 * @param   {"SKIP"|"OK"|"ERROR"} ctx.status
 *   - "SKIP" : P1 标为无航班，直接跳过，未请求携程
 *   - "OK"   : 真实请求携程并拿到响应
 *   - "ERROR": 尝试请求携程但失败（详见 ctx.error）
 * @param   {Error|null} [ctx.error]      错误对象；仅 status=="ERROR" 时有值
 * @returns {any}                         要写入 P2 输出文件的单条记录
 */
export function processP2(ctx) {
  // ====== 用户编辑区（START）================================
  // 默认：原样透传（后续你自己改内部逻辑）
  return {
    queryParam: ctx.queryParam,
    status:     ctx.status,
    raw:        ctx.rawResponse,
    error:      ctx.error ? { name: ctx.error.name, message: ctx.error.message } : null,
  }
  // ====== 用户编辑区（END）==================================
}

export default { processP2 }
