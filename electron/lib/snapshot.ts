/**
 * 文件快照 v2：AI 写文件前记录修改前内容，支持——
 *  - 会话基线快照（会话内同文件只留第一份，整会话回退恢复到会话前）——兼容 v1 语义与存量数据
 *  - 版本快照（每次 AI 写入前各留一份，按文件保留最近 N 个版本，可回退到任意中间版本）
 *  - 版本 diff 预览（unified diff，回退前先看差异，不再盲操作）
 * 存储：<dataDir>/snapshots/<projectHash>/<sessionId>/<base64path>~<versionKey>.snap
 *      基线为 <base64path>.snap（与 v1 完全同名兼容）。
 * P1 存储迁移兼容：旧根 ~/.qyris/snapshots 只读合并列出（读侧先新后旧，删除语义两端都清）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dataDir } from './db'
import { storageDir } from './storage'
import { atomicWriteFile } from './fsops'
import { unifiedDiff } from './textdiff'

import type { SnapshotVersion } from '../../shared/types'

interface SnapMeta {
  ts: number
  content: string
}

/** 每个文件保留的版本快照上限（含基线外的版本；超出淘汰最旧） */
const MAX_VERSIONS_PER_FILE = 9

/** 快照根：current = <dataDir>/snapshots（读写），legacy = ~/.qyris/snapshots（只读兼容） */
interface SnapRoots {
  current: string
  legacy: string
}

async function snapshotRoots(): Promise<SnapRoots> {
  return {
    current: path.join(await dataDir(), 'snapshots'),
    legacy: path.join(storageDir(), 'snapshots'),
  }
}

function projectKey(projectRoot: string): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 16)
}

function projectDirIn(root: string, projectRoot: string): string {
  return path.join(root, projectKey(projectRoot))
}

function sessionDirIn(root: string, projectRoot: string, sessionId: string): string {
  return path.join(projectDirIn(root, projectRoot), sessionId)
}

/** b64(absPath) + 可选版本后缀：基线 = b64.snap；版本 = b64~<versionKey>.snap */
function snapFileIn(root: string, projectRoot: string, sessionId: string, absPath: string, versionKey?: string): string {
  const base = Buffer.from(absPath).toString('base64url')
  const name = versionKey ? `${base}~${versionKey}.snap` : `${base}.snap`
  return path.join(sessionDirIn(root, projectRoot, sessionId), name)
}

/** 从快照文件名解析 absPath 与 versionKey */
function parseSnapName(filename: string): { absPath: string; versionKey: string | null } | null {
  if (!filename.endsWith('.snap')) return null
  const stem = filename.slice(0, -'.snap'.length)
  const sep = stem.indexOf('~')
  if (sep === -1) {
    return { absPath: Buffer.from(stem, 'base64url').toString('utf8'), versionKey: null }
  }
  return {
    absPath: Buffer.from(stem.slice(0, sep), 'base64url').toString('utf8'),
    versionKey: stem.slice(sep + 1),
  }
}

async function writeSnap(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const meta: SnapMeta = { ts: Date.now(), content }
  await fsp.writeFile(file, JSON.stringify(meta), 'utf8')
}

async function readSnap(file: string): Promise<SnapMeta | null> {
  try {
    const meta = JSON.parse(await fsp.readFile(file, 'utf8')) as SnapMeta
    if (typeof meta?.content !== 'string') return null // 损坏快照（半截 JSON 等）
    return meta
  } catch {
    return null
  }
}

/** 会话基线快照（v1 兼容入口）：该会话该文件尚无基线时保存当前内容（幂等）。
 *  opts.version=true 时改为版本快照：每次都写一份，保留可回退的中间版本。 */
