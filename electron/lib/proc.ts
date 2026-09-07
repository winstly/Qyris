/** 子进程管理 —— 多槽版本：每个命名服务一个槽，互不干扰；同名槽重启 = 先杀旧再启 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promises as fsp, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { app, net } from 'electron'
import { emitToRenderer, emitToWindow } from './emitter'
import { errorMessage } from './util'
import { buildChildEnv } from './proc-env'

/** Windows 子进程输出解码器：cmd.exe 输出系统 OEM 代码页（中文=GBK 936、日文=Shift_JIS 932 等）。
 *  首次使用时懒初始化（chcp.com spawnSync ~50ms，不阻塞模块加载）。非 Windows 恒 UTF-8。 */
const IS_WIN = process.platform === 'win32'

const CP_TO_ENCODING: Record<number, string> = {
  936: 'gbk',      // 简体中文
  950: 'big5',     // 繁体中文
  932: 'shift_jis', // 日文
  949: 'euc-kr',   // 韩文
  1252: 'windows-1252', // 西欧
  1250: 'windows-1250', // 中欧
  1251: 'windows-1251', // 西里尔
  1253: 'windows-1253', // 希腊
  1254: 'windows-1254', // 土耳其
  1255: 'windows-1255', // 希伯来
  1256: 'windows-1256', // 阿拉伯
  1257: 'windows-1257', // 波罗的海
  1258: 'windows-1258', // 越南
  874: 'windows-874',   // 泰文
  65001: 'utf-8',       // UTF-8
}

let _streamEncoding: string | null = null
/** 启动时探测一次 OEM 代码页，缓存编码名 */
function getStreamEncoding(): string {
  if (_streamEncoding) return _streamEncoding
  _streamEncoding = 'utf-8'
  if (IS_WIN) {
    try {
      const res = spawnSync('chcp.com', { encoding: 'utf8', windowsHide: true, timeout: 2000 })
      const m = (res.stdout ?? '').match(/(\d+)/)
      if (m) _streamEncoding = CP_TO_ENCODING[Number(m[1])] ?? 'utf-8'
    } catch { /* 探测失败回退 UTF-8 */ }
  }
  return _streamEncoding
}

/** 每个流独立 TextDecoder——并发流共享单例会导致 GBK/Shift_JIS 多字节状态交叉污染 */
function newStreamDecoder(): InstanceType<typeof TextDecoder> {
  return new TextDecoder(getStreamEncoding())
}

/** 从流中按行回调：实时场景（runProject 日志）。Windows 用 OEM 代码页解码原始字节 */
function pipeLines(stream: Readable | null, onLine: (line: string) => void): void {
  if (!stream) return
  const dec = newStreamDecoder()
  let tail = ''
  stream.on('data', (chunk: Buffer) => {
    tail += dec.decode(chunk, { stream: true })
    let nl: number
    while ((nl = tail.indexOf('\n')) >= 0) {
      onLine(tail.slice(0, nl).replace(/\r$/, ''))
      tail = tail.slice(nl + 1)
    }
  })
  stream.on('end', () => {
    tail += dec.decode() // flush TextDecoder 内部多字节缓存
    if (tail.trim()) onLine(tail.replace(/\r$/, ''))
  })
}

/** 从流中收集全部行：一次性命令场景（runOnce 输出）。tag 非空时每行加 `[tag]` 前缀 */
function collectLines(stream: Readable | null, lines: string[], cap: number, tag?: string): void {
  if (!stream) return
  const dec = newStreamDecoder()
  const prefix = tag ? `[${tag}] ` : ''
  let tail = ''
  stream.on('data', (chunk: Buffer) => {
    tail += dec.decode(chunk, { stream: true })
    let nl: number
    while ((nl = tail.indexOf('\n')) >= 0) {
      lines.push(prefix + tail.slice(0, nl).replace(/\r$/, ''))
      if (lines.length > cap) lines.splice(0, lines.length - cap)
      tail = tail.slice(nl + 1)
    }
  })
  stream.on('end', () => {
    tail += dec.decode() // flush
    if (tail.trim()) lines.push(prefix + tail.replace(/\r$/, ''))
  })
}

