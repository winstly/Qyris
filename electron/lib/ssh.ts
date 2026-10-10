/**
 * SSH 远程执行（发布 tab 后端）——照 git.ts/proc.ts 薄封装风格，ssh2 直连。
 *
 * 安全三层（方案 §5，主进程强制，不信任渲染层）：
 *   1. 危险命令闸：命中毁灭性模式直接拒绝（status:'danger-blocked'），
 *      需用户在确认框逐项勾选后由渲染层签发一次性 token 才放行
 *   2. 日志脱敏：所有输出过 redact()——已存凭据字面量 + 通用密码模式
 *   3. 凭据零回读：密码/口令只进 secrets.ts（safeStorage 密文），渲染层只能 set/has/delete
 */
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { DeployServer } from './config'
import { getSecretInternal } from './secrets'
import { mainLog } from './log-file'

const CONNECT_TIMEOUT_MS = 8_000
const KEEPALIVE_MS = 30_000
/** 探针命令执行超时：服务端收下 exec 却不回包时，testConnection 不能陪着永久挂起 */
const PROBE_EXEC_TIMEOUT_MS = 10_000

/** ssh2 协议级 trace 开关：QYRIS_SSH_DEBUG=1 时全量握手/认证/通道日志进主进程日志。
 *  线上 SSH 互联问题（服务端主动断连、算法协商失败等）一跑定位，不用再猜 */
const ssh2Debug = process.env.QYRIS_SSH_DEBUG === '1'
  ? (line: string): void => mainLog.info(`[ssh2] ${line}`)
  : undefined

/** 把 ssh2 的错误原文翻译成带诊断方向的信息。服务端 DISCONNECT 报文的 description
 *  会原样成为 err.message（如裸的「Connection closed」），HINTS 为常见原文补诊断方向 */
function describeSshError(err: Error & { code?: number }, server: DeployServer): string {
  const msg = String(err.message || err)
  const HINTS: Array<[RegExp, string]> = [
    [/all configured authentication/i, '认证被拒：核对用户名与凭据，或服务端禁用了该认证方式（部分服务器只收 keyboard-interactive）'],
    [/connection lost before handshake/i, 'TCP 可达但对端不是 SSH 服务：核对 host/port 是否指向 SSH 端口'],
    [/channel open failure|server closed channel/i, '服务端拒绝打开会话：账户可能是 nologin/受限 shell，或有 ForceCommand 限制'],
    [/timed out while waiting for handshake/i, '握手超时：网络慢、端口不通或被防火墙拦截'],
    [/not connected/i, '连接在操作前已被对端断开：服务端在认证后立即断连（受限 shell / 堡垒机 / 面板代理类环境常见）'],
  ]
  const hint = HINTS.find(([re]) => re.test(msg))?.[1]
  const known = hint ? `${msg}（${hint}）` : msg
  return `SSH 连接失败（${server.name} · ${server.host}:${server.port}）：${known}`
}

/** 危险命令模式表（远端 shell 破坏性操作）——命中即拦截 */
const DANGER_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+-[rf]{1,2}\s+\/(?:\s|$|\*)/, why: '递归删除根目录' },
  { re: /\brm\s+-[rf]{1,2}\s+~\/?(?:\s|$)/, why: '递归删除用户主目录' },
  { re: /\bmkfs\b/i, why: '格式化文件系统' },
  { re: /\bdd\s+[^|]*\bof=\/dev\//i, why: '直写块设备' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: />\s*\/dev\/sd[a-z]/i, why: '覆写磁盘设备' },
  { re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/, why: '全盘放开权限' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: '远程关机/重启' },
  { re: /\bkill\s+-9\s+1\b/, why: '杀死 init 进程' },
  { re: /\bdrop\s+(database|table|schema)\b/i, why: '删除数据库' },
  { re: /\biptables\s+-F\b/, why: '清空防火墙规则' },
  { re: /\bsudo\s+(?!.*\s-n(?:\s|$))/, why: '交互式 sudo 会挂起会话（请加 -n）' },
]

