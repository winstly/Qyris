/** 子进程管理 —— 多槽版本：每个命名服务一个槽，互不干扰；同名槽重启 = 先杀旧再启 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promises as fsp, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { app, net } from 'electron'
import { emitToRenderer } from './emitter'
import { errorMessage } from './util'

interface ProcSlot {
  name: string
  proc: ChildProcess
}

/** 服务名 → 槽。名字统一 trim + 小写归一，避免 'Web' 与 'web' 出现两个槽 */
const slots = new Map<string, ProcSlot>()

function normName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : ''
  return n || 'default'
}

/** 去掉 ANSI 颜色/控制序列：vite/npm 等即便在管道下也可能强制带色，会污染 URL 解析与日志 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
}

/** Windows spawn taskkill 同步等结果，结果忽略 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* 进程已不在 */
    }
  } else {
    try {
      // unix 侧 spawn 时 detached:true → 子进程为进程组长，负 PID 杀整组
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* 进程已不在 */
    }
  }
}

/** 杀指定槽（存在才杀）；不杀其他槽 */
function takeAndKillOne(key: string): void {
  const slot = slots.get(key)
  if (!slot) return
  slots.delete(key)
  if (slot.proc.pid) killTree(slot.proc.pid)
}

// ---------- 子进程环境构建：修复打包后 PATH 丢失 ----------
// 打包后从 Finder/Explorer 启动时，process.env.PATH 是 GUI 会话的极简快照：
// macOS 只有 /usr/bin:/bin:/usr/sbin:/sbin，Windows 是登录时的注册表快照——
// 用户 shell profile 里的增量（.zprofile 的 homebrew/nvm、注册表用户 PATH 等）全部丢失。
// Windows：从注册表 HKCU + HKLM 重读 PATH 合并（短 TTL，装新工具无需重启应用）；
// unix：登录 shell 探测 profile PATH（结果永久缓存，失败短间隔重试）。

const ENV_CACHE_TTL = 10_000
const UNIX_PROBE_RETRY_MS = 60_000
let envCache: NodeJS.ProcessEnv | null = null
let envCacheAt = 0
/** undefined=未探测过；null=探测失败（60s 后允许重试）；string=探测到的 PATH（永久缓存） */
let unixProbeResult: string | null | undefined
let unixProbeFailedAt = 0

/** 展开注册表 REG_EXPAND_SZ 值里的 %VAR%（reg query 输出的是未展开原文） */
function expandEnvVars(s: string): string {
  return s.replace(/%([^%]+)%/g, (raw, name: string) => process.env[name] ?? raw)
}

function mergePaths(lists: string[][]): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const raw of list) {
      const p = raw.trim()
      if (!p) continue
      const key = process.platform === 'win32' ? p.toLowerCase() : p
      if (seen.has(key)) continue
      seen.add(key)
      out.push(p)
    }
  }
  return out.join(sep)
}

/** 读注册表某键的 Path 值，拆分为目录数组；失败返回空（reg.exe 在 System32，任何进程都能找到） */
function readRegistryPath(hive: string, key: string): string[] {
  const res = spawnSync('reg.exe', ['query', `${hive}\\${key}`, '/v', 'Path'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000,
  })
  if (res.status !== 0 || !res.stdout) return []
  const m = res.stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)
  if (!m) return []
  return m[1].trim().split(';')
}

/** 从探测输出提取 PATH：profile 里的 echo/工具打印会污染 stdout，用标记定位；
 *  PATH 不含换行，取标记后到行尾（导出仅为 smoke 测试） */
export function parseProbedPath(raw: string | undefined): string | null {
  if (!raw) return null
  const MARK = '__QYRIS_PATH__'
  const i = raw.indexOf(MARK)
  if (i === -1) return null
  const rest = raw.slice(i + MARK.length)
  const lineEnd = rest.indexOf('\n')
  const p = (lineEnd === -1 ? rest : rest.slice(0, lineEnd)).trim()
  return p || null
}

