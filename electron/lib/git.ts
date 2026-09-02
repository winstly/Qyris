/**
 * Git 工作区操作：status / diff / add / commit / pull / fetch / push / discard。
 * 与 project-create.ts（仓库发现 / 克隆 / 分支切换）互补；
 * git 一律 spawn 直连可执行文件（不走 shell），引用/路径入参做 `-` 前缀守卫防 CLI 选项注入。
 */
import { spawn } from 'node:child_process'
import { errorMessage } from './util'
import { buildChildEnv } from './proc'

/** 单个改动文件条目（git status --porcelain v1 解析） */
export interface GitFileEntry {
  /** 相对仓库路径（rename 显示新路径） */
  path: string
  /** 原路径（仅 rename 有） */
  renamedFrom?: string
  /** X（暂存区状态）：空格=未暂存，M/A/D/R/C 等 */
  x: string
  /** Y（工作区状态） */
  y: string
  /** 已有暂存改动 */
  staged: boolean
  /** 工作区有未暂存改动（含 untracked） */
  unstaged: boolean
  /** 展示用状态标签 */
  status: 'staged' | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  /** 相对上游：领先 / 落后（无跟踪分支时为 0） */
  ahead: number
  behind: number
  files: GitFileEntry[]
}

const MAX_DIFF_CHARS = 200_000
const MAX_STATUS_ENTRIES = 2000

/** 执行 git 命令（不走 shell，windowsHide 防控制台闪烁），超时强杀；spawn 异常抛错 */
function runGit(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
      env: buildChildEnv(),
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.on('error', (e) => reject(new Error(`git 启动失败：${errorMessage(e)}`)))
  })
}

/** git 报错 → 用户可读文案（网络 / 认证 / 冲突是最常见的三类） */
function translateGitError(detail: string): string | null {
  if (/Could not resolve host|Connection timed out|Failed to connect|Network is unreachable/i.test(detail)) {
    return '网络不可达：无法连接远端仓库'
  }
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|403/i.test(detail)) {
    return '认证失败：本机尚未配置该仓库的访问凭据'
  }
  if (/Your local changes.*would be overwritten|Please commit your changes/i.test(detail)) {
    return '本地有未提交的改动与远端冲突：请先提交或丢弃本地改动'
  }
  if (/Merge conflict|CONFLICT/i.test(detail)) {
    return '合并冲突：请解决冲突文件后提交'
  }
  if (/not a git repository/i.test(detail)) {
    return '该目录不是 Git 仓库'
  }
  return null
}

/** 非 0 退出统一抛错：附转译文案与 stderr 摘要 */
async function runGitOrThrow(args: string[], timeoutMs: number, label: string): Promise<string> {
  const r = await runGit(args, timeoutMs)
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim()
    const translated = translateGitError(detail)
    throw new Error(
      `${label}失败（exit ${r.code ?? '?'}）：${translated ?? (detail ? detail.slice(0, 400) : '未知错误')}`,
    )
  }
  return r.stdout
}

/** 目录是否在 Git 工作树内（允许失败：git 不可用按非仓库处理） */
async function isInsideWorkTree(dir: string): Promise<boolean> {
  try {
    const r = await runGit(['-C', dir, 'rev-parse', '--is-inside-work-tree'], 10_000)
    return r.code === 0 && r.stdout.trim() === 'true'
  } catch {
    return false
  }
}

/** 路径相等（规范化分隔符/尾分隔符；win/mac 大小写不敏感） */
function samePath(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/[\\/]+$/, '').replace(/\//g, '\\')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b)
}

/** 目录是否是某个 Git 仓库的【根】（toplevel 与目录一致），而非仅位于某仓库内部。
 *  与 isInsideWorkTree 的区别：后者向上走查——项目根本身是仓库时，其下所有子目录都会误判。 */
export async function gitIsRepoRoot(dir: string): Promise<boolean> {
  try {
    const r = await runGit(['-C', dir, 'rev-parse', '--show-toplevel'], 10_000)
    if (r.code !== 0 || !r.stdout.trim()) return false
    return samePath(r.stdout.trim(), dir)
  } catch {
    return false
  }
}

