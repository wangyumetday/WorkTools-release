// ============================================================
// O3 平台请求适配器
// 职责：
//   - compilePlatformConfig: 透传字符串配置（O3 暂无独立公式编译）
//   - o3Login: 平台登录（mock，返回假 token + userKey）
//   - o3Request: O3 平台数据请求（mock，模拟延迟 + 92% 成功率）
//
// 说明：第二个参数 context = { credential, loginResult, platformConfig }，
//       真实 HTTP 请求时用它取 token / userKey。
// ============================================================

// identity fallback：O3 暂未实现公式编译，预编译时透传字符串配置
export const compilePlatformConfig = (raw = {}) => ({ ...raw })

// O3 平台请求（mock 实现，待替换为真实接口）
export async function o3Request(data, context = {}) {
  // 模拟网络请求延迟 0.8-2.5秒
  const delay = 300 + Math.random() * 200
  await new Promise(resolve => setTimeout(resolve, delay))

  // 模拟请求结果
  const success = Math.random() > 0.08 // 92%成功率
  if (!success) {
    throw new Error('O3平台请求失败：限流，请稍后重试')
  }

  return {
    platform: 'o3',
    code: '0',
    msg: '成功',
    data: {
      orderNo: `O3${Date.now()}${Math.floor(Math.random() * 10000)}`,
      queryData: data,
      analysis: {
        riskLevel: ['低', '中', '高'][Math.floor(Math.random() * 3)],
        riskScore: Math.floor(Math.random() * 100),
        suggestion: ['正常操作', '加强验证', '人工审核'][Math.floor(Math.random() * 3)],
        features: {
          feature1: Math.random().toFixed(4),
          feature2: Math.random().toFixed(4),
          feature3: Math.random().toFixed(4)
        }
      },
      timestamp: Date.now()
    }
  }
}

// O3 平台登录（mock 实现）
export async function o3Login(credential) {
  const delay = 400 + Math.random() * 800
  await new Promise(resolve => setTimeout(resolve, delay))
  return {
    token: `o3_token_${Math.random().toString(36).slice(2)}`,
    userKey: `o3_key_${Math.random().toString(36).slice(2)}`
  }
}
