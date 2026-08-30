/**
 * 凭据存储 —— secret.rs 语义 + Electron safeStorage 实现。
 * 账户名 `api_key`（与前端 SECRET_KEY 一致）；secrets.json 存 base64 密文，落盘即非明文。
 * 注意：get 不暴露给渲染层（明文 Key 不出主进程），仅 ai.ts 内部直读。
 */
import { safeStorage } from 'electron'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { errorMessage } from './util'
import { storageDir } from './storage'

function secretsPath(): string {
  return path.join(storageDir(), 'secrets.json')
}

async function readAll(): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(secretsPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function writeAll(all: Record<string, string>): Promise<void> {
  const file = secretsPath()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(all, null, 2), 'utf8')
}

export async function setSecret(key: string, value: string): Promise<void> {
  try {
    const encrypted = safeStorage.encryptString(value)
    const all = await readAll()
    all[key] = encrypted.toString('base64')
    await writeAll(all)
  } catch (e) {
    throw new Error(`凭据写入失败：${errorMessage(e)}`)
  }
}

export async function hasSecret(key: string): Promise<boolean> {
  const all = await readAll()
  const v = all[key]
  return typeof v === 'string' && v.length > 0
}

/** 删除不存在的 key 视为成功（与 Rust EntryNotFound 容忍一致） */
export async function deleteSecret(key: string): Promise<void> {
  try {
    const all = await readAll()
    if (!(key in all)) return
    delete all[key]
    await writeAll(all)
  } catch (e) {
    throw new Error(`凭据删除失败：${errorMessage(e)}`)
  }
}

/** 仅主进程内部使用（ai.ts 代理请求时解密），绝不通过 IPC 暴露 */
export async function getSecretInternal(key: string): Promise<string | null> {
  const all = await readAll()
  const b64 = all[key]
  if (typeof b64 !== 'string' || b64.length === 0) return null
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch (e) {
    throw new Error(`无法访问系统凭据存储：${errorMessage(e)}`)
  }
}
