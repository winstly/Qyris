/**
 * 文件快照：AI 写文件前记录修改前内容，按「对话会话」分组，支持单文件回退 + 整会话回退。
 * 存储：userData/snapshots/<projectHash>/<sessionId>/<base64path>.snap，内容 JSON { ts, content }。
 * 同一会话内同一文件只快照第一次（保留会话开始前的最初版本），回退会话即可恢复到会话前。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { storageDir } from './storage'

interface SnapMeta {
  ts: number
  content: string
}

function projectKey(projectRoot: string): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 16)
}

function projectDir(projectRoot: string): string {
  return path.join(storageDir(), 'snapshots', projectKey(projectRoot))
}

function sessionDir(projectRoot: string, sessionId: string): string {
  return path.join(projectDir(projectRoot), sessionId)
}

function snapFile(projectRoot: string, sessionId: string, absPath: string): string {
  return path.join(sessionDir(projectRoot, sessionId), `${Buffer.from(absPath).toString('base64url')}.snap`)
}

/** 写文件前调用：该会话该文件尚无快照时保存当前内容（幂等，保留会话开始前的最初版本） */
export async function snapshotFile(projectRoot: string, sessionId: string, absPath: string): Promise<void> {
  try {
    const file = snapFile(projectRoot, sessionId, absPath)
    try {
      await fsp.access(file)
      return // 本会话已快照过该文件，跳过（不覆盖）
    } catch {
      /* 尚未快照，继续 */
    }
    const buf = await fsp.readFile(absPath)
    // 二进制嗅探（前 8192 字节含 0x00 → 跳过，与 fsops 一致）
    if (buf.subarray(0, 8192).includes(0)) return
    await fsp.mkdir(sessionDir(projectRoot, sessionId), { recursive: true })
    const meta: SnapMeta = { ts: Date.now(), content: buf.toString('utf8') }
    await fsp.writeFile(file, JSON.stringify(meta), 'utf8')
  } catch {
    /* 文件不存在或读失败：新建文件，静默跳过 */
  }
}

/** 列出所有快照：absPath → { ts, sessionId }（每个文件取 ts 最新的那份） */
export async function listSnapshots(projectRoot: string): Promise<Record<string, { ts: number; sessionId: string }>> {
  const out: Record<string, { ts: number; sessionId: string }> = {}
  let sessions: string[] = []
  try {
    sessions = await fsp.readdir(projectDir(projectRoot))
  } catch {
    return out
  }
  for (const sessionId of sessions) {
    const dir = path.join(projectDir(projectRoot), sessionId)
    let files: string[] = []
    try {
      files = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.snap')) continue
      try {
        const raw = await fsp.readFile(path.join(dir, f), 'utf8')
        const meta = JSON.parse(raw) as SnapMeta
        const abs = Buffer.from(f.slice(0, -'.snap'.length), 'base64url').toString('utf8')
        if (!out[abs] || meta.ts > out[abs].ts) out[abs] = { ts: meta.ts, sessionId }
      } catch {
        /* 单个损坏快照跳过 */
      }
    }
  }
  return out
}

/** 回退单个文件到它的最新快照 */
export async function restoreFile(projectRoot: string, absPath: string): Promise<void> {
  const info = (await listSnapshots(projectRoot))[absPath]
  if (!info) throw new Error('该文件没有可回退的快照')
  await restoreOne(projectRoot, info.sessionId, absPath)
}

/** 回退某会话的全部快照文件，返回回退的文件数 */
export async function restoreSession(projectRoot: string, sessionId: string): Promise<number> {
  const dir = sessionDir(projectRoot, sessionId)
  let files: string[] = []
  try {
    files = await fsp.readdir(dir)
  } catch {
    return 0
  }
  let count = 0
  for (const f of files) {
    if (!f.endsWith('.snap')) continue
    const abs = Buffer.from(f.slice(0, -'.snap'.length), 'base64url').toString('utf8')
    try {
      await restoreOne(projectRoot, sessionId, abs)
      count++
    } catch {
      /* 单个失败不中断 */
    }
  }
  return count
}

async function restoreOne(projectRoot: string, sessionId: string, absPath: string): Promise<void> {
  const file = snapFile(projectRoot, sessionId, absPath)
  const meta = JSON.parse(await fsp.readFile(file, 'utf8')) as SnapMeta
  await fsp.writeFile(absPath, meta.content, 'utf8')
  await fsp.rm(file).catch(() => {})
}

/** 项目文件被删除后清理其全部快照：同路径重建项目时旧快照不允许复活（回退会覆盖新项目内容） */
export async function clearProjectSnapshots(projectRoot: string): Promise<void> {
  try {
    await fsp.rm(projectDir(projectRoot), { recursive: true, force: true })
  } catch {
    /* 清理失败不影响删除流程（force 下基本只剩权限类错误） */
  }
}