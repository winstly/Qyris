/**
 * 文件工具：read_file / write_file / edit_file / list_dir / glob / grep。
 *
 * 两条铁律：
 *   1. 路径越界防护在工具层强制（pathsafety.ensureInside），不依赖模型自觉；
 *      fsops 内部虽也会校验，但工具层必须自己先把关——模型传什么路径都有可能。
 *   2. 读写/搜索直接复用 fsops，本层只做参数校验、结果格式化与展示截断。
 */
import path from 'node:path'
import { ensureInside } from '../pathsafety'
import {
  editTextFile,
  grepFiles,
  listDir,
  readTextFile,
  searchFiles,
  writeTextFile,
} from '../fsops'
import type { Tool, ToolCtx } from '../model/types'

// ---------- 入参校验（工具层本地小助手） ----------

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

/** 可缺省文本参数：缺省返回 undefined，给了就必须是非空字符串 */
function optText(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  return text(rec, key)
}

function optInt(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`)
  const n = Math.trunc(v)
  if (n < min || n > max) throw new Error(`参数 ${key} 需在 ${min}~${max} 之间`)
  return n
}

function optBool(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值`)
  return v
}

/** 未打开工程时全部文件工具不可用（fail-closed） */
function root(ctx: ToolCtx): string {
  if (!ctx.projectRoot) throw new Error('当前未打开工程，文件工具不可用')
  return ctx.projectRoot
}

/** 工程内安全绝对路径（越界直接抛错）+ 展示用相对路径 */
async function safePath(projectRoot: string, rel: string): Promise<{ abs: string; shown: string }> {
  const abs = await ensureInside(projectRoot, rel)
  const shown = path.relative(projectRoot, abs).replace(/\\/g, '/') || '.'
  return { abs, shown }
}

// ---------- 展示截断常量 ----------

const READ_DEFAULT_LINES = 2000
const READ_MAX_LINES = 5000
const LIST_MAX_ENTRIES = 200
const GLOB_MAX_RESULTS = 200
const GLOB_MAX_VISITED = 20_000
const GREP_MAX_RESULTS = 120

// ---------- 工具实现 ----------

const read: Tool = {
  name: 'read_file',
  description:
    '读取工程内文本文件。path 相对工程根（或工程内绝对路径）。' +
    'offset 为起始行号（1 起），limit 默认 2000 行。二进制文件只报存在、不返回内容。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工程根）' },
      offset: { type: 'integer', description: '起始行号（1 起）', minimum: 1 },
      limit: { type: 'integer', description: '最多返回行数，默认 2000', minimum: 1, maximum: 5000 },
    },
    required: ['path'],
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const { abs, shown } = await safePath(projectRoot, text(rec, 'path'))
    const offset = optInt(rec, 'offset', 1, 10_000_000) ?? 1
    const limit = optInt(rec, 'limit', 1, READ_MAX_LINES) ?? READ_DEFAULT_LINES

    const file = await readTextFile(projectRoot, abs)
    if (file.isBinary) {
      return { content: `[read_file] ${shown}：二进制文件，无法按文本读取` }
    }
    const lines = file.content.length ? file.content.split('\n') : []
    const start = Math.min(offset - 1, lines.length)
    const slice = lines.slice(start, start + limit)
    const head = [
      `[read_file] ${shown}`,
      `共 ${lines.length} 行` + (file.truncated ? '（文件过大，底层已截断读取）' : ''),
    ]
    if (start > 0 || start + slice.length < lines.length) {
      head.push(`显示第 ${start + 1}~${start + slice.length} 行`)
    }
    return { content: `${head.join('\n')}\n\n${slice.join('\n')}` }
  },
}

const write: Tool = {
  name: 'write_file',
  description:
    '整体写入文本文件（UTF-8 无 BOM，自动建父目录，原子写）。' +
    '会覆盖已有内容——覆盖已存在的文件前必须先 read_file 确认现状，改局部请用 edit_file。content 允许为空字符串。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工程根）' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const { abs, shown } = await safePath(projectRoot, text(rec, 'path'))
    const content = rec.content
    if (typeof content !== 'string') throw new Error('参数 content 必须是字符串')

    await writeTextFile(projectRoot, abs, content)
    return {
      content: `[write_file] ${shown}：已写入 ${content.length} 字符（${content.split('\n').length} 行）`,
    }
  },
}