/** 仓库状态：分支 / 领先落后 / 改动文件列表（-z 解析，正确处理含空格与中文文件名、rename 双路径） */
export async function gitStatus(dir: string): Promise<GitStatus> {
  if (!(await isInsideWorkTree(dir))) {
    return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] }
  }
  const head = await runGit(['-C', dir, 'branch', '--show-current'], 10_000)
  const branch = head.code === 0 ? (head.stdout.trim() || null) : null
  const r = await runGit(['-C', dir, 'status', '--porcelain=v1', '-b', '-z'], 15_000)
  if (r.code !== 0) {
    throw new Error(`git status 失败：${(r.stderr || r.stdout).slice(0, 300)}`)
  }
  const parts = r.stdout.split('\0')
  let ahead = 0
  let behind = 0
  // 首段为 '## ' 分支行：## main...origin/main [ahead 1, behind 2]
  const header = parts[0] ?? ''
  const ab = header.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/)
  if (ab) {
    ahead = Number(ab[1] ?? 0)
    behind = Number(ab[2] ?? 0)
  }
  const files: GitFileEntry[] = []
  for (let i = 1; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec || rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    // porcelain 格式：XY + 空格 + 路径 → 从下标 3 切路径（slice(2) 会把分隔空格带进去）
    const path = rec.slice(3)
    // rename/copy：-z 下字段序反转——当前段是新路径，紧随的独立段是原路径
    const isRenamed = x === 'R' || x === 'C'
    const renamedFrom = isRenamed && i + 1 < parts.length ? parts[i + 1] : undefined
    if (isRenamed) i++
    const staged = x !== ' ' && x !== '?'
    const unstaged = y !== ' ' || x === '?'
    let status: GitFileEntry['status']
    if (x === '?' || y === '?') status = 'untracked'
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'conflicted'
    else if (isRenamed) status = 'renamed'
    else if (x === 'A') status = 'added'
    else if (x === 'D' || y === 'D') status = 'deleted'
    else status = 'modified'
    files.push({
      path,
      ...(renamedFrom ? { renamedFrom } : {}),
      x,
      y,
      staged,
      unstaged,
      status,
    })
    if (files.length >= MAX_STATUS_ENTRIES) break
  }
  return { isRepo: true, branch, ahead, behind, files }
}

/** 查看改动 diff：staged=true 看暂存区（--cached），path 省略看全部；超长截断 */
export async function gitDiff(dir: string, path?: string, staged?: boolean): Promise<string> {
  const args = ['-C', dir, 'diff', '--no-color', '--no-ext-diff']
  if (staged) args.push('--cached')
  args.push('--')
  if (path) args.push(path)
  const r = await runGit(args, 15_000)
  if (r.code !== 0) {
    throw new Error(`git diff 失败：${(r.stderr || r.stdout).slice(0, 300)}`)
  }
  const out = r.stdout
  return out.length > MAX_DIFF_CHARS ? out.slice(0, MAX_DIFF_CHARS) + '\n…（diff 过长，已截断）' : out
}

/** git add：paths 省略/为空 = 全部改动（-A） */
export async function gitAdd(dir: string, paths?: string[]): Promise<void> {
  const list = (paths ?? []).filter((p) => p && !p.startsWith('-'))
  const args = ['-C', dir, 'add', ...(list.length ? list : ['-A'])]
  await runGitOrThrow(args, 30_000, '暂存')
}

/** 取消暂存（git restore --staged）：只清暂存区，工作区内容不动 */
export async function gitUnstage(dir: string, paths: string[]): Promise<void> {
  const list = paths.filter((p) => p && !p.startsWith('-'))
  if (list.length === 0) throw new Error('未指定要取消暂存的文件')
  await runGitOrThrow(['-C', dir, 'restore', '--staged', '--', ...list], 30_000, '取消暂存')
}

/** git commit：消息必填（spawn 直连不经过 shell，消息原样作为单参数传递，无注入面） */
export async function gitCommit(dir: string, message: string): Promise<string> {
  const msg = message.trim()
  if (!msg) throw new Error('提交信息不能为空')
  const out = await runGitOrThrow(['-C', dir, 'commit', '-m', msg], 60_000, '提交')
  return out.trim()
}

/** git pull --no-edit：非交互合并，冲突/网络错误抛可读文案（120s：含可能的拉取体积） */
export async function gitPull(dir: string): Promise<string> {
  const out = await runGitOrThrow(['-C', dir, 'pull', '--no-edit'], 120_000, '拉取')
  return out.trim()
}

/** git fetch --prune（60s） */
export async function gitFetch(dir: string): Promise<string> {
  const out = await runGitOrThrow(['-C', dir, 'fetch', '--prune'], 60_000, '获取')
  return out.trim()
}

/** git push：无上游时自动补 -u origin HEAD 建立跟踪（一次性，后续 push 走默认） */
export async function gitPush(dir: string): Promise<string> {
  try {
    return (await runGitOrThrow(['-C', dir, 'push'], 60_000, '推送')).trim()
  } catch (e) {
    if (/no upstream|has no upstream|set-upstream|当前分支没有上游/i.test(String(e))) {
      return (await runGitOrThrow(['-C', dir, 'push', '-u', 'origin', 'HEAD'], 60_000, '推送')).trim()
    }
    throw e
  }
}

/** 丢弃指定文件的全部改动（暂存区 + 工作区都还原到 HEAD）：git restore --staged --worktree。
 *  只对已跟踪文件有效；untracked 文件不属于「丢弃改动」范畴（删除走文件树的删除） */
export async function gitDiscard(dir: string, paths: string[]): Promise<void> {
  const list = paths.filter((p) => p && !p.startsWith('-'))
  if (list.length === 0) throw new Error('未指定要丢弃改动的文件')
  await runGitOrThrow(['-C', dir, 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...list], 30_000, '丢弃改动')
}