export async function snapshotFile(
  projectRoot: string, sessionId: string, absPath: string,
  opts?: { version?: boolean },
): Promise<void> {
  try {
    const { current } = await snapshotRoots()
    if (opts?.version === true) {
      const buf = await fsp.readFile(absPath)
      if (buf.subarray(0, 8192).includes(0)) return // 二进制不快照（与 fsops 嗅探口径一致）
      const versionKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      await writeSnap(snapFileIn(current, projectRoot, sessionId, absPath, versionKey), buf.toString('utf8'))
      await pruneVersions(current, projectRoot, sessionId, absPath)
      return
    }
    const file = snapFileIn(current, projectRoot, sessionId, absPath)
    try {
      await fsp.access(file)
      return // 本会话已快照过该文件，跳过（不覆盖，保留会话前最初版本）
    } catch {
      /* 尚未快照，继续 */
    }
    const buf = await fsp.readFile(absPath)
    if (buf.subarray(0, 8192).includes(0)) return
    await writeSnap(file, buf.toString('utf8'))
  } catch {
    /* 文件不存在或读失败：新建文件无需快照，静默跳过 */
  }
}

/** 版本快照超出上限时淘汰最旧（基线不受影响；versionKey 首段为 36 进制时间戳，字典序即时序） */
async function pruneVersions(root: string, projectRoot: string, sessionId: string, absPath: string): Promise<void> {
  const dir = sessionDirIn(root, projectRoot, sessionId)
  const base = Buffer.from(absPath).toString('base64url')
  let files: string[]
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.startsWith(`${base}~`) && f.endsWith('.snap'))
  } catch {
    return
  }
  if (files.length <= MAX_VERSIONS_PER_FILE) return
  files.sort() // 同前缀下按 versionKey 字典序（时间戳开头 → 时序）
  for (const f of files.slice(0, files.length - MAX_VERSIONS_PER_FILE)) {
    await fsp.rm(path.join(dir, f), { force: true }).catch(() => {})
  }
}

/** 单文件的可用快照版本（基线 + 各中间版本），按时间倒序；新旧两根合并。 */
export async function listFileSnapshotVersions(projectRoot: string, absPath: string): Promise<SnapshotVersion[]> {
  const out: SnapshotVersion[] = []
  const { current, legacy } = await snapshotRoots()
  for (const root of [current, legacy]) {
    const projectDir = projectDirIn(root, projectRoot)
    let sessions: string[]
    try {
      sessions = await fsp.readdir(projectDir)
    } catch {
      continue
    }
    const base = Buffer.from(absPath).toString('base64url')
    for (const sessionId of sessions) {
      let files: string[]
      try {
        files = await fsp.readdir(path.join(projectDir, sessionId))
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.startsWith(`${base}.snap`) && !f.startsWith(`${base}~`)) continue
        const parsed = parseSnapName(f)
        if (!parsed || parsed.absPath !== absPath) continue
        const meta = await readSnap(path.join(projectDir, sessionId, f))
        if (!meta) continue
        out.push({ ts: meta.ts, versionKey: parsed.versionKey, sessionId })
      }
    }
  }
  out.sort((x, y) => y.ts - x.ts)
  return out.slice(0, 20)
}

/** 读取指定快照内容（版本 key 为 null 即基线）；不存在/损坏返回 null */
export async function readSnapshotContent(
  projectRoot: string, sessionId: string, absPath: string, versionKey: string | null,
): Promise<string | null> {
  const { current, legacy } = await snapshotRoots()
  for (const root of [current, legacy]) {
    const meta = await readSnap(snapFileIn(root, projectRoot, sessionId, absPath, versionKey ?? undefined))
    if (meta) return meta.content
  }
  return null
}

/** 快照内容 vs 磁盘当前内容的 unified diff（快照不存在抛错，磁盘读取失败按空文件） */
export async function snapshotDiff(
  projectRoot: string, sessionId: string, absPath: string, versionKey: string | null,
): Promise<string> {
  const snap = await readSnapshotContent(projectRoot, sessionId, absPath, versionKey)
  if (snap === null) throw new Error('快照不存在或已损坏')
  const cur = await fsp.readFile(absPath, 'utf8').catch(() => '')
  return unifiedDiff(snap, cur)
}