const edit: Tool = {
  name: 'edit_file',
  description:
    '精确替换文件中的文本片段（字符串替换语义）。old_string 必须与文件内容完全一致（含缩进与换行）。' +
    '默认要求唯一匹配；replace_all=true 时替换全部匹配。必须先 read_file 取原文再构造 old_string——凭记忆构造必然失配。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工程根）' },
      old_string: { type: 'string', description: '要被替换的原文（需完全一致）' },
      new_string: { type: 'string', description: '替换后的新文本' },
      replace_all: { type: 'boolean', description: 'true 时替换全部匹配，默认 false（唯一匹配）' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const { abs, shown } = await safePath(projectRoot, text(rec, 'path'))
    const oldString = text(rec, 'old_string')
    const newString = rec.new_string
    if (typeof newString !== 'string') throw new Error('参数 new_string 必须是字符串')
    const replaceAll = optBool(rec, 'replace_all') ?? false

    if (!replaceAll) {
      // 唯一匹配路径走 fsops.editTextFile：内部读全量文件，不受 2MB 展示截断影响
      const r = await editTextFile(projectRoot, abs, oldString, newString)
      return { content: `[edit_file] ${shown}：已替换 1 处，现 ${r.lineCount} 行` }
    }

    // 全量替换：复用 readTextFile + writeTextFile；底层 2MB 截断时禁止（会写坏大文件）
    const file = await readTextFile(projectRoot, abs)
    if (file.truncated) {
      throw new Error('文件超过 2MB，replace_all 不安全：请改用唯一匹配的 old_string 分次替换')
    }
    if (file.isBinary) throw new Error('二进制文件无法编辑')
    const count = file.content.split(oldString).length - 1
    if (count === 0) throw new Error('old_string 在文件中未找到，请确认文本完全一致（含缩进和换行）。')
    const replaced = file.content.split(oldString).join(newString)
    await writeTextFile(projectRoot, abs, replaced)
    return { content: `[edit_file] ${shown}：已替换 ${count} 处，现 ${replaced.split('\n').length} 行` }
  },
}

const list: Tool = {
  name: 'list_dir',
  description:
    '列出某目录的直接子项（文件夹在前），跳过 node_modules/.git/dist 等噪声目录。' +
    'path 省略为工程根。要看深层结构请用 glob。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（相对工程根），省略为工程根' },
    },
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const { abs, shown } = await safePath(projectRoot, optText(rec, 'path') ?? '.')

    const nodes = await listDir(projectRoot, abs)
    if (nodes.length === 0) return { content: `[list_dir] ${shown}：空目录` }
    const entries = nodes.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))
    const shownEntries = entries.slice(0, LIST_MAX_ENTRIES)
    const more = entries.length > LIST_MAX_ENTRIES
      ? `\n…（共 ${entries.length} 项，仅显示前 ${LIST_MAX_ENTRIES} 项）`
      : `\n共 ${entries.length} 项`
    return { content: `[list_dir] ${shown}\n${shownEntries.join('\n')}${more}` }
  },
}

/** glob → RegExp：`**` 跨目录、`*` 不跨 `/`、`?` 单字符；大小写不敏感（与 searchFiles 一致） */
function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') {
          i++
          re += '(?:.*/)?' // `**/` → 零个或多个目录层级
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

const glob: Tool = {
  name: 'glob',
  description:
    '按文件名模式查找工程内文件，返回工程相对路径。支持 ** / * / ?（** 跨目录，* 不跨 /）。' +
    '例：src/**/*.ts、**/*config*。node_modules/.git 等噪声目录不进入搜索。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 src/**/*.ts' },
      path: { type: 'string', description: '限定搜索子目录（相对工程根），省略为全工程' },
    },
    required: ['pattern'],
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const pattern = text(rec, 'pattern')
    const base = optText(rec, 'path') ?? '.'
    const { abs: baseAbs, shown: baseShown } = await safePath(projectRoot, base)

    const re = globToRegExp(pattern)
    const hits: string[] = []
    let visited = 0

    // 遍历复用 fsops.listDir（自带 IGNORED 过滤 + 每层 ensureInside），本层只做模式匹配与预算控制
    const walk = async (dirAbs: string, depth: number): Promise<void> => {
      if (hits.length >= GLOB_MAX_RESULTS || visited >= GLOB_MAX_VISITED || depth > 32) return
      const nodes = await listDir(projectRoot, dirAbs)
      for (const n of nodes) {
        if (hits.length >= GLOB_MAX_RESULTS || visited >= GLOB_MAX_VISITED) return
        visited++
        if (n.kind === 'folder') {
          await walk(n.path, depth + 1)
          continue
        }
        const rel = path.relative(projectRoot, n.path).replace(/\\/g, '/')
        if (re.test(rel)) hits.push(rel)
      }
    }
    await walk(baseAbs, 0)
    hits.sort()

    const truncated = hits.length >= GLOB_MAX_RESULTS || visited >= GLOB_MAX_VISITED
    const head = `[glob] ${pattern}${base !== '.' ? ` @ ${baseShown}` : ''} · 命中 ${hits.length} 个`
    if (hits.length === 0) return { content: `${head}（无匹配）` }
    return {
      content: `${head}${truncated ? '（结果已截断）' : ''}\n${hits.join('\n')}`,
    }
  },
}