/** unix：登录 shell 探测 profile PATH（macOS Finder 启动的 GUI 进程 PATH 极简）。
 *  两档尝试：①登录+交互——覆盖 .zprofile 与 .zshrc（nvm 等惯常配在 .zshrc）；
 *  ②仅登录——确定性更强，覆盖 .zprofile/.bash_profile。任一成功即永久缓存 */
function probeUnixPath(): string | null {
  if (unixProbeResult !== undefined) {
    if (unixProbeResult !== null) return unixProbeResult
    if (Date.now() - unixProbeFailedAt < UNIX_PROBE_RETRY_MS) return null
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const PRINT = 'printf "__QYRIS_PATH__%s" "$PATH"'
  const attempts: string[][] = [
    ['-l', '-i', '-c', PRINT],
    ['-l', '-c', PRINT],
  ]
  for (const args of attempts) {
    try {
      const res = spawnSync(shell, args, { encoding: 'utf8', timeout: 3000 })
      const p = res.status === 0 ? parseProbedPath(res.stdout) : null
      if (p) {
        unixProbeResult = p
        return p
      }
    } catch {
      /* 尝试下一档 */
    }
  }
  unixProbeResult = null
  unixProbeFailedAt = Date.now()
  return null
}

/** 构建子进程环境：在 Electron 主进程环境之上重建 PATH */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  try {
    if (process.platform === 'win32') {
      const now = Date.now()
      if (envCache && now - envCacheAt < ENV_CACHE_TTL) return envCache
      // 顺序：系统 PATH 在前、用户 PATH 在后（与 Windows 正常解析顺序一致），进程现有 PATH 兜底
      const regPath = [
        ...readRegistryPath('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
        ...readRegistryPath('HKCU', 'Environment'),
      ].map(expandEnvVars)
      if (regPath.length > 0) {
        env.PATH = mergePaths([regPath, (process.env.PATH ?? '').split(';')])
      }
      envCache = env
      envCacheAt = now
    } else {
      const probed = probeUnixPath()
      const fallback = [
        '/usr/local/bin', '/usr/local/sbin',
        '/opt/homebrew/bin', '/opt/homebrew/sbin',
        `${process.env.HOME ?? ''}/.local/bin`,
      ]
      const current = (process.env.PATH ?? '').split(':')
      env.PATH = probed
        ? mergePaths([probed.split(':'), current])
        : mergePaths([current, fallback])
    }
  } catch {
    /* 任何异常都回退当前进程 env，不阻塞 spawn */
  }
  return env
}

// ---------- 一次性命令取消：在途 run_once 子进程登记，供「停止生成」硬中断 ----------

const onceProcs = new Map<string, ChildProcess>()

/** 取消在途一次性命令：带 token 只杀对应进程；不带杀全部（全局停止语义）。返回杀掉的进程数 */
export function cancelRunOnce(token?: unknown): number {
  let killed = 0
  for (const [key, child] of [...onceProcs]) {
    if (typeof token === 'string' && token && key !== token) continue
    onceProcs.delete(key)
    if (child.pid) killTree(child.pid)
    killed++
  }
  return killed
}

/** 在途子进程登记（供 ai-cli 等外部模块复用 onceProcs 的取消/清理链），返回注销函数 */
export function registerOnceProc(token: string, child: ChildProcess): () => void {
  onceProcs.set(token, child)
  return () => {
    onceProcs.delete(token)
  }
}

/** 停止单个服务；name 省略 = 停止全部槽 */
export async function stopProject(name?: unknown): Promise<void> {
  if (typeof name === 'string' && name.trim()) {
    takeAndKillOne(normName(name))
    return
  }
  for (const key of [...slots.keys()]) takeAndKillOne(key)
}

/** 退出/切项目清理入口（幂等）：杀全部子进程，watcher 由 index.ts 另行停止 */
export function killRunningForCleanup(): void {
  for (const key of [...slots.keys()]) takeAndKillOne(key)
}

export async function runProject(projectRoot: string, name: unknown, command: string): Promise<number> {
  try {
    const st = await fsp.stat(projectRoot)
    if (!st.isDirectory()) throw new Error(`项目目录不存在：${projectRoot}`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('项目目录不存在')) throw e
    throw new Error(`项目目录不存在：${projectRoot}`)
  }

  const key = normName(name)
  // 同名槽 = 重启语义：先杀旧再启动；其他槽不受影响
  takeAndKillOne(key)

  // 工具链预检：命令找不到时秒失败并给出可行动的错误，而不是让 cmd 的 stderr 让用户猜
  const avail = detectCommand(command)
  if (avail === false) {
    throw new Error(
      `启动失败：未找到命令「${firstToken(command)}」。该工具可能未安装，或安装后未进入当前 PATH。` +
      `可在 AI 对话中授权自动安装，或手动安装后重试。`,
    )
  }

  const isWin = process.platform === 'win32'
  let proc: ChildProcess
  try {
    proc = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/C', command] : ['-c', command], {
      cwd: projectRoot,
      // stdin null + 双管 piped：Windows 下不分配控制台，windowsHide 双保险
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin, // unix 进程组，便于整组 SIGKILL
      env: {
        ...buildChildEnv(),
        // 源头禁色：掐掉 ANSI 码，保证 URL 解析与日志干净
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })
  } catch (e) {
    throw new Error(`命令启动失败：${errorMessage(e)}`)
  }

  const emit = (channel: string, payload: Record<string, unknown>): void => {
    emitToRenderer(channel, { name: key, ...payload })
  }

  const pipe = (stream: Readable | null, streamName: 'stdout' | 'stderr'): void => {
    if (!stream) return
    const rl = createInterface({ input: stream }) // readline 自动剥 \n 与 \r\n
    rl.on('line', (line) => emit('build-output', { stream: streamName, line: stripAnsi(line) }))
  }
  pipe(proc.stdout, 'stdout')
  pipe(proc.stderr, 'stderr')

  // spawn 本身失败（如 shell 不存在，极罕见）：Node 异步抛 error 事件而非同步 throw；
  // 以 build-exit{code:-1} 收口，避免前端永远停在"运行中"
  const isCurrent = (): boolean => slots.get(key)?.proc === proc
  proc.on('error', () => {
    if (isCurrent()) {
      slots.delete(key)
      emit('build-exit', { code: -1 })
    }
    if (proc.pid) unregisterServiceProc(proc.pid)
  })
  proc.on('exit', (code) => {
    if (proc.pid) unregisterServiceProc(proc.pid)
    // 已被同名槽重启替换的旧进程，其退出不再下发——否则旧 exit 会把新槽从 building 打回 error
    if (!isCurrent()) return
    slots.delete(key)
    emit('build-exit', { code: code ?? -1 })
  })

  slots.set(key, { name: key, proc })
  // 登记进 pending-kill：Qyris 被强杀/崩溃时，下次启动能按记录清理孤儿进程树
  if (proc.pid) registerServiceProc(proc.pid, projectRoot)
  return proc.pid ?? -1
}