/** 列出所有快照：absPath → { ts, sessionId }（每文件取 ts 最新的一份；新旧两根合并，时间新者胜） */
export async function listSnapshots(projectRoot: string): Promise<Record<string, { ts: number; sessionId: string }>> {
  const out: Record<string, { ts: number; sessionId: string }> = {}
  const { current, legacy } = await snapshotRoots()
  // legacy 先扫，current 后扫：同 absPath 时时间新的自然留下
  for (const root of [legacy, current]) {
    const projectDir = projectDirIn(root, projectRoot)
    let sessions: string[] = []
    try {
      sessions = await fsp.readdir(projectDir)
    } catch {
      continue
    }
    for (const sessionId of sessions) {
      const dir = path.join(projectDir, sessionId)
      let files: string[] = []
      try {
        files = await fsp.readdir(dir)
      } catch {
        continue
      }
      for (const f of files) {
        const parsed = parseSnapName(f)
        if (!parsed) continue
        try {
          const meta = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as SnapMeta
          const abs = parsed.absPath
          if (!out[abs] || meta.ts > out[abs].ts) out[abs] = { ts: meta.ts, sessionId }
        } catch {
          /* 单个损坏快照跳过 */
        }
      }
    }
  }
  return out
}

/** 回退单个文件到它的最新快照（基线优先于版本：基线是「AI 动手前」的原始状态） */
export async function restoreFile(projectRoot: string, absPath: string): Promise<void> {
  const info = (await listSnapshots(projectRoot))[absPath]
  if (!info) throw new Error('该文件没有可回退的快照')
  await restoreOne(projectRoot, info.sessionId, absPath)
}

/** 回退某会话的全部快照文件，返回回退的文件数（新旧两根同名会话都算）。 */
export async function restoreSession(projectRoot: string, sessionId: string): Promise<number> {
  const { current, legacy } = await snapshotRoots()
  let count = 0
  for (const root of [legacy, current]) {
    const dir = sessionDirIn(root, projectRoot, sessionId)
    let files: string[] = []
    try {
      files = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const parsed = parseSnapName(f)
      if (!parsed) continue
      const meta = await readSnap(path.join(dir, f))
      if (!meta) continue // 损坏快照跳过，不炸整个恢复
      try {
        await atomicWriteFile(parsed.absPath, meta.content)
        await fsp.rm(path.join(dir, f), { force: true }).catch(() => {})
        count++
      } catch {
        /* 单个失败不中断 */
      }
    }
  }
  return count
}

/** 回退到指定版本（原子写；该快照消费后移除，其余版本保留可再回退） */
export async function restoreSnapshotAt(
  projectRoot: string, sessionId: string, absPath: string, versionKey: string | null,
): Promise<void> {
  const content = await readSnapshotContent(projectRoot, sessionId, absPath, versionKey)
  if (content === null) throw new Error('快照不存在或已损坏')
  const { current, legacy } = await snapshotRoots()
  for (const root of [current, legacy]) {
    const file = snapFileIn(root, projectRoot, sessionId, absPath, versionKey ?? undefined)
    try {
      await fsp.access(file)
      await atomicWriteFile(absPath, content)
      await fsp.rm(file, { force: true }).catch(() => {})
      return
    } catch {
      continue
    }
  }
  throw new Error('快照文件不存在')
}

async function restoreOne(projectRoot: string, sessionId: string, absPath: string): Promise<void> {
  const { current, legacy } = await snapshotRoots()
  for (const root of [current, legacy]) {
    const file = snapFileIn(root, projectRoot, sessionId, absPath)
    const meta = await readSnap(file)
    if (!meta) continue
    await atomicWriteFile(absPath, meta.content)
    await fsp.rm(file, { force: true }).catch(() => {})
    return
  }
  throw new Error('快照文件不存在')
}

/** 项目文件被删除后清理其全部快照：同路径重建项目时旧快照不允许复活（回退会覆盖新项目内容）。 */
export async function clearProjectSnapshots(projectRoot: string): Promise<void> {
  const { current, legacy } = await snapshotRoots()
  for (const root of [current, legacy]) {
    try {
      await fsp.rm(projectDirIn(root, projectRoot), { recursive: true, force: true })
    } catch {
      /* 清理失败不影响删除流程 */
    }
  }
}
