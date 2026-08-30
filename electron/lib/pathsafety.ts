/**
 * 路径安全内核 —— src-tauri fs.rs ensure_inside / validate_name（fs.rs:151-217）的逐语义移植。
 * 关键点：前缀比较按路径组件逐段进行（不是字符串 startsWith，`C:\project2` 不得误配 `C:\proj`）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { errorMessage } from './util'

const WIN_LONG_PREFIX = '\\\\?\\' // 实际字符串 \\?\
const WIN_UNC_PREFIX = '\\\\?\\UNC\\' // 实际字符串 \\?\UNC\

/** 剥 Windows 扩展长度前缀（Unix 路径原样返回） */
function simplePath(p: string): string {
  if (p.startsWith(WIN_UNC_PREFIX)) return '\\\\' + p.slice(WIN_UNC_PREFIX.length)
  if (p.startsWith(WIN_LONG_PREFIX)) return p.slice(WIN_LONG_PREFIX.length)
  return p
}

/** 按分隔符切成组件（吸收绝对/UNC/盘符形态差异，仅用于前缀比较） */
function splitComponents(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0)
}

/** 组件级前缀比较（大小写敏感，与 Rust 组件比较语义对齐） */
function startsWithComponents(root: string, target: string): boolean {
  const r = splitComponents(root)
  const t = splitComponents(target)
  if (t.length < r.length) return false
  for (let i = 0; i < r.length; i++) {
    if (r[i] !== t[i]) return false
  }
  return true
}

/**
 * 词法归一化：丢弃 `.`；`..` 弹出上一段（在根上 pop 为 no-op，不逃逸）。
 * 不触盘、不改大小写 —— 与 Rust normalize_lexical 一致。
 */
function normalizeLexical(absolute: string): string {
  const isWin = process.platform === 'win32'
  const sep = isWin ? '\\' : '/'
  const segs = absolute.split(/[\\/]+/).filter((s) => s.length > 0)

  let prefix = ''
  if (isWin) {
    if (/^[a-zA-Z]:$/.test(segs[0] ?? '')) {
      prefix = segs.shift()! + sep
    } else if (/^\\\\/.test(absolute)) {
      const server = segs.shift() ?? ''
      const share = segs.shift() ?? ''
      prefix = '\\\\' + server + sep + share
    } else if (/^[\\/]/.test(absolute)) {
      prefix = sep
    }
  } else if (absolute.startsWith('/')) {
    prefix = '/'
  }

  const out: string[] = []
  for (const seg of segs) {
    if (seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return prefix + out.join(sep)
}

/**
 * 校验 target 位于 projectRoot 内，返回内部安全路径（canonical 或词法归一化）。
 * 存在路径走 realpath（解析 symlink 逃逸、返回 OS 真实大小写）；
 * 不存在路径走词法归一化（新建文件场景）。
 */
export async function ensureInside(projectRoot: string, target: string): Promise<string> {
  let rootCanon: string
  try {
    rootCanon = await fsp.realpath(projectRoot)
  } catch (e) {
    throw new Error(`无法定位项目根目录：${errorMessage(e)}`)
  }
  const rootSimple = simplePath(rootCanon)

  const absolute = path.isAbsolute(target) ? target : path.join(rootSimple, target)

  let canon: string | null = null
  try {
    canon = await fsp.realpath(absolute)
  } catch {
    canon = null // 不存在/不可达 → 词法归一化分支
  }

  if (canon !== null) {
    const simple = simplePath(canon)
    if (startsWithComponents(rootSimple, simple)) return simple
    throw new Error(`路径越出项目根目录：${absolute}`)
  }

  const normalized = normalizeLexical(absolute)
  if (startsWithComponents(rootSimple, normalized)) return normalized
  throw new Error(`路径越出项目根目录：${absolute}`)
}

/** 新建条目名称校验：校验用 trim 副本，落盘仍用原始 name（与 Rust 一致） */
export function validateName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('名称不能为空')
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error('名称不能包含路径分隔符')
  }
}
