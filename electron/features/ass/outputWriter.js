// ============================================================
// 输出文件写入器
// 职责：
//   - 生成一对 P1/P2 jsonl 文件（共用同一任务时间戳前缀，便于配对）
//   - 提供 appendLine 一行一追加（JSON Lines 实时落盘，不怕中断）
//   - 提供 close 关句柄
//   - P1/P2 文件永不删除（调用方不提供删除接口）
// ============================================================

import { mkdirSync, createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 生成格式为 YYYYMMDD_HHmmss 的任务时间戳
 */
function taskTimestamp(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}` +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '_' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}

/**
 * 创建一对 P1/P2 JSON Lines 输出写入器
 *
 * @param {object} opts
 * @param {string} opts.outputDir  输出目录（如不存在会 mkdir -p）
 * @param {string} [opts.ts]       可选：指定时间戳字符串（单元测试用）
 * @returns {Promise<{
 *   ts: string,
 *   p1FilePath: string,
 *   p2FilePath: string,
 *   outputDir: string,
 *   appendP1: (obj: any) => void,
 *   appendP2: (obj: any) => void,
 *   close: () => Promise<void>
 * }>}
 */
export async function createPairedJsonlWriters({ outputDir, ts }) {
  if (!outputDir) throw new Error('outputDir 必填')
  const taskTs = ts || taskTimestamp()

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  const p1FilePath = path.join(outputDir, `p1_${taskTs}.jsonl`)
  const p2FilePath = path.join(outputDir, `p2_${taskTs}.jsonl`)

  const w1 = createWriteStream(p1FilePath, { encoding: 'utf8', flags: 'a' })
  const w2 = createWriteStream(p2FilePath, { encoding: 'utf8', flags: 'a' })

  function appendLine(stream, obj) {
    const line = JSON.stringify(obj, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v))
    stream.write(line + '\n')
  }

  function endStream(stream) {
    return new Promise((resolve, reject) => {
      if (stream.destroyed) return resolve()
      stream.end((err) => (err ? reject(err) : resolve()))
    })
  }

  return {
    ts: taskTs,
    p1FilePath,
    p2FilePath,
    outputDir,
    appendP1: (obj) => appendLine(w1, obj),
    appendP2: (obj) => appendLine(w2, obj),
    close: async () => {
      await Promise.all([endStream(w1), endStream(w2)])
    },
  }
}

export default { createPairedJsonlWriters }
