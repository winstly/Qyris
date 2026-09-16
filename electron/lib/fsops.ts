/** 文件系统命令 */
import { promises as fsp, type Stats, type Dirent } from 'node:fs'
import path from 'node:path'
import { ensureInside, validateName } from './pathsafety'
import { errorMessage } from './util'

export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'folder'
}

export interface FileContent {
  content: string
  isBinary: boolean
  truncated: boolean
  /** 磁盘文件 mtime（渲染层保存前回传做冲突检测的基线） */
  mtimeMs: number
}

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2MB 截断阈值
const BINARY_SNIFF_BYTES = 8192

/** 文件名搜索保护：命中条数上限 / 遍历条目上限（防巨型仓库卡死主进程） */
const SEARCH_MAX_RESULTS = 200
const SEARCH_MAX_VISITED = 50_000

export interface SearchResult {
  files: string[]
  /** 命中数达到上限被截断（可能还有更多结果） */
  truncated: boolean
}

/** 仅 list_dir 过滤（精确相等、大小写敏感）；其余命令可读/删这些目录内部文件 */
const IGNORED = [
  'node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt',
  '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  '.DS_Store', 'Thumbs.db',
]

function isIgnored(name: string): boolean {
  return IGNORED.includes(name)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

/** 单层懒加载目录列表（树靠前端展开） */
export async function listDir(projectRoot: string, dir: string): Promise<TreeNode[]> {
  const target = await ensureInside(projectRoot, dir)
  let dirents: Dirent[]
  try {
    dirents = await fsp.readdir(target, { withFileTypes: true })
  } catch (e) {
    throw new Error(`无法读取目录 ${target}：${errorMessage(e)}`)
  }
  const nodes: TreeNode[] = []
  for (const de of dirents) {
    if (isIgnored(de.name)) continue
    nodes.push({
      name: de.name,
      path: path.join(target, de.name),
      // 不解析 symlink，目录 symlink 显示为 file
      kind: de.isDirectory() ? 'folder' : 'file',
    })
  }
  // 文件夹在前，其后按小写名称比较；Array.sort 在 V8 为稳定排序
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    const al = a.name.toLowerCase()
    const bl = b.name.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })
  return nodes
}

/** 批量目录列表：一次 IPC 取多个目录内容（主进程端并发 fs.readdir）。
 *  单目录失败不影响其他（返回空数组 + console.warn）。 */
export async function listDirBatch(projectRoot: string, dirs: string[]): Promise<Record<string, TreeNode[]>> {
  const results: Record<string, TreeNode[]> = {}
  await Promise.all(dirs.map(async (dir) => {
    try {
      results[dir] = await listDir(projectRoot, dir)
    } catch (e) {
      console.warn(`[fsops] listDirBatch 单目录失败 ${dir}：${String(e)}`)
      results[dir] = []
    }
  }))
  return results
}

/** 递归按文件名搜索：大小写不敏感子串匹配相对路径；跳过 IGNORED 目录，symlink 不跟随（防环） */
export async function searchFiles(
  projectRoot: string, query: string, limit = SEARCH_MAX_RESULTS,
): Promise<SearchResult> {
  const root = await ensureInside(projectRoot, projectRoot)
  const q = query.trim().toLowerCase()
  if (!q) return { files: [], truncated: false }
  const results: string[] = []
  let visited = 0

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit || visited >= SEARCH_MAX_VISITED) return
    let dirents: Dirent[]
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // 无权限 / 已被删除的目录静默跳过
    }
    for (const de of dirents) {
      if (results.length >= limit || visited >= SEARCH_MAX_VISITED) return
      visited++
      if (isIgnored(de.name)) continue
      const abs = path.join(dir, de.name)
      if (de.isFile() && de.name.toLowerCase().includes(q)) {
        results.push(path.relative(root, abs))
        if (results.length >= limit) return
      }
      // isDirectory() 不解析 symlink，指向目录的 symlink 不会进入递归
      if (de.isDirectory()) await walk(abs)
    }
  }

  await walk(root)
  return { files: results, truncated: results.length >= limit }
}

