// ============================================================
// 用户可编辑区：Phase 1 数据处理函数
// ------------------------------------------------------------
// 【使用说明】
//   此文件专门给你自己编写 Phase 1 的处理逻辑。
//   ASS 框架保证：每条 QueryParam 在 Phase 1 请求完成后，
//   无论成功 / 无航班 / UNKNOWN 都会调一次 processP1(ctx)，
//   把返回值 JSON 序列化后追加写入 p1_<timestamp>.jsonl 文件。
//
//   当前默认实现：原样透传。你可以在此处自由添加任何字段级的
//   筛选、重命名、聚合、计算逻辑，不需要动框架代码。
// ============================================================

/**
 * Phase 1 数据处理函数
 *
 * @param   {object}  ctx
 * @param   {object}  ctx.queryParam      当前查询参数 { dep, arr, airline, date }
 * @param   {any}     ctx.rawResponse     锦绣国际接口的原始响应；请求失败（UNKNOWN）时为 null
 * @param   {boolean|null} ctx.hasFlight
 *   - true  : 接口返回有航班
 *   - false : 接口返回正常但无匹配航班
 *   - null  : 请求异常（网络/超时/业务Msg异常）→ 视为 UNKNOWN
 * @param   {Error|null} [ctx.error]      请求异常对象；仅当 hasFlight===null 时有值
 * @returns {any}                         要写入 P1 输出文件的单条记录
 */
export function processP1(ctx) {
  // ====== 用户编辑区（START）================================
  // 默认：原样透传（后续你自己改内部逻辑）
  return {
    queryParam: ctx.queryParam,
    hasFlight:  ctx.hasFlight,
    raw:        ctx.rawResponse,
    error:      ctx.error ? { name: ctx.error.name, message: ctx.error.message } : null,
  }
  // ====== 用户编辑区（END）==================================
}

export default { processP1 }