const grep: Tool = {
  name: 'grep',
  description:
    '按正则搜索工程内文本文件内容，返回 path:line: 命中行。非法正则自动回退为字面量匹配。' +
    '跳过 node_modules/.git 等噪声目录与二进制/超大文件（>512KB）。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（或纯文本）' },
      path: { type: 'string', description: '限定搜索子目录（相对工程根）' },
      glob: { type: 'string', description: '文件名后缀过滤，如 .ts 或 *.ts' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
      maxResults: { type: 'integer', description: '最多返回条数，默认 120，上限 500', minimum: 1, maximum: 500 },
    },
    required: ['pattern'],
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const pattern = text(rec, 'pattern')
    const subRel = optText(rec, 'path')
    const globFilter = optText(rec, 'glob')
    const caseSensitive = optBool(rec, 'caseSensitive') ?? false
    const maxResults = optInt(rec, 'maxResults', 1, 500) ?? GREP_MAX_RESULTS

    // 子目录限定：grepFiles 只从工程根遍历，这里按前缀后置过滤
    let prefix = ''
    if (subRel) {
      const { abs } = await safePath(projectRoot, subRel)
      prefix = path.relative(projectRoot, abs).replace(/\\/g, '/').toLowerCase()
      if (prefix && !prefix.endsWith('/')) prefix += '/'
    }

    const r = await grepFiles(projectRoot, pattern, {
      glob: globFilter,
      caseSensitive,
      maxResults,
    })
    const matches = prefix
      ? r.matches.filter((m) => m.path.replace(/\\/g, '/').toLowerCase().startsWith(prefix))
      : r.matches

    const head = `[grep] ${pattern} · 命中 ${matches.length} 行 / ${r.fileCount} 文件`
    if (matches.length === 0) return { content: `${head}（无匹配）` }
    const lines = matches.map((m) => `${m.path.replace(/\\/g, '/')}:${m.line}: ${m.text}`)
    return {
      content: `${head}${r.truncated ? '（结果已截断）' : ''}\n${lines.join('\n')}`,
    }
  },
}

const search: Tool = {
  name: 'search_files',
  description:
    '在项目内递归按文件名搜索（大小写不敏感子串匹配，node_modules 等目录自动跳过），返回相对路径列表。' +
    '找文件名用这个；按内容找用 grep；按通配模式找用 glob。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '文件名关键字，如 "config" 或 "useBuildStore.ts"' },
    },
    required: ['query'],
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const query = text(rec, 'query')
    const r = await searchFiles(projectRoot, query)
    if (r.files.length === 0) {
      return {
        content: `[search_files] 项目中没有文件名包含「${query}」的文件（node_modules 等目录已跳过）。`,
      }
    }
    const body = r.files.map((f) => f.replace(/\\/g, '/')).join('\n')
    return {
      content:
        `[search_files] 文件名包含「${query}」共 ${r.files.length} 项${r.truncated ? '（已达上限截断）' : ''}：\n${body}` +
        (r.truncated ? '\n…（请用更具体的关键字缩小范围）' : ''),
    }
  },
}

/** 文件工具集（注册顺序即 allTools 里的顺序）。
 *  search_files 是产品工具名（渲染层提示词的「按文件名搜索」）——按 Type 1 收编一次，
 *  不另造 list_files（list_dir 已等价覆盖，见 tools/index 的旧名映射）。 */
export const fsTools: Tool[] = [read, write, edit, list, glob, grep, search]
