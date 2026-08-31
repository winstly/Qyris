/** 文件系统命令 —— fs.rs 六个 command 的逐语义移植 */
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
      // 不解析 symlink：与 Rust file_type() 行为一致（Unix 目录 symlink 显示为 file）
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
    meta = await fsp.stat(target) // 跟随 symlink，与 Rust fs::metadata 一致
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
    // 判二进制时 truncated 强制 false（与 Rust 一致）
    return { content: '', isBinary: true, truncated: false }
  }
  // Buffer.toString('utf8') 为 lossy 解析（非法序列 → U+FFFD），与 from_utf8_lossy 一致
  return { content: slice.toString('utf8'), isBinary: false, truncated }
}

/** 写文本文件：自动递归建父目录，覆盖写 UTF-8 无 BOM */
export async function writeTextFile(projectRoot: string, filePath: string, content: string): Promise<void> {
  const target = await ensureInside(projectRoot, filePath)
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
  } catch (e) {
    throw new Error(`无法创建父目录：${errorMessage(e)}`)
  }
  try {
    await fsp.writeFile(target, content, 'utf8')
  } catch (e) {
    throw new Error(`写入失败：${errorMessage(e)}`)
  }
}

/** 新建文件/文件夹：单层 mkdir，不递归；已存在报同名错误 */
export async function createEntry(
  projectRoot: string, parentDir: string, name: string, isDir: boolean,
): Promise<TreeNode> {
  validateName(name)
  const parent = await ensureInside(projectRoot, parentDir)
  const target = path.join(parent, name) // join 未 trim 的原始 name（与 Rust 一致）
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
    const st = await fsp.stat(target) // 跟随 symlink，与 Rust target.is_dir() 一致
    if (st.isDirectory()) await fsp.rm(target, { recursive: true })
    else await fsp.unlink(target)
  } catch (e) {
    throw new Error(`删除失败：${errorMessage(e)}`)
  }
}

/** 删除整个项目目录（递归删除，危险操作） */
export async function deleteProjectFiles(projectRoot: string): Promise<void> {
  // 幂等删除：目录已不存在视为成功（手动删过 / 重复删除的场景，不能阻塞历史条目移除）
  try {
    const st = await fsp.stat(projectRoot)
    if (!st.isDirectory()) throw new Error('目标不是目录')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`项目目录不存在或无法访问：${errorMessage(e)}`)
  }
  try {
    // maxRetries/retryDelay：杀软 / 索引服务 / 资源管理器的瞬态占用（EBUSY/EPERM/ENOTEMPTY）
    await fsp.rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (e) {
    // rm 中途目录消失（并发删除）同样视为成功
    try {
      await fsp.access(projectRoot)
    } catch {
      return
    }
    throw new Error(`删除项目文件失败：${errorMessage(e)}`)
  }
}
