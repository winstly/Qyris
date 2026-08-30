/**
 * 会话历史持久化：按项目隔离，落在 ~/.qyris/sessions/<projectKey>.json。
 * 内容为渲染层的 ChatMessage[]（JSON 序列化），不含非纯数据字段（pending 草稿由前端保存前处理）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { storageDir } from './storage'

function projectKey(projectRoot: string): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 16)
}

function sessionFile(projectRoot: string): string {
  return path.join(storageDir(), 'sessions', `${projectKey(projectRoot)}.json`)
}

export async function loadSession(projectRoot: string): Promise<unknown[] | null> {
  try {
    const raw = await fsp.readFile(sessionFile(projectRoot), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function saveSession(projectRoot: string, messages: unknown[]): Promise<void> {
  try {
    const file = sessionFile(projectRoot)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(messages), 'utf8')
  } catch {
    /* 写失败不阻塞对话 */
  }
}