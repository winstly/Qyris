/**
 * 项目创建与 Git 操作：空项目 / 从远端仓库克隆（支持指定分支）/ 仓库连通性测试 / 分支列举与切换。
 * git 一律 spawn 直连可执行文件（不走 shell），入参做 `-` 前缀守卫防 CLI 选项注入。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
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

/** 克隆进度钩子：index/total 为仓库序，name 为仓库名，stage 为阶段文案，pct 为百分比（无法解析时 null） */
export interface CloneHooks {
  onProgress?: (info: { index: number; total: number; name: string; stage: string; pct: number | null }) => void
}

/** 在 parentDir 下克隆多个仓库（逐个串行执行），每个仓库克隆为以仓库名命名的子目录，返回所有克隆路径 */
export async function cloneRepos(parentDir: string, repos: CloneRepo[], hooks?: CloneHooks): Promise<string[]> {
  if (!repos.length) throw new Error('至少提供一个仓库地址')
  cloneCancelRequested = false
  const results: string[] = []
  let index = 0
  for (const repo of repos) {
    // 每个仓库开跑前查取消：取消发生在两仓库间隙时不必再白克隆一整个仓库
    if (cloneCancelRequested) throw new Error('克隆已取消')
    const trimmed = repo.url.trim()
    if (!trimmed) continue
    const branch = repo.branch?.trim() || undefined
    if (branch) assertSafeGitRef(branch, '分支名')
    const repoName = guessRepoName(trimmed)
    const target = path.join(parentDir, repoName)
    hooks?.onProgress?.({ index, total: repos.length, name: repoName, stage: '开始克隆', pct: null })
    await gitClone(trimmed, target, branch, {
      onProgress: (p) => hooks?.onProgress?.({ index, total: repos.length, name: repoName, ...p }),
    })
    index++
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

// ---------- 克隆专用：流式进度 + 无输出看门狗 + 可取消 ----------

/** 进行中的 git clone 子进程（取消时统一树杀） */
const activeClones = new Set<ChildProcess>()
let cloneCancelRequested = false

/** 取消进行中的克隆（杀 git 子进程）；进行中的 cloneRepos 会以「已取消」收场，下一次调用重置标志 */
export function cancelClones(): void {
  cloneCancelRequested = true
  for (const p of activeClones) {
    try { p.kill() } catch { /* 进程已不在 */ }
  }
  activeClones.clear()
}

/**
 * 流式 git 执行：行级回调 + 「无输出看门狗」+ 进程登记。
 * 与 runGit 的本质区别：不用总超时硬杀（大仓库 clone 跑几分钟是正常值，总超时=必然误杀），
 * 改为「超过 noDataTimeoutMs 没有任何输出才判死」——git --progress 持续输出，
 * 有输出即活着；只有网络停滞 / 凭据弹窗无人应答这类真死才会触发看门狗。
 */
function runGitStream(
  args: string[],
  opts: {
    noDataTimeoutMs?: number
    onLine?: (line: string) => void
    onSpawn?: (p: ChildProcess) => void
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const noDataTimeoutMs = opts.noDataTimeoutMs ?? 90_000
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    opts.onSpawn?.(proc)
    let stdout = ''
    let stderr = ''
    let tail = ''
    let watchdog: NodeJS.Timeout | null = setTimeout(onNoDataTimeout, noDataTimeoutMs)
    /** 看门狗到点（期间无任何输出）：判死并杀掉 git 进程 */
    function onNoDataTimeout(): void {
      if (watchdog !== null) clearTimeout(watchdog)
      proc.kill()
      reject(new Error('git 长时间无输出，已中止（网络停滞或在等待凭据确认）'))
    }
    const feed = (): void => {
      if (watchdog !== null) {
        clearTimeout(watchdog)
        watchdog = setTimeout(onNoDataTimeout, noDataTimeoutMs)
      }
    }
    // git 进度行以 \r 结尾刷新同一行——按 \r\n/\n/\r 全拆
    const pumpLines = (chunk: string): void => {
      tail += chunk
      const parts = tail.split(/\r\n|\n|\r/)
      tail = parts.pop() ?? ''
      for (const line of parts) {
        if (line.trim()) opts.onLine?.(line.trim())
      }
    }
    proc.stdout?.on('data', (d: Buffer) => { feed(); const s = d.toString(); stdout += s; pumpLines(s) })
    proc.stderr?.on('data', (d: Buffer) => { feed(); const s = d.toString(); stderr += s; pumpLines(s) })
    proc.on('close', (code) => {
      if (watchdog !== null) clearTimeout(watchdog)
      if (tail.trim()) opts.onLine?.(tail.trim())
      resolve({ code, stdout, stderr })
    })
    proc.on('error', (e) => {
      if (watchdog !== null) clearTimeout(watchdog)
      reject(new Error(`git 启动失败：${errorMessage(e)}`))
    })
  })
}

/** clone --progress 的 stderr 行 → 阶段+百分比（无法解析的行返回 null） */
function parseCloneStage(line: string): { stage: string; pct: number | null } | null {
  let m = /Receiving objects:\s+(\d+)%/.exec(line)
  if (m) return { stage: '接收对象', pct: Number(m[1]) }
  m = /Resolving deltas:\s+(\d+)%/.exec(line)
  if (m) return { stage: '解析增量', pct: Number(m[1]) }
  m = /Updating files:\s+(\d+)%/.exec(line)
  if (m) return { stage: '检出文件', pct: Number(m[1]) }
  m = /Compressing objects:\s+(\d+)%/.exec(line)
  if (m) return { stage: '压缩对象', pct: Number(m[1]) }
  if (/Enumerating objects|Counting objects/.test(line)) return { stage: '枚举对象', pct: null }
  return null
}

/** git clone：--progress 流式进度 + 无输出看门狗（90s 无任何输出才判死）；
 *  大仓库跑几分钟是正常值，不再用总超时硬杀 */
async function gitClone(
  url: string, target: string, branch: string | undefined,
  hooks?: { onProgress?: (info: { stage: string; pct: number | null }) => void },
): Promise<void> {
  assertSafeGitRef(url, '仓库地址')
  const args = ['clone', '--progress', ...(branch ? ['--branch', branch] : []), url, target]
  let procRef: ChildProcess | null = null
  const r = await runGitStream(args, {
    noDataTimeoutMs: 90_000,
    onSpawn: (p) => {
      procRef = p
      activeClones.add(p)
    },
    onLine: (line) => {
      const stage = parseCloneStage(line)
      if (stage) hooks?.onProgress?.(stage)
    },
  }).finally(() => {
    if (procRef) activeClones.delete(procRef)
  })
  if (cloneCancelRequested) throw new Error('克隆已取消')
  if (r.code !== 0) {
    throw new Error(`git clone 失败（exit ${r.code}）：${(r.stderr || r.stdout).slice(0, 500)}`)
  }
}

/** 允许失败的 git 调用（探测类）：git 不可用等 spawn 异常返回 null，非零退出正常返回 */
async function runGitAllowFail(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  try {
    return await runGit(args, 15_000)
  } catch {
    return null
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
