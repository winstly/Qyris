/**
 * 子进程环境构建：在 Electron 主进程环境之上重建 PATH。
 * 从 proc.ts 拆出，职责单一——只管环境变量，不管进程生命周期。
 *
 * Windows：读注册表 HKLM/HKCU 的 Path 值，与当前进程 PATH 合并去重。
 * Unix：登录 shell 探测 profile PATH（macOS Finder 启动的 GUI 进程 PATH 极简）。
 */
import { spawnSync } from 'node:child_process'

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

/** @internal（仅冒烟测试）从探测输出提取 PATH：profile 里的 echo/工具打印会污染 stdout，用标记定位；
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

/** 构建子进程环境：在 Electron 主进程环境之上重建 PATH。每次返回新对象，防止调用方修改污染缓存 */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  try {
    if (process.platform === 'win32') {
      const now = Date.now()
      if (envCache && now - envCacheAt < ENV_CACHE_TTL) return { ...envCache }
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
  // Python 在非 TTY（管道）上默认 4KB 块缓冲——小 banner（如 http.server 的就绪行）
  // 永远填不满缓冲区，导致阶段机收不到输出、phase 卡在 building。
  // 强制 unbuffered 消除此问题；对非 Python 进程无副作用。
  if (!env.PYTHONUNBUFFERED) env.PYTHONUNBUFFERED = '1'
  if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = 'utf-8'
  return env
}