/** 危险命令检查：返回拦截原因，null = 放行 */
export function checkDangerousCommand(command: string): string | null {
  for (const { re, why } of DANGER_PATTERNS) {
    if (re.test(command)) return why
  }
  return null
}

/** 日志脱敏：凭据字面量 + 通用密码模式（命令行 -p、环境变量、Authorization 头） */
export function redact(text: string, secretsToMask: Array<string | undefined>): string {
  let out = text
  for (const s of secretsToMask) {
    if (s && s.length >= 4) out = out.split(s).join('***')
  }
  out = out.replace(/(-p\s+)('[^']*'|"[^"]*"|\S+)/gi, '$1***')
  out = out.replace(/(password\s*[=:]\s*)\S+/gi, '$1***')
  out = out.replace(/(authorization:\s*)\S+/gi, '$1***')
  return out
}

/** 取服务器凭据（密码 / 私钥口令）。
 *  两级来源：①注入 env（QYRIS_SSH_CRED_<serverId>，主进程经 mcp-config env 单向注入，
 *  MCP server 进程是纯 Node 形态、无 safeStorage，secrets 解密不可用）；②主进程 secrets。 */
async function credentialFor(serverId: string): Promise<string | null> {
  const injected = process.env[`QYRIS_SSH_CRED_${serverId}`]
  if (injected) return injected
  return getSecretInternal(`ssh:${serverId}`)
}

function connectConfigFor(server: DeployServer, password: string | null): ConnectConfig {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_MS,
    ...(ssh2Debug ? { debug: ssh2Debug } : {}),
  }
  if (server.auth === 'key') {
    // 私钥本体不复制进 config——只存路径，运行时读本地文件（口令进 secrets）
    if (!server.privateKeyPath) throw new Error('未配置私钥路径')
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    return {
      ...base,
      privateKey: readFileSync(server.privateKeyPath),
      passphrase: password ?? undefined,
    }
  }
  return { ...base, password: password ?? undefined }
}

async function connect(server: DeployServer): Promise<Client> {
  const password = await credentialFor(server.id)
  if (server.auth === 'password' && !password) {
    throw new Error('未设置登录密码（请先在服务器配置里保存凭据）')
  }
  const conn = new Client()
  await new Promise<void>((resolve, reject) => {
    conn
      .on('ready', () => resolve())
      .on('error', (err: Error & { code?: number }) => reject(describeSshError(err, server)))
      .connect(connectConfigFor(server, password))
  })
  return conn
}

/** 连接测试：建连 + echo 探活 + 立即断开 */
export async function testConnection(server: DeployServer): Promise<{ ok: boolean; error?: string }> {
  let conn: Client | null = null
  try {
    conn = await connect(server)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`探测超时（${PROBE_EXEC_TIMEOUT_MS / 1000}s 无回包）：服务端收下了会话但未执行/未回传`)),
        PROBE_EXEC_TIMEOUT_MS,
      )
      conn!.exec('echo ok', (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timer)
          return reject(new Error(`会话打开失败：${err.message}`))
        }
        // stdout/stderr 必须挂监听消费：不消费的流处于暂停态，close 事件不会送达
        let out = ''
        stream.on('data', (d: Buffer) => { out += d.toString('utf8') })
        stream.on('stderr', (d: Buffer) => { out += d.toString('utf8') })
        // channel 'error' 无监听会成 uncaughtException（探测期断连场景）
        stream.on('error', (e: Error) => {
          clearTimeout(timer)
          reject(new Error(`探测通道错误：${e.message}`))
        })
        stream.on('close', (code: number) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`探测命令退出码 ${code}${out.trim() ? `，输出：${out.trim().slice(0, 120)}` : ''}`))
        })
      })
    })
    return { ok: true }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    // exec 在连接已被对端断开时同步抛裸的「Not connected」——同样补上下文
    return { ok: false, error: /not connected/i.test(err.message) ? describeSshError(err, server) : err.message }
  } finally {
    conn?.end()
  }
}

export interface ExecHandle {
  cancel: () => void
}

