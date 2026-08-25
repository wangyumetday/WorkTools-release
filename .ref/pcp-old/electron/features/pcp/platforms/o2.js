// ============================================================
// O2 平台请求适配器
// 职责：
//   - compilePlatformConfig: 透传字符串配置（O2 暂无独立公式编译）
//   - o2Login: 平台登录（mock，返回假 sessionId）
//   - o2Request: O2 平台数据请求（mock，模拟延迟 + 88% 成功率）
//
// 说明：第二个参数 context = { credential, loginResult, platformConfig }，
//       真实 HTTP 请求时用它取 token / session。
// ============================================================

// identity fallback：O2 暂未实现公式编译，预编译时透传字符串配置
export const compilePlatformConfig = (raw = {}) => ({ ...raw })

// O2 平台请求（mock 实现，待替换为真实接口）
export async function o2Request(data, context = {}) {
  // 模拟网络请求延迟 2-4秒
  const delay = 200 + Math.random() * 200
  await new Promise(resolve => setTimeout(resolve, delay))

  // 模拟请求结果
  const success = Math.random() > 0.12 // 88%成功率
  if (!success) {
    throw new Error('O2平台请求失败：参数校验错误')
  }

  return {
    platform: 'o2',
    success: true,
    errCode: 0,
    errMsg: '',
    result: {
      taskId: `O2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      input: data,
      output: {
        score: Math.floor(Math.random() * 100),
        rank: Math.floor(Math.random() * 1000) + 1,
        tags: Array.from({ length: Math.floor(Math.random() * 5) + 1 }, () =>
          ['高价值', '活跃', '新用户', '流失风险', '优质'][Math.floor(Math.random() * 5)]
        )
      },
      responseTime: new Date().toISOString()
    }
  }
}

// O2 平台登录（mock 实现）
export async function o2Login(credential) {
  const delay = 700 + Math.random() * 1000
  await new Promise(resolve => setTimeout(resolve, delay))
  return {
    sessionId: `o2_sess_${Math.random().toString(36).slice(2)}`,
    uid: `o2_user_${Date.now()}`
  }
}
