/**
 * 存储位置迁移：用户在设置中选择新数据目录 → 校验 → checkpoint → 关库搬文件 → 目标验证 →
 * 更新 config.dataDir → 重开连接。任一步失败尽力回滚（文件挪回原位、config 不动），绝不留半态。
 * 迁移窗口内 setMigrating(true)：getDb() 一律拒绝，防止渲染层写请求打到半移动状态。
 * ~/.qyris 只存系统必须（config/secrets），永不迁移；snapshots/ 随库走（复制成功才删源）。
 */
import { BrowserWindow, dialog } from 'electron'
import {
  copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { closeDb, dataDir, getDb, rebaseOverrideDir, setMigrating } from './db'
import * as config from './config'

export interface MigrateResult {
  ok: boolean
  error?: string
}

/** config 落盘动作（smoke 注入 spy 用，生产走 mergeConfig）；null 表示恢复缺省目录 */
type ConfigWriter = (dir: string | null) => Promise<void>

const defaultConfigWriter: ConfigWriter = async (dir) => {
  await config.mergeConfig({ dataDir: dir })
}

let configWriter: ConfigWriter = defaultConfigWriter

/** 测试钩子：注入 config 写入 spy（置 null 恢复默认） */
export function setConfigWriter(fn: ConfigWriter | null): void {
  configWriter = fn ?? defaultConfigWriter
}

/** 设置页目录选择器（绑定调用方窗口；取消回 null） */
export async function selectDataDir(win?: BrowserWindow | null): Promise<string | null> {
  const properties: Array<'openDirectory' | 'createDirectory'> = ['openDirectory', 'createDirectory']
  const opts = { title: '选择数据目录', properties }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

let inFlight = false

/** 迁移主流程：校验 → checkpoint → 关库搬文件 → 目标验证 → 写 config → 重开。
 *  失败回滚：db 挪回原位、仅删除本次复制到目标的新增快照文件、config 恢复原值。 */
export async function migrateDataDir(targetDir: string): Promise<MigrateResult> {
  if (inFlight) return { ok: false, error: '已有迁移在进行中' }
  inFlight = true
  try {
    const target = path.resolve(String(targetDir ?? '').trim())
    if (!target) return { ok: false, error: '目标目录为空' }
    const sourceNorm = path.resolve(await dataDir())
    if (target === sourceNorm) return { ok: false, error: '目标目录与当前数据目录相同' }
    const rel = path.relative(sourceNorm, target)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { ok: false, error: '目标目录不能位于当前数据目录内部' }
    }

    // —— 目标校验：可创建、可写、无既有数据 ——
    try {
      mkdirSync(target, { recursive: true })
    } catch (e) {
      return { ok: false, error: `目标目录无法创建：${String(e)}` }
    }
    try {
      const probe = path.join(target, `.qyris-probe-${Date.now()}`)
      writeFileSync(probe, 'ok')
      unlinkSync(probe)
    } catch (e) {
      return { ok: false, error: `目标目录不可写：${String(e)}` }
    }
    // 网络盘警告：WAL 有损坏风险，db.ts 会自动降级 journal_mode=DELETE（安全但写入稍慢）
    if (target.startsWith('\\\\')) {
      console.warn(`[migrate] 目标目录位于网络路径（${target}），WAL 将降级为 journal_mode=DELETE。建议使用本地磁盘。`)
    }

    const targetDb = path.join(target, 'qyris.db')
    if (existsSync(targetDb) && statSync(targetDb).size > 0) {
      // 上次迁移中断接管（P1 遗留修复①）：目标已有非空库而源库缺失/为空库（messages+mem_items
      // 均 0 行）→ 视为上次迁移在写 config 前中断，跳过搬移直接接管目标库。
      // 源库非空则仍是真冲突，拒绝覆盖。
      const sourceDbPath = path.join(sourceNorm, 'qyris.db')
      const interrupted = !existsSync(sourceDbPath) || (await sourceTablesEmpty())
      if (!interrupted) return { ok: false, error: '目标目录已存在非空数据库，拒绝覆盖' }
      return takeoverInterrupted(target, targetDb, sourceNorm)
    }

    // —— 迁移前基线：行数对账 + checkpoint ——
    const db = await getDb()
    const countOf = (table: string): number =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
    const baseMessages = countOf('messages')
    const baseMem = countOf('mem_items')
    db.pragma('wal_checkpoint(TRUNCATE)')

    const sourceDb = path.join(sourceNorm, 'qyris.db')
    const sourceSnaps = path.join(sourceNorm, 'snapshots')
    const targetSnaps = path.join(target, 'snapshots')
    const hasSnaps = existsSync(sourceSnaps)

    setMigrating(true)
    const copiedSnaps: string[] = [] // 本次复制到目标的新增文件（回滚时精确删除）
    try {
      // —— 关库搬文件 ——
      closeDb()
      if (existsSync(sourceDb)) {
        moveFile(sourceDb, targetDb)
        for (const suffix of ['-wal', '-shm']) {
          if (existsSync(sourceDb + suffix)) moveFile(sourceDb + suffix, targetDb + suffix)
        }
      }
      if (hasSnaps) await copySnapshots(sourceSnaps, targetSnaps, copiedSnaps)

      // —— 目标验证：完整性 + 行数对账 ——
      const vdb = new Database(targetDb)
      try {
        const integrity = vdb.pragma('integrity_check', { simple: true })
        if (integrity !== 'ok') throw new Error(`integrity_check：${String(integrity)}`)
        const m = Number((vdb.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n)
        const mem = Number((vdb.prepare('SELECT COUNT(*) AS n FROM mem_items').get() as { n: number }).n)
        if (m !== baseMessages || mem !== baseMem) {
          throw new Error(`行数对账失败：messages ${baseMessages}→${m}，mem_items ${baseMem}→${mem}`)
        }
      } finally {
        vdb.close()
      }

      // —— 通过：更新 config 指针（失败走外层统一回滚，此时 config 尚未变更） ——
      const cfgBefore = (await config.getConfig()).dataDir ?? null
      await configWriter(target)
      rebaseOverrideDir(target) // smoke override 模式下同步测试根；生产 no-op
      setMigrating(false)
      try {
        await getDb()
      } catch (e) {
        // 重开失败：指针已切但库不可用——文件回滚到旧位 + config 恢复原值
        await rollbackFiles(targetDb, targetSnaps, copiedSnaps, sourceNorm, hasSnaps)
        await configWriter(cfgBefore).catch(() => {})
        rebaseOverrideDir(sourceNorm)
        return { ok: false, error: `迁移完成但重开连接失败，已回滚：${String(e)}` }
      }

      // —— 收尾：删除源侧快照残留（目标验证通过才删，快照不搬丢） ——
      if (hasSnaps) await fsp.rm(sourceSnaps, { recursive: true, force: true }).catch(() => {})
      return { ok: true }
    } catch (e) {
      // —— 关键段失败（含 config 写入失败）：文件尽力回滚，config 不动 ——
      await rollbackFiles(targetDb, targetSnaps, copiedSnaps, sourceNorm, hasSnaps)
      return { ok: false, error: `迁移失败：${e instanceof Error ? e.message : String(e)}` }
    } finally {
      setMigrating(false)
    }
  } finally {
    inFlight = false
  }
}

// ---------- 内部 ----------

/** 源库是否为空库（messages + mem_items 均 0 行）。源库不可读/表缺席时回 false（无法确认
 *  中断即保守拒绝，绝不拿非空目标库盖住可疑源库） */
async function sourceTablesEmpty(): Promise<boolean> {
  try {
    const db = await getDb()
    const countOf = (table: string): number =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
    return countOf('messages') === 0 && countOf('mem_items') === 0
  } catch {
    return false
  }
}

/** 上次迁移中断的接管：跳过搬移，走验证 → 写 config → 重开。快照若仍在源侧则随迁（成功才删源）。
 *  行数对账不可做（源库缺失/空，无基线），仅 integrity_check 把关；失败尽力回滚（文件挪回源位、
 *  config 恢复原值），绝不留半态。 */
async function takeoverInterrupted(target: string, targetDb: string, sourceNorm: string): Promise<MigrateResult> {
  const sourceSnaps = path.join(sourceNorm, 'snapshots')
  const targetSnaps = path.join(target, 'snapshots')
  const hasSnaps = existsSync(sourceSnaps)
  setMigrating(true)
  const copiedSnaps: string[] = [] // 本次复制到目标的新增快照文件（回滚时精确删除）
  try {
    // —— 目标验证：完整性 ——
    const vdb = new Database(targetDb)
    try {
      const integrity = vdb.pragma('integrity_check', { simple: true })
      if (integrity !== 'ok') throw new Error(`integrity_check：${String(integrity)}`)
    } finally {
      vdb.close()
    }
    if (hasSnaps) await copySnapshots(sourceSnaps, targetSnaps, copiedSnaps)

    // —— 写 config 指针 → 重开连接 ——
    const cfgBefore = (await config.getConfig()).dataDir ?? null
    await configWriter(target)
    rebaseOverrideDir(target) // smoke override 模式下同步测试根；生产 no-op
    setMigrating(false) // 先出迁移闸门再重开（getDb 在 migrating 期一律拒绝）
    try {
      closeDb() // 单例可能还连着源库（接管前段读写过游标/计数），必须先关再重开
      await getDb()
    } catch (e) {
      // 重开失败：指针已切但库不可用——文件回滚到源位（源位即接管前的有效位置）+ config 恢复原值
      await rollbackFiles(targetDb, targetSnaps, copiedSnaps, sourceNorm, hasSnaps)
      await configWriter(cfgBefore).catch(() => {})
      rebaseOverrideDir(sourceNorm)
      return { ok: false, error: `接管完成但重开连接失败，已回滚：${String(e)}` }
    }

    // —— 收尾：删除源侧快照残留 ——
    if (hasSnaps) await fsp.rm(sourceSnaps, { recursive: true, force: true }).catch(() => {})
    return { ok: true }
  } catch (e) {
    await rollbackFiles(targetDb, targetSnaps, copiedSnaps, sourceNorm, hasSnaps)
    return { ok: false, error: `接管失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    setMigrating(false)
  }
}

/** 移动单文件：同卷 rename（瞬时）；跨卷 EXDEV 退 copy+unlink */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/** 递归复制 snapshots（记录新增文件清单供精确回滚）；复制成功后由调用方决定删源时机 */
async function copySnapshots(src: string, dest: string, copied: string[]): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) {
      await copySnapshots(s, d, copied)
    } else if (ent.isFile()) {
      await fsp.copyFile(s, d)
      copied.push(d)
    }
  }
}

/** 回滚（best-effort，逐步吞错并告警，绝不在回滚途中抛）：db 挪回原位、删除本次复制的快照与其空目录 */
async function rollbackFiles(
  targetDb: string, targetSnaps: string, copied: string[], sourceNorm: string, hasSnaps: boolean,
): Promise<void> {
  try {
    closeDb()
  } catch { /* 未打开时忽略 */ }
  try {
    if (existsSync(targetDb)) {
      moveFile(targetDb, path.join(sourceNorm, 'qyris.db'))
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(targetDb + suffix)) moveFile(targetDb + suffix, path.join(sourceNorm, 'qyris.db' + suffix))
      }
    }
  } catch (e) {
    console.warn(`[migrate] 回滚 db 文件失败：${String(e)}`)
  }
  for (const f of copied) {
    await fsp.rm(f, { force: true }).catch(() => {})
  }
  if (hasSnaps) await pruneEmptyDirs(targetSnaps).catch(() => {})
}

/** 自底向上清空本次新建的空目录（目标侧既有内容不动） */
async function pruneEmptyDirs(root: string): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (ent.isDirectory()) await pruneEmptyDirs(path.join(root, ent.name))
  }
  const rest = await fsp.readdir(root).catch(() => null)
  if (rest !== null && rest.length === 0) await fsp.rmdir(root).catch(() => {})
}