/** 读文本文件：全量进内存 → 截 2MB → 前 8192 字节含 NUL 判二进制 */
export async function readTextFile(projectRoot: string, filePath: string): Promise<FileContent> {
  const target = await ensureInside(projectRoot, filePath)
  let meta: Stats
  try {
    meta = await fsp.stat(target) // 跟随 symlink
  } catch (e) {
    throw new Error(`文件不存在或不可访问：${errorMessage(e)}`)
  }
  if (meta.isDirectory()) throw new Error('目标是目录而非文件')

  const truncated = meta.size > MAX_READ_BYTES
  let buf: Buffer
  try {
    buf = await fsp.readFile(target)
  } catch (e) {
    throw new Error(`读取失败：${errorMessage(e)}`)
  }
  const slice = buf.subarray(0, MAX_READ_BYTES)
  if (slice.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    // 二进制文件不计入截断
    return { content: '', isBinary: true, truncated: false, mtimeMs: meta.mtimeMs }
  }
  // Buffer.toString('utf8') 为 lossy 解析（非法序列 → U+FFFD）
  return { content: slice.toString('utf8'), isBinary: false, truncated, mtimeMs: meta.mtimeMs }
}

/** 原子写：先写同目录临时文件再 rename 覆盖，崩溃不会截断原文件（Windows rename 语义可覆盖） */
export async function atomicWriteFile(target: string, content: string): Promise<void> {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  )
  try {
    await fsp.writeFile(tmp, content, 'utf8')
    await fsp.rename(tmp, target)
  } catch (e) {
    try {
      await fsp.unlink(tmp)
    } catch { /* 临时文件清理失败不掩盖原错误 */ }
    throw e
  }
}

/** mtime 冲突哨兵：渲染层按此前缀识别冲突类错误并弹对话框（Electron IPC 只传 message） */
export const FILE_CONFLICT_PREFIX = 'FILE_CONFLICT::'

/** 写文本文件：自动递归建父目录，原子写 UTF-8 无 BOM。
 *  opts.expectedMtimeMs：调用方持有的磁盘基线；当前 mtime 更新且未 force 时抛 FILE_CONFLICT
 *  （防 AI 写入 / 外部进程改动被静默覆盖，选择权交给用户）。返回写入后的 mtime。 */
export async function writeTextFile(
  projectRoot: string, filePath: string, content: string,
  opts?: { expectedMtimeMs?: number | null; force?: boolean },
): Promise<{ mtimeMs: number }> {
  const target = await ensureInside(projectRoot, filePath)
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
  } catch (e) {
    throw new Error(`无法创建父目录：${errorMessage(e)}`)
  }
  if (opts?.expectedMtimeMs != null && opts.force !== true) {
    const cur = await fsp.stat(target).catch(() => null)
    if (cur && cur.mtimeMs > opts.expectedMtimeMs) {
      throw new Error(
        `${FILE_CONFLICT_PREFIX}文件已被外部修改（AI 或其他程序在你编辑期间写入了该文件）。` +
        `保存将覆盖外部修改，请确认。`,
      )
    }
  }
  try {
    await atomicWriteFile(target, content)
  } catch (e) {
    throw new Error(`写入失败：${errorMessage(e)}`)
  }
  const written = await fsp.stat(target)
  return { mtimeMs: written.mtimeMs }
}

/** 内容搜索结果：文件（相对路径）+ 行号 + 该行文本（截 200 字符） */
export interface GrepMatch {
  path: string
  line: number
  text: string
}

export interface GrepResult {
  matches: GrepMatch[]
  /** 命中文件数 */
  fileCount: number
  /** 达到上限截断 */
  truncated: boolean
}

const GREP_MAX_MATCHES = 120
const GREP_MAX_FILE_BYTES = 512 * 1024 // 单文件读入上限（超过跳过，防巨型文件卡死）

/** 递归按内容搜索：JS 正则（自动转义普通文本），跳过 IGNORED 目录与二进制嗅探不通过的文件。
 *  有界遍历（命中/访问双重上限），主进程一次 IPC 完成查询。 */