/** 流式执行远程命令：stdout/stderr 逐行回调（已脱敏），exit 回调退出码。
 *  onStart 在 exec 通道打开时触发（命令已开始执行）——调用方据此区分「连接失败可重试」
 *  与「命令已跑不可重发」；onExit 保证只回调一次（error/close 双事件场景去重） */
export function execCommand(
  server: DeployServer,
  command: string,
  opts: {
    runId: string
    onLine: (stream: 'stdout' | 'stderr', line: string) => void
    onExit: (code: number | null) => void
    onStart?: () => void
    allowDangerous?: boolean
  },
): ExecHandle {
  let conn: Client | null = null
  let cancelled = false
  let buffers = { stdout: '', stderr: '' }
  let exited = false
  const exitOnce = (code: number | null): void => {
    if (exited) return
    exited = true
    opts.onExit(code)
  }

  const emitLines = (stream: 'stdout' | 'stderr', chunk: string, mask: string[]) => {
    buffers[stream] += chunk
    const parts = buffers[stream].split('\n')
    buffers[stream] = parts.pop() ?? ''
    for (const line of parts) opts.onLine(stream, redact(line, mask))
  }

  void (async () => {
    // fire-and-forget 护栏：任何异常收敛为 stderr + onExit(null)，不逃逸成 unhandledRejection
    let mask: string[] = []
    try {
      const password = await credentialFor(server.id)
      mask = password ? [password] : []
      if (cancelled) { exitOnce(null); return }
      try {
        conn = await connect(server)
      } catch (e) {
        opts.onLine('stderr', redact(String((e as Error).message || e), mask))
        exitOnce(null)
        return
      }
      if (cancelled) { conn.end(); exitOnce(null); return }

      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          opts.onLine('stderr', redact(String(err.message || err), mask))
          conn?.end()
          exitOnce(null)
          return
        }
        opts.onStart?.()
        stream
          .on('data', (d: Buffer) => emitLines('stdout', d.toString('utf8'), mask))
          .on('stderr', (d: Buffer) => emitLines('stderr', d.toString('utf8'), mask))
          // channel 'error' 必须挂监听：无监听的 EventEmitter error 会逃出 IIFE 护栏直接炸进程
          .on('error', (e: Error) => {
            opts.onLine('stderr', redact(String(e.message || e), mask))
            conn?.end()
            exitOnce(null)
          })
          .on('close', (code: number | null) => {
            // 余量冲刷
            if (buffers.stdout) opts.onLine('stdout', redact(buffers.stdout, mask))
            if (buffers.stderr) opts.onLine('stderr', redact(buffers.stderr, mask))
            conn?.end()
            exitOnce(cancelled ? null : code)
          })
      })
    } catch (e) {
      // 凭据解密失败等 IIFE 早期异常同样走脱敏出口
      opts.onLine('stderr', redact(String((e as Error).message || e), mask))
      exitOnce(null)
    }
  })()

  return {
    cancel: () => {
      cancelled = true
      conn?.end()
    },
  }
}

/** SFTP 上传单个文件（fastPut）：remote_upload 工具的传输层。
 *  凭据由 connect() 内部注入，调用方只见 server/localPath/remotePath，零凭据经手。
 *  timeoutMs 到点或 signal 中止即断连收口——fastPut 对端假死时不回调，没有兜底会挂死整个 tools/call */
export async function uploadFile(
  server: DeployServer, localPath: string, remotePath: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const conn = await connect(server)
  let timer: NodeJS.Timeout | null = null
  let onAbort: (() => void) | null = null
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      conn.sftp((err: Error | undefined, s: SFTPWrapper) =>
        err ? reject(new Error(`SFTP 会话建立失败：${err.message}`)) : resolve(s))
    })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve()
      }
      if (opts.signal?.aborted) {
        settle(new Error('上传已取消'))
        return
      }
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          conn.end()
          settle(new Error(`上传超时（>${opts.timeoutMs}ms），已断连`))
        }, opts.timeoutMs)
      }
      onAbort = () => {
        conn.end()
        settle(new Error('上传已取消'))
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      sftp.fastPut(localPath, remotePath, (err) =>
        settle(err ? new Error(`上传失败：${err.message}`) : undefined))
    })
  } finally {
    conn.end()
  }
}
