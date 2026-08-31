/**
 * 项目创建与 Git 操作：空项目 / 从远端仓库克隆（支持指定分支）/ 仓库连通性测试 / 分支列举与切换。
 * git 一律 spawn 直连可执行文件（不走 shell），入参做 `-` 前缀守卫防 CLI 选项注入。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { errorMessage } from './util'

/** 在 parentDir 下创建一个空的项目目录并返回其绝对路径 */
export async function createEmptyProject(parentDir: string, name: string): Promise<string> {
  if (!name.trim()) throw new Error('项目名不能为空')
  const target = path.join(parentDir, name.trim())
  try {
    await fsp.access(target)
    throw new Error(`目录已存在：${name}`)
  } catch (e: unknown) {
    // ENOENT = 不存在，可以创建；其他错误抛出
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await fsp.mkdir(target, { recursive: true })
  return target
}

/** 单个待克隆仓库：url 必填，branch 可选（不传则用远端默认分支） */
export interface CloneRepo {
  url: string
  branch?: string
}

/** 在 parentDir 下克隆多个仓库（逐个串行执行），每个仓库克隆为以仓库名命名的子目录，返回所有克隆路径 */
export async function cloneRepos(parentDir: string, repos: CloneRepo[]): Promise<string[]> {
  if (!repos.length) throw new Error('至少提供一个仓库地址')
  const results: string[] = []
  for (const repo of repos) {
    const trimmed = repo.url.trim()
    if (!trimmed) continue
    const branch = repo.branch?.trim() || undefined
    if (branch) assertSafeGitRef(branch, '分支名')
    const repoName = guessRepoName(trimmed)
    const target = path.join(parentDir, repoName)
    await gitClone(trimmed, target, branch)
    results.push(target)
  }
  return results
}

/** 测试远端仓库连通性：成功返回分支列表（默认分支优先），失败返回 error 文案 */
export async function testRepo(url: string): Promise<{ valid: boolean; branches: string[]; error: string | null }> {
  try {
    const branches = await gitLsRemoteHeads(url)
    return { valid: true, branches, error: null }
  } catch (e) {
    return { valid: false, branches: [], error: errorMessage(e) }
  }
}

export interface GitRepoInfo {
  isRepo: boolean
  currentBranch: string | null
  branches: string[]
}

/** 目录的 Git 仓库信息：是否仓库 / 当前分支 / 可切换分支列表（本地分支 ∪ 远端分支，非仓库时后两项为空） */
export async function gitRepoInfo(dir: string): Promise<GitRepoInfo> {
  const inside = await runGitAllowFail(['-C', dir, 'rev-parse', '--is-inside-work-tree'])
  if (!inside || inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepo: false, currentBranch: null, branches: [] }
  }
  const [cur, local, remote] = await Promise.all([
    runGitAllowFail(['-C', dir, 'branch', '--show-current']),
    runGitAllowFail(['-C', dir, 'branch', '--format=%(refname:short)']),
    runGitAllowFail(['-C', dir, 'branch', '-r', '--format=%(refname:short)']),
  ])
  const currentBranch = cur && cur.code === 0 ? (cur.stdout.trim() || null) : null
  const branchSet = new Set(
    local && local.code === 0
      ? local.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      : [],
  )
  // 远端分支：origin/feature-x → feature-x。本地同名优先；origin/HEAD 这类指向忽略。
  // 选中仅远端存在的分支时，git checkout <name> 的 DWIM 语义会自动创建跟踪分支
  if (remote && remote.code === 0) {
    for (const line of remote.stdout.split('\n')) {
      const short = line.trim()
      const slash = short.indexOf('/')
      if (slash <= 0) continue
      const name = short.slice(slash + 1)
      if (!name || name === 'HEAD') continue
      branchSet.add(name)
    }
  }
  return { isRepo: true, currentBranch, branches: [...branchSet].sort(defaultBranchFirst) }
}

/** 切换本地分支；失败（脏工作区冲突、分支不存在等）抛出带 stderr 摘要的错误 */
export async function gitCheckout(dir: string, branch: string): Promise<void> {
  assertSafeGitRef(branch, '分支名')
  const r = await runGit(['-C', dir, 'checkout', branch], 30_000)
  if (r.code !== 0) {
    throw new Error(`切换分支失败（exit ${r.code}）：${(r.stderr || r.stdout).slice(0, 500)}`)
  }
}

// ---------- 内部工具 ----------

/** 从 git URL 猜测仓库名（去掉 .git 后缀，取最后一段） */
function guessRepoName(url: string): string {
  const last = url.split('/').pop() ?? url
  return last.replace(/\.git$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo'
}

/** git CLI 参数注入守卫：分支/引用若以 - 开头会被当成选项，直接拒绝 */
function assertSafeGitRef(ref: string, label: string): void {
  if (ref.startsWith('-')) throw new Error(`${label}不合法：${ref}`)
}

/** 排序：main/master 优先，其余字母序 */
function defaultBranchFirst(a: string, b: string): number {
  const w = (s: string): number => (s === 'main' || s === 'master' ? 0 : 1)
  return w(a) - w(b) || a.localeCompare(b)
}

/** 执行 git 命令（不走过期 shell），超时强杀；exit≠0 抛错并附 stderr 摘要 */
function runGit(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
    proc.on('error', (e) => reject(new Error(`git 启动失败：${errorMessage(e)}`)))
  })
}

/** 允许失败的 git 调用（探测类）：git 不可用等 spawn 异常返回 null，非零退出正常返回 */
async function runGitAllowFail(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  try {
    return await runGit(args, 15_000)
  } catch {
    return null
  }
}

/** git clone，超时 120s；指定 branch 时追加 --branch */
async function gitClone(url: string, target: string, branch?: string): Promise<void> {
  assertSafeGitRef(url, '仓库地址')
  const args = ['clone', ...(branch ? ['--branch', branch] : []), url, target]
  const r = await runGit(args, 120_000)
  if (r.code !== 0) {
    throw new Error(`git clone 失败（exit ${r.code}）：${(r.stderr || r.stdout).slice(0, 500)}`)
  }
}

/** 列举远端仓库的所有 heads 分支（15s 超时）；失败抛错（含 stderr 摘要，供「测试连接」展示） */
async function gitLsRemoteHeads(url: string): Promise<string[]> {
  assertSafeGitRef(url, '仓库地址')
  const r = await runGit(['ls-remote', '--heads', url], 15_000)
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim()
    // 常见错误的直白转译
    if (/Repository not found|not found/i.test(detail)) throw new Error('仓库不存在或无访问权限')
    if (/Authentication failed|could not read Username/i.test(detail)) throw new Error('认证失败：私有仓库需要本机已配置凭据')
    if (/Could not resolve host|Connection timed out|Failed to connect/i.test(detail)) throw new Error('网络不可达：无法连接到远端主机')
    throw new Error(detail ? detail.slice(0, 300) : `git ls-remote 失败（exit ${r.code}）`)
  }
  const branches = r.stdout
    .split('\n')
    .map((line) => {
      const tab = line.indexOf('\t')
      if (tab < 0) return ''
      const ref = line.slice(tab + 1).trim()
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ''
    })
    .filter(Boolean)
  if (branches.length === 0) throw new Error('仓库可达，但没有任何分支（空仓库？）')
  return branches.sort(defaultBranchFirst)
}