export async function grepFiles(
  projectRoot: string, pattern: string,
  opts?: { glob?: string; maxResults?: number; caseSensitive?: boolean },
): Promise<GrepResult> {
  const root = await ensureInside(projectRoot, projectRoot)
  const maxResults = Math.min(Math.max(opts?.maxResults ?? GREP_MAX_MATCHES, 1), 500)
  let re: RegExp
  try {
    const flags = opts?.caseSensitive ? 'g' : 'gi'
    re = new RegExp(pattern, flags)
  } catch {
    // 非法正则回退为字面量文本匹配
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts?.caseSensitive ? 'g' : 'gi')
  }
  const globLower = opts?.glob?.toLowerCase() ?? null
  const matches: GrepMatch[] = []
  const hitFiles = new Set<string>()
  let visited = 0
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (truncated || visited >= SEARCH_MAX_VISITED) return
    let dirents: Dirent[]
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const de of dirents) {
      if (truncated || visited >= SEARCH_MAX_VISITED) return
      visited++
      if (isIgnored(de.name)) continue
      const abs = path.join(dir, de.name)
      if (de.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!de.isFile()) continue
      if (globLower && !abs.toLowerCase().endsWith(globLower.replace(/^\*/, ''))) continue
      let stat: Stats
      try {
        stat = await fsp.stat(abs)
      } catch {
        continue
      }
      if (stat.size > GREP_MAX_FILE_BYTES || stat.size === 0) continue
      let buf: Buffer
      try {
        buf = await fsp.readFile(abs)
      } catch {
        continue
      }
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue // 二进制跳过
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (!re.test(lines[i])) continue
        hitFiles.add(abs)
        matches.push({
          path: path.relative(root, abs),
          line: i + 1,
          text: lines[i].trim().slice(0, 200),
        })
        if (matches.length >= maxResults) {
          truncated = true
          break
        }
      }
      if (truncated) return
    }
  }

  await walk(root)
  return { matches, fileCount: hitFiles.size, truncated }
}

/** 精确替换文本文件中的指定内容：oldString 必须唯一匹配（0 或 >1 均报错） */
export async function editTextFile(
  projectRoot: string, filePath: string, oldString: string, newString: string,
): Promise<{ replaced: number; lineCount: number }> {
  const target = await ensureInside(projectRoot, filePath)
  let content: string
  try {
    content = await fsp.readFile(target, 'utf8')
  } catch (e) {
    throw new Error(`文件不存在或不可读：${errorMessage(e)}`)
  }
  const count = content.split(oldString).length - 1
  if (count === 0) throw new Error('old_string 在文件中未找到，请确认文本完全一致（含缩进和换行）。')
  if (count > 1) throw new Error(`old_string 在文件中匹配到 ${count} 处，请用更精确的文本确保唯一匹配。`)
  const replaced = content.replace(oldString, newString)
  try {
    await atomicWriteFile(target, replaced)
  } catch (e) {
    throw new Error(`写入失败：${errorMessage(e)}`)
  }
  return { replaced: 1, lineCount: replaced.split('\n').length }
}

/** 新建文件/文件夹：单层 mkdir，不递归；已存在报同名错误 */
export async function createEntry(
  projectRoot: string, parentDir: string, name: string, isDir: boolean,
): Promise<TreeNode> {
  validateName(name)
  const parent = await ensureInside(projectRoot, parentDir)
  const target = path.join(parent, name) // join 未 trim 的原始 name
  if (await exists(target)) throw new Error(`同名文件或文件夹已存在：${name}`)
  try {
    if (isDir) await fsp.mkdir(target)
    else await fsp.writeFile(target, '')
  } catch (e) {
    throw new Error(`创建失败：${errorMessage(e)}`)
  }
  return { name, path: target, kind: isDir ? 'folder' : 'file' }
}

/** 同目录改名 */
export async function renameEntry(projectRoot: string, filePath: string, newName: string): Promise<string> {
  validateName(newName)
  const src = await ensureInside(projectRoot, filePath)
  const parent = path.dirname(src)
  if (!parent || parent === src) throw new Error('无法获取父目录')
  const dest = path.join(parent, newName)
  if (await exists(dest)) throw new Error(`同名文件或文件夹已存在：${newName}`)
  try {
    await fsp.rename(src, dest)
  } catch (e) {
    throw new Error(`重命名失败：${errorMessage(e)}`)
  }
  return dest
}