// ---------- 工具链预检 + HTTP 健康探测 ----------

/** Windows cmd 内建命令不在 where.exe 搜索范围：直接放行交由 cmd.exe 执行 */
const CMD_BUILTINS = new Set([
  'dir', 'cd', 'md', 'mkdir', 'rd', 'rmdir', 'del', 'erase', 'copy', 'xcopy', 'robocopy',
  'move', 'ren', 'rename', 'echo', 'type', 'set', 'call', 'exit', 'for', 'if', 'rem', 'cls', 'start',
])

/** 提取命令首 token（支持带引号的可执行文件路径，如 "C:\Program Files\..\mvn.cmd"） */
export function firstToken(command: string): string {
  const t = command.trim()
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1)
    if (end > 0) return t.slice(1, end)
  }
  return t.split(/\s+/)[0] ?? ''
}

/** 检测命令的可执行文件是否可找到（PATH 已由 buildChildEnv 重建）：
 *  Windows 用 where.exe、unix 用 command -v。返回 null 表示检测自身失败（不阻塞，交由 spawn 兜底报错） */
export function detectCommand(command: string): boolean | null {
  const token = firstToken(command)
  if (!token) return null
  try {
    if (process.platform === 'win32') {
      if (CMD_BUILTINS.has(token.toLowerCase())) return true
      const res = spawnSync('where.exe', [token], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        env: buildChildEnv(),
      })
      if (res.status === 0) return true
      if (res.status === 1) return false
      return null
    }
    const quoted = `'${token.replace(/'/g, `'\\''`)}'`
    const res = spawnSync('sh', ['-c', `command -v -- ${quoted}`], { encoding: 'utf8', timeout: 5000 })
    if (res.status === 0) return true
    if (res.status === 1) return false
    return null
  } catch {
    return null
  }
}

/** HTTP 健康探测：GET 目标地址（3s 超时）。2xx-4xx 都算服务可响应（4xx 常见于需鉴权的管理端），
 *  5xx / 连接拒绝 / 超时算不可用。作为「启动验证」的硬证据（输出正则之外的第二道确认） */
export async function checkUrlHealthy(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const res = await net.fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(3000),
    })
    return res.status < 500
  } catch {
    return false
  }
}

// ---------- 端口占用查询 ----------

/** tasklist 查 PID 对应进程名（Windows） */
function winImageName(pid: number): string {
  const res = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  })
  if (res.status !== 0 || !res.stdout) return 'unknown'
  const m = res.stdout.match(/^"([^"]+)"/)
  return m ? m[1] : 'unknown'
}

/** 查询端口的监听进程：Windows 解析 netstat -ano、unix 用 lsof；查不到返回 null */
export function portOwner(port: number): { pid: number; name: string } | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      })
      if (res.status !== 0 || !res.stdout) return null
      // 行格式：TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  1234（IPv6 本地地址形如 [::]:3000，endsWith 同样命中）
      for (const line of res.stdout.split('\n')) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
        const pid = Number(cols[4])
        if ((cols[1] ?? '').endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) {
          return { pid, name: winImageName(pid) }
        }
      }
      return null
    }
    const res = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-P', '-n'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (res.status !== 0 || !res.stdout) return null
    for (const line of res.stdout.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      const pid = Number(cols[1])
      if (Number.isInteger(pid) && pid > 0) return { pid, name: cols[0] ?? 'unknown' }
    }
    return null
  } catch {
    return null
  }
}

// ---------- 孤儿服务进程清理 ----------
// 强杀 Qyris / 崩溃时 will-quit 清理不执行，被预览的服务进程带着端口继续存活，
// 下次启动必撞端口。策略：spawn 时登记 {pid, 项目根}，正常退出摘除；
// 启动时扫描残留 → 校验进程命令行确含项目根（防 PID 复用误杀）→ 整树强杀。

interface OrphanRecord {
  pid: number
  root: string
  ts: number
}

function orphanFile(): string {
  return path.join(app.getPath('userData'), 'pending-kill.json')
}

function readOrphans(): OrphanRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(orphanFile(), 'utf8')) as OrphanRecord[]
    return Array.isArray(parsed)
      ? parsed.filter((r) => r && Number.isInteger(r.pid) && typeof r.root === 'string')
      : []
  } catch {
    return []
  }
}

function writeOrphans(list: OrphanRecord[]): void {
  try {
    mkdirSync(path.dirname(orphanFile()), { recursive: true })
    writeFileSync(orphanFile(), JSON.stringify(list), 'utf8')
  } catch {
    /* 记录失败不影响主流程 */
  }
}

/** 服务进程 spawn 成功后登记（runProject 专用；run_once 命令跑完即退不登记） */
export function registerServiceProc(pid: number, root: string): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  const list = readOrphans().filter((r) => r.pid !== pid)
  list.push({ pid, root, ts: Date.now() })
  writeOrphans(list)
}

/** 服务进程退出后摘除登记 */
export function unregisterServiceProc(pid: number): void {
  const list = readOrphans()
  if (list.length === 0) return
  writeOrphans(list.filter((r) => r.pid !== pid))
}

/** 校验 pid 的命令行确实包含项目根目录（防 PID 复用误杀），确认则整树强杀 */
function killIfMatches(pid: number, root: string): boolean {
  try {
    let cmdline = ''
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 },
      )
      cmdline = (res.stdout ?? '').trim()
    } else {
      const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 })
      cmdline = (res.stdout ?? '').trim()
    }
    if (!cmdline || !cmdline.toLowerCase().includes(root.toLowerCase())) return false
    killTree(pid)
    return true
  } catch {
    return false
  }
}

/** 应用启动时清理上次异常退出遗留的服务进程；返回杀掉的个数 */
export function cleanupOrphanServices(): number {
  const list = readOrphans().slice(0, 10) // 单次最多校验 10 条，防止极端残留拖慢启动
  writeOrphans([])
  let killed = 0
  for (const rec of list) {
    if (killIfMatches(rec.pid, rec.root)) killed++
  }
  return killed
}

// ---------- 一次性命令（AI 编译阶段：装依赖 / 构建验证） ----------

const RUN_ONCE_TIMEOUT = 10 * 60_000
const RUN_ONCE_TAIL_LINES = 200

/** 执行一条跑完即退的命令：不建服务槽、不产生 build-output 事件，返回退出码与尾部输出（回传 AI）。
 *  cancelToken：在途期间登记进 onceProcs，供 cancelRunOnce 硬中断（命令挂死时「停止生成」能立即杀掉） */
export async function runOnce(projectRoot: string, command: string, cancelToken?: unknown): Promise<{ code: number | null; output: string }> {
  try {
    const st = await fsp.stat(projectRoot)
    if (!st.isDirectory()) throw new Error(`项目目录不存在：${projectRoot}`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('项目目录不存在')) throw e
    throw new Error(`项目目录不存在：${projectRoot}`)
  }
  const cmd = command.trim()
  if (!cmd) throw new Error('命令不能为空')

  // 工具链预检：错误文案面向 AI（结果会回传模型自判），给出下一步行动指引
  const avail = detectCommand(cmd)
  if (avail === false) {
    throw new Error(`工具链缺失：未找到命令「${firstToken(cmd)}」（可能未安装或不在 PATH）。`)
  }

  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const token = typeof cancelToken === 'string' && cancelToken ? cancelToken : null
    let child: ChildProcess
    try {
      child = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/C', cmd] : ['-c', cmd], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
        env: { ...buildChildEnv(), NO_COLOR: '1', FORCE_COLOR: '0' },
      })
    } catch (e) {
      reject(new Error(`命令启动失败：${errorMessage(e)}`))
      return
    }
    if (token) onceProcs.set(token, child)
    const unregister = (): void => {
      if (token) onceProcs.delete(token)
    }

    const lines: string[] = []
    const collect = (stream: Readable | null, streamName: 'stdout' | 'stderr'): void => {
      if (!stream) return
      const rl = createInterface({ input: stream })
      rl.on('line', (line) => {
        lines.push(`[${streamName}] ${stripAnsi(line)}`)
        if (lines.length > RUN_ONCE_TAIL_LINES) lines.splice(0, lines.length - RUN_ONCE_TAIL_LINES)
      })
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')

    // 超时兜底：install 卡死时强杀整棵进程树，避免循环永久挂起
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid)
    }, RUN_ONCE_TIMEOUT)
    child.on('error', (e) => {
      clearTimeout(timer)
      unregister()
      reject(new Error(`命令启动失败：${errorMessage(e)}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      unregister()
      resolve({ code: code ?? -1, output: lines.join('\n') })
    })
  })
}