interface ProcSlot {
  name: string
  proc: ChildProcess
}

/** 服务名 → 槽键 */
const slots = new Map<string, ProcSlot>()

function normName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : ''
  return n || 'default'
}

/** 进程槽键：工程根 × 服务名 */
function slotKey(projectRoot: string, name: unknown): string {
  const root = projectRoot.replace(/[\\/]+$/, '')
  return `${root}\x00${normName(name)}`
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

/** 停止服务。projectRoot+name 停单个；仅 projectRoot 停该工程全部；都缺省停全部（退出/兜底） */
export async function stopProject(projectRoot?: string | null, name?: string | null): Promise<void> {
  const root = typeof projectRoot === 'string' && projectRoot ? projectRoot : null
  const svc = typeof name === 'string' && name.trim() ? normName(name) : null
  if (root && svc) {
    takeAndKillOne(slotKey(root, svc))
    return
  }
  if (root) {
    const prefix = `${root.replace(/[\\/]+$/, '')}\x00`
    for (const key of [...slots.keys()]) if (key.startsWith(prefix)) takeAndKillOne(key)
    return
  }
  for (const key of [...slots.keys()]) takeAndKillOne(key)
}

/** 退出/切项目清理入口（幂等）：杀全部子进程，watcher 由 index.ts 另行停止 */
export function killRunningForCleanup(): void {
  for (const key of [...slots.keys()]) takeAndKillOne(key)
}

export async function runProject(projectRoot: string, name: unknown, command: string, windowId: number | null = null): Promise<number> {
  try {
    const st = await fsp.stat(projectRoot)
    if (!st.isDirectory()) throw new Error(`项目目录不存在：${projectRoot}`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('项目目录不存在')) throw e
    throw new Error(`项目目录不存在：${projectRoot}`)
  }

  const svcName = normName(name)
  const key = slotKey(projectRoot, svcName)
  takeAndKillOne(key)

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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin,
      env: {
        ...buildChildEnv(),
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })
  } catch (e) {
    throw new Error(`命令启动失败：${errorMessage(e)}`)
  }

  const emit = (channel: string, payload: Record<string, unknown>): void => {
    const msg = { name: svcName, projectRoot, ...payload }
    if (windowId != null) emitToWindow(windowId, channel, msg)
    else emitToRenderer(channel, msg)
  }

  pipeLines(proc.stdout, (line) => emit('build-output', { stream: 'stdout', line: stripAnsi(line) }))
  pipeLines(proc.stderr, (line) => emit('build-output', { stream: 'stderr', line: stripAnsi(line) }))

  // spawn 异步失败：以 build-exit{-1} 收口
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
    if (!isCurrent()) return
    slots.delete(key)
    emit('build-exit', { code: code ?? -1 })
  })

  slots.set(key, { name: key, proc })
  if (proc.pid) registerServiceProc(proc.pid, projectRoot)
  return proc.pid ?? -1
}

// ---------- 工具链预检 + HTTP 健康探测 ----------

/** Windows cmd 内建命令集合 */
const CMD_BUILTINS = new Set([
  'dir', 'cd', 'md', 'mkdir', 'rd', 'rmdir', 'del', 'erase', 'copy', 'xcopy', 'robocopy',
  'move', 'ren', 'rename', 'echo', 'type', 'set', 'call', 'exit', 'for', 'if', 'rem', 'cls', 'start',
])

/** @internal 提取命令首 token（支持带引号的可执行文件路径，如 "C:\Program Files\..\mvn.cmd"） */
export function firstToken(command: string): string {
  const t = command.trim()
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1)
    if (end > 0) return t.slice(1, end)
  }
  return t.split(/\s+/)[0] ?? ''
}

/** 检测命令是否可找到。null=检测失败 */
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
    collectLines(child.stdout, lines, RUN_ONCE_TAIL_LINES, 'stdout')
    collectLines(child.stderr, lines, RUN_ONCE_TAIL_LINES, 'stderr')

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