/** 删除文件/目录（目录递归）；项目根拒绝删除 */
export async function deleteEntry(projectRoot: string, filePath: string): Promise<void> {
  const root = await ensureInside(projectRoot, projectRoot)
  const target = await ensureInside(projectRoot, filePath)
  if (target === root) throw new Error('不能删除项目根目录')
  try {
    const st = await fsp.stat(target) // 跟随 symlink
    if (st.isDirectory()) await fsp.rm(target, { recursive: true })
    else await fsp.unlink(target)
  } catch (e) {
    throw new Error(`删除失败：${errorMessage(e)}`)
  }
}

/** 在目标目录中找到不冲突的路径，重名自动加 (N) 后缀 */
async function uniqueDest(destParent: string, name: string): Promise<string> {
  let dest = path.join(destParent, name)
  if (!(await exists(dest))) return dest
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    dest = path.join(destParent, `${base}(${i})${ext}`)
    if (!(await exists(dest))) return dest
  }
}

/** 递归复制文件/目录到目标目录，重名自动加 (N) 后缀 */
export async function copyEntry(
  projectRoot: string, srcPath: string, destDir: string,
): Promise<TreeNode> {
  const src = await ensureInside(projectRoot, srcPath)
  const destParent = await ensureInside(projectRoot, destDir)
  const dest = await uniqueDest(destParent, path.basename(src))
  try {
    await fsp.cp(src, dest, { recursive: true })
  } catch (e) {
    throw new Error(`复制失败：${errorMessage(e)}`)
  }
  const st = await fsp.stat(dest)
  return { name: path.basename(dest), path: dest, kind: st.isDirectory() ? 'folder' : 'file' }
}

/** 移动文件/目录到目标目录，重名自动加 (N) 后缀 */
export async function moveEntry(
  projectRoot: string, srcPath: string, destDir: string,
): Promise<TreeNode> {
  const src = await ensureInside(projectRoot, srcPath)
  const destParent = await ensureInside(projectRoot, destDir)
  const dest = await uniqueDest(destParent, path.basename(src))
  try {
    await fsp.rename(src, dest)
  } catch (e) {
    throw new Error(`移动失败：${errorMessage(e)}`)
  }
  const st = await fsp.stat(dest)
  return { name: path.basename(dest), path: dest, kind: st.isDirectory() ? 'folder' : 'file' }
}

/** 删除整个项目目录（递归删除，危险操作）。
 *  Windows 特殊处理：fsp.rm(recursive) 有时清空内容但留空根目录（杀软/索引服务锁句柄），
 *  失败后额外尝试 rmdir 兜底。 */
export async function deleteProjectFiles(projectRoot: string): Promise<void> {
  // 幂等删除：目录已不存在视为成功
  try {
    const st = await fsp.stat(projectRoot)
    if (!st.isDirectory()) throw new Error('目标不是目录')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`项目目录不存在或无法访问：${errorMessage(e)}`)
  }

  // 策略：直接删 → EBUSY 时 rename 逃逸 → 再删一次
  // Windows 上 rename 不要求目录无占用，rename 成功后原路径立即不可见。
  const tryRm = async (): Promise<boolean> => {
    try {
      await fsp.rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      return true
    } catch {
      try {
        const remaining = await fsp.readdir(projectRoot)
        if (remaining.length === 0) { await fsp.rmdir(projectRoot); return true }
      } catch { return true } // ENOENT
      return false
    }
  }

  // 第一轮：直接删（覆盖大部分正常场景）
  if (await tryRm()) return

  // 第二轮：EBUSY → rename 逃逸（核心优化）
  // rename 成功后原路径立即不可见，用户感知 = 已删除。
  // 残留副本在后台异步清理（不阻塞前端）。
  const tmpPath = projectRoot + `.__deleting__${Date.now()}`
  try {
    await fsp.rename(projectRoot, tmpPath)
    // 后台异步清理残留（fire-and-forget）
    fsp.rm(tmpPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 2000 }).catch(() => {})
    return
  } catch { /* rename 也失败 → 最后尝试 */ }

  // 第三轮：rename 也失败（极端情况），再试一次 rm
  if (await tryRm()) return

  throw new Error('删除项目文件失败：文件被其他程序持续占用。请关闭占用该目录的程序（如文件管理器、编辑器、杀毒软件）后重试，或手动删除项目文件夹，或重启电脑后重试。')
}
