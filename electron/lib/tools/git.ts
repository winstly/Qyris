/**
 * Git 工具：git_status / git_diff / git_add / git_commit。
 * 复用 electron/lib/git.ts（spawn 直连、超时、CLI 选项注入守卫都在那边），
 * 本层只做：工程根校验、路径越界防护（pathsafety.ensureInside）、结果格式化。
 */
import { ensureInside } from '../pathsafety'
import { gitAdd, gitCommit, gitDiff, gitStatus, type GitStatus } from '../git'
import type { Tool, ToolCtx } from '../model/types'

// ---------- 入参校验 ----------

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

function optText(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  return text(rec, key)
}

function optBool(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值`)
  return v
}

function root(ctx: ToolCtx): string {
  if (!ctx.projectRoot) throw new Error('当前未打开工程，git 工具不可用')
  return ctx.projectRoot
}

/** 路径越界防护：git 收到的路径一律先过 ensureInside（不存在的路径走词法归一化） */
async function safePath(projectRoot: string, rel: string): Promise<string> {
  return ensureInside(projectRoot, rel)
}

// ---------- 格式化 ----------

const STATUS_TAG: Record<GitStatus['files'][number]['status'], string> = {
  staged: '已暂存',
  modified: '已修改',
  added: '新增',
  deleted: '已删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突',
}

const STATUS_MAX_ENTRIES = 200

function formatStatus(s: GitStatus): string {
  if (!s.isRepo) return '该目录不是 Git 仓库'
  const branch = s.branch ?? '(detached HEAD)'
  const track = s.ahead || s.behind ? `（ahead ${s.ahead} / behind ${s.behind}）` : ''
  if (s.files.length === 0) return `分支：${branch}${track}\n工作区干净，无改动`

  const lines = [`分支：${branch}${track}`]
  for (const f of s.files.slice(0, STATUS_MAX_ENTRIES)) {
    const rename = f.renamedFrom ? ` ← ${f.renamedFrom}` : ''
    lines.push(`${f.x}${f.y} ${f.path}${rename} [${STATUS_TAG[f.status] ?? f.status}]`)
  }
  if (s.files.length > STATUS_MAX_ENTRIES) {
    lines.push(`…（共 ${s.files.length} 个改动文件，仅显示前 ${STATUS_MAX_ENTRIES} 个）`)
  } else {
    lines.push(`共 ${s.files.length} 个改动文件`)
  }
  return lines.join('\n')
}

// ---------- 工具实现 ----------

const status: Tool = {
  name: 'git_status',
  description: '查看 Git 仓库状态：当前分支、领先/落后、改动文件列表（含暂存/未暂存/未跟踪/冲突标记）。',
  inputSchema: { type: 'object', properties: {} },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    asRecord(input) // 无参数，但入参仍须是对象
    const s = await gitStatus(projectRoot)
    return { content: formatStatus(s) }
  },
}

const diff: Tool = {
  name: 'git_diff',
  description:
    '查看 Git diff（无颜色）。staged=true 看暂存区改动（--cached），否则看工作区。' +
    'path 省略看全部改动；diff 过长会截断。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '限定单个文件（相对工程根）' },
      staged: { type: 'boolean', description: 'true 看暂存区（--cached），默认 false' },
    },
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const rel = optText(rec, 'path')
    const staged = optBool(rec, 'staged') ?? false
    const target = rel ? await safePath(projectRoot, rel) : undefined

    const out = await gitDiff(projectRoot, target, staged)
    const head = `[git_diff] ${staged ? '暂存区' : '工作区'}${rel ? ` · ${rel}` : ''}`
    if (!out.trim()) return { content: `${head}\n（无改动）` }
    return { content: `${head}\n${out}` }
  },
}

const add: Tool = {
  name: 'git_add',
  description:
    '暂存改动到 Git 索引。paths 省略或为空 = 暂存全部改动（-A）。' +
    '只做暂存，不会提交——提交请用 git_commit。',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '要暂存的文件/目录路径列表（相对工程根），省略为全部改动',
      },
    },
  },
  permission: 'write',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const raw = rec.paths

    if (raw === undefined || raw === null) {
      await gitAdd(projectRoot)
      return { content: '[git_add] 已暂存全部改动（-A）' }
    }
    if (!Array.isArray(raw)) throw new Error('参数 paths 必须是字符串数组')
    const list: string[] = []
    for (const p of raw) {
      if (typeof p !== 'string' || !p.trim()) throw new Error('paths 数组元素必须是非空字符串')
      list.push(await safePath(projectRoot, p))
    }
    await gitAdd(projectRoot, list)
    return { content: `[git_add] 已暂存 ${list.length} 项：\n${list.join('\n')}` }
  },
}

const commit: Tool = {
  name: 'git_commit',
  description: '提交已暂存的改动（git commit -m）。message 必填；没有暂存内容时 git 会报错。',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '提交信息' },
    },
    required: ['message'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const message = text(rec, 'message')
    const out = await gitCommit(projectRoot, message)
    return { content: `[git_commit] ${out || '提交完成'}` }
  },
}

/** Git 工具集 */
export const gitTools: Tool[] = [status, diff, add, commit]
