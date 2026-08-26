// ============================================================
// PCP CredentialManager - 账密管理器
// 职责：管理多平台多账号的账密存储 + 每个平台独立的"当前选中账号"
//
// 业务模型（与 frontend 的 CredentialManager.vue 一致）：
//   - 一个账号 (credential) 只属于一个平台（g1/o1/o2/o3）
//   - 每个平台独立维护"当前选中的账号 id"（而非全局单一 selectedId）
//   - 请求某平台时，通过 getSelected(platform) 拿到该平台当前账号
//
// 持久化：
//   - credentials.json: 全部账密数组
//   - selectedCredential.json: { selectedMap: { g1: id|null, o1: id|null, ... } }
//   - 兼容旧版 { selectedId } 格式：首次加载时自动迁移到新版
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import * as registry from './platforms/registry.js'

/**
 * 本项目支持的全部业务平台（代码 key 用简称：锦绣国际 JXGJ / 携程OTA TRIP）
 * 与前端 PLATFORM_LIST、主进程各 dispatch 映射保持一致。
 * 新增加平台只需在这里同步加入数组即可。
 */
const ALL_PLATFORMS = ['jxgj', 'trip', 'o2', 'o3']

/**
 * 构造一个"全平台默认未选中"的对象
 * 数据形态: { jxgj: null, trip: null, o2: null, o3: null }
 */
function buildDefaultSelectedMap() {
  const result = {}
  for (const platform of ALL_PLATFORMS) {
    result[platform] = null
  }
  return result
}

export class CredentialManager {
  constructor(userDataPath) {
    this.configDir = path.join(userDataPath, 'config')
    this.credentialFile = path.join(this.configDir, 'credentials.json')
    this.ensureConfigDir()
    this.credentials = this.loadCredentials()
    this.selectedMap = this.loadSelectedMap()
  }

  // 确保 config 目录存在
  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
  }

  // 从磁盘加载全部账密数组
  loadCredentials() {
    if (fs.existsSync(this.credentialFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.credentialFile, 'utf-8'))
      } catch {
        return []
      }
    }
    return []
  }

  /**
   * 兼容旧格式加载选中关系
   * - 旧版 selectedCredential.json 存的是 { selectedId: string|null }
   *   （全局只能选一个账号）
   * - 新版存的是 { selectedMap: { platform: id|null } }
   *   （每个平台独立选择，默认未选中）
   *
   * 若读到旧格式，会自动做一次性迁移：
   *   根据旧 selectedId 查到账密的 platform，把该账号写入新的对应平台位，
   *   其它平台保持未选中状态。
   */
  loadSelectedMap() {
    const selectedFile = path.join(this.configDir, 'selectedCredential.json')
    if (!fs.existsSync(selectedFile)) {
      return buildDefaultSelectedMap()
    }

    try {
      const raw = JSON.parse(fs.readFileSync(selectedFile, 'utf-8'))

      // ====== 新版格式：selectedMap 直接使用 ======
      if (raw && typeof raw.selectedMap === 'object' && raw.selectedMap !== null) {
        const merged = buildDefaultSelectedMap()
        for (const platform of ALL_PLATFORMS) {
          if (Object.prototype.hasOwnProperty.call(raw.selectedMap, platform)) {
            merged[platform] = raw.selectedMap[platform] ?? null
          }
        }
        return merged
      }

      // ====== 旧版格式：{ selectedId } → 自动迁移 ======
      if (Object.prototype.hasOwnProperty.call(raw, 'selectedId')) {
        const oldId = raw.selectedId ?? null
        const migrated = buildDefaultSelectedMap()
        if (oldId) {
          const oldCred = this.credentials.find(c => c.id === oldId)
          if (oldCred && ALL_PLATFORMS.includes(oldCred.platform)) {
            migrated[oldCred.platform] = oldCred.id
          }
        }
        // 迁移后立刻覆盖落盘，避免以后每次都要转换
        this.selectedMap = migrated
        this.saveSelectedMap()
        return migrated
      }
    } catch {
      // JSON 解析失败或字段非法，使用默认"全未选中"
    }

    return buildDefaultSelectedMap()
  }

  // 保存全部账密数组到磁盘
  saveCredentials() {
    fs.writeFileSync(this.credentialFile, JSON.stringify(this.credentials, null, 2), 'utf-8')
  }

  // 保存选中关系到磁盘（{ selectedMap }）
  saveSelectedMap() {
    const selectedFile = path.join(this.configDir, 'selectedCredential.json')
    fs.writeFileSync(
      selectedFile,
      JSON.stringify({ selectedMap: this.selectedMap }, null, 2),
      'utf-8'
    )
  }

  /**
   * 获取全部账密 + 各平台当前选中关系
   * 返回形态：
   *   {
   *     credentials: [...],
   *     selectedMap: { g1: id|null, o1: id|null, o2: id|null, o3: id|null },
   *     platforms: ['g1','o1','o2','o3']   // 方便前端直接用
   *   }
   */
  list() {
    return {
      credentials: this.credentials,
      selectedMap: this.selectedMap,
      platforms: [...ALL_PLATFORMS]
    }
  }

  /**
   * 添加账号
   *   - 自动生成 id（cred_<timestamp>）和 createdAt
   *   - 若该平台当前没选中账号，自动选中刚添加的这条（符合"刚加的立刻能用"心智）
   *   - trip（携程）平台会先验证账密，验证失败不保存
   */
  async add(credential) {
    // 账密验证：只有支持 verifyCredential 的平台才验证（如 trip）
    //   jxgj 是公开 API 无账密，不验证
    const platform = credential.platform || 'jxgj'
    const adapter = _safeGetAdapter(platform)
    if (adapter?.verifyCredential) {
      const verifyResult = await adapter.verifyCredential(credential)
      if (!verifyResult.success) {
        return { success: false, message: `账号验证失败：${verifyResult.message}` }
      }
    }

    const newCredential = {
      id: `cred_${Date.now()}`,
      name: credential.name || '未命名',
      platform,
      username: credential.username || '',
      password: credential.password || '',
      remark: credential.remark || '',
      createdAt: Date.now()
    }
    this.credentials.push(newCredential)
    this.saveCredentials()

    // 若新增时，该平台还没有任何选中账号，自动选中这一条
    // （符合用户心智：刚添加的立刻可以用，无需再手动点"选中使用"）
    const targetPlatform = newCredential.platform
    if (!this.selectedMap[targetPlatform]) {
      this.selectedMap[targetPlatform] = newCredential.id
      this.saveSelectedMap()
    }

    return { success: true, credential: newCredential }
  }

  /**
   * 删除账号
   *   - 删除后若该账号是其平台当前选中，清空该平台选中位（不自动换另一条，避免挑错）
   */
  delete(id) {
    const index = this.credentials.findIndex(c => c.id === id)
    if (index === -1) return { success: false, message: '账密不存在' }
    const removed = this.credentials[index]
    this.credentials.splice(index, 1)
    this.saveCredentials()

    // 如果删的正好是某个平台当前选中的账号，就把该平台的选中位清空（不自动换另一条，避免挑错）
    if (removed && ALL_PLATFORMS.includes(removed.platform)) {
      if (this.selectedMap[removed.platform] === id) {
        this.selectedMap[removed.platform] = null
        this.saveSelectedMap()
      }
    }

    return { success: true }
  }

  /**
   * 更新账密
   *   - 若修改导致 platform 变化：旧平台选中位要清空，新平台若没选中则自动选中它
   *   - 修改了 username/password 时会先验证账密，验证失败不保存
   */
  async update(credential) {
    const index = this.credentials.findIndex(c => c.id === credential.id)
    if (index === -1) return { success: false, message: '账密不存在' }
    const oldPlatform = this.credentials[index].platform
    const newPlatform = credential.platform ?? oldPlatform

    // 账密验证：username 或 password 变了才验证（只改名/备注不验证）
    const oldCred = this.credentials[index]
    const usernameChanged = credential.username && credential.username !== oldCred.username
    const passwordChanged = credential.password && credential.password !== oldCred.password
    if (usernameChanged || passwordChanged) {
      const adapter = _safeGetAdapter(newPlatform)
      if (adapter?.verifyCredential) {
        // 用新值（未传则用旧值）验证
        const verifyCred = {
          username: credential.username || oldCred.username,
          password: credential.password || oldCred.password
        }
        const verifyResult = await adapter.verifyCredential(verifyCred)
        if (!verifyResult.success) {
          return { success: false, message: `账号验证失败：${verifyResult.message}` }
        }
      }
    }

    this.credentials[index] = { ...this.credentials[index], ...credential }

    // 若修改导致平台变了，并且这个账密还是旧平台的"选中"，则旧平台选中位要清空
    // （因为它已经不属于旧平台了），然后若新平台当前没选中则自动选中它
    if (oldPlatform !== newPlatform && ALL_PLATFORMS.includes(oldPlatform) && ALL_PLATFORMS.includes(newPlatform)) {
      let changed = false
      if (this.selectedMap[oldPlatform] === credential.id) {
        this.selectedMap[oldPlatform] = null
        changed = true
      }
      if (!this.selectedMap[newPlatform]) {
        this.selectedMap[newPlatform] = credential.id
        changed = true
      }
      if (changed) this.saveSelectedMap()
    }

    this.saveCredentials()
    return { success: true, credential: this.credentials[index] }
  }

  /**
   * 在指定平台上选中一个账号。
   * 两种用法：
   *   select(id)            → 自动根据账密的 platform 设置该平台的选中
   *   select({ id, platform }) → 明确指定平台（更严格；若账密真实平台不匹配会报错）
   *
   *   传 id = null 则清空该平台的选中关系。
   */
  select(input) {
    let id
    let platform

    if (input && typeof input === 'object' && !Array.isArray(input)) {
      id = input.id ?? null
      platform = input.platform ?? null
    } else {
      id = input ?? null
      platform = null
    }

    // 空 id → 清空对应平台
    if (id === null) {
      if (!platform || !ALL_PLATFORMS.includes(platform)) {
        return { success: false, message: '清空选中必须指定平台' }
      }
      this.selectedMap[platform] = null
      this.saveSelectedMap()
      return { success: true, selectedMap: this.selectedMap }
    }

    const target = this.credentials.find(c => c.id === id)
    if (!target) return { success: false, message: '账密不存在' }

    // 若显式传了 platform，强制校验：账号必须属于该平台，避免用户串平台选号
    if (platform && platform !== target.platform) {
      return { success: false, message: `账号所属平台为 ${target.platform}，不能在 ${platform} 下选中` }
    }

    const finalPlatform = target.platform
    if (!ALL_PLATFORMS.includes(finalPlatform)) {
      return { success: false, message: `不支持的平台: ${finalPlatform}` }
    }

    this.selectedMap[finalPlatform] = id
    this.saveSelectedMap()
    return { success: true, selectedMap: this.selectedMap, platform: finalPlatform }
  }

  /**
   * 获取指定平台当前选中的账密；不传 platform 则返回全部平台的选中账密表。
   *
   *   getSelected('g1') → credential | null
   *   getSelected()     → { g1: credential|null, o1: credential|null, ... }
   */
  getSelected(platform) {
    if (platform) {
      const id = this.selectedMap[platform] ?? null
      if (!id) return null
      return this.credentials.find(c => c.id === id) || null
    }

    const result = {}
    for (const p of ALL_PLATFORMS) {
      const id = this.selectedMap[p] ?? null
      result[p] = id ? (this.credentials.find(c => c.id === id) || null) : null
    }
    return result
  }
}

/**
 * 安全获取平台 adapter（registry.get 未注册时抛错，这里吞掉返回 null）
 *   用于 add/update 时判断该平台是否支持 verifyCredential
 */
function _safeGetAdapter(platform) {
  try {
    return registry.get(platform)
  } catch {
    return null
  }
}
