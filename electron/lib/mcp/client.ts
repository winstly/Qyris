/**
 * MCP stdio 客户端 —— 消费外部 MCP server（Qyris 作为 MCP Client 的进方向）。
 * 与 mcp/server.ts 对称的零依赖实现：手写 JSON-RPC 消息层（initialize /
 * notifications/initialized / tools/list / tools/call / notifications/cancelled / ping），
 * spawn 生命周期留在自己手里（挂 proc 的 killTree 清理链）。
 *
 * 跨平台约束（复用 proc/proc-env 基建，平台分支只在 spawn 一处）：
 *   · Windows：npx 等是 .cmd shim，无 shell spawn 直接 EINVAL → win32 走 shell:true 单串传参
 *     （args 逐条 quoteCmdArg 包引号，防 cmd 二次解析）；
 *   · 环境：buildChildEnv() 重建 PATH（GUI 启动无终端 PATH）并剥离 QYRIS_SSH_CRED_ /
 *     QYRIS_HOST_TOOL_ 键（外部 server 不可见凭据与代行令牌）；
 *   · 进程树：detached: !isWin + registerOnceProc 进 killTree 清理链（win32 taskkill /T /F 树杀）；
 *   · 帧：行解析剥尾 \r（Windows 子进程可能发 \r\n）；
 *   · stderr 必须消费：不排空管道会让子进程写满缓冲后挂死——收进有界缓冲供报错。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import type { ToolResult } from '../model/types'
import { buildChildEnv } from '../proc-env'
import { cancelRunOnce, registerOnceProc } from '../proc'
import { buildCmdLine } from '../cmd-quote'
import { mcpServerKind, type McpServerEntry } from '../../../shared/mcp'

/** 与 server.ts:158 同一协商版本（MCP spec 2025-06-18） */
const PROTOCOL_VERSION = '2025-06-18'
/** initialize / tools/list 超时（外部 server 冷启动可能较慢） */
const HANDSHAKE_TIMEOUT_MS = 60_000
/** tools/call 缺省超时 */
const DEFAULT_CALL_TIMEOUT_MS = 120_000
/** stderr 诊断缓冲上限（字符），超限丢弃——只留头部报错线索 */
const STDERR_KEEP = 2_000

/** 外部 MCP server 配置条目 / 选项（唯一定义在 shared/mcp.ts，此处再导出供主进程消费） */
export type { McpServerEntry}
/** tools/list 条目（归一后形状） */
export interface McpRemoteTool {
  name: string
  description: string
  inputSchema: object
}

/** 单 server 连接句柄 */
export interface McpConnection {
  serverName: string
  listTools(): Promise<McpRemoteTool[]>
  callTool(tool: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>
  close(): void
  /** 连接断开（进程退出 / 启动失败 / 主动 close）时回调一次：持有方据此把该 server 的工具撤出注册表 */
  onClose?: (reason: string) => void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

interface RpcMessage {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

/** spawn 环境：三平台 PATH 重建 + 剥离敏感键 + server 自带 env 覆盖 */
function childEnv(entry: McpServerEntry): NodeJS.ProcessEnv {
  return { ...buildChildEnv(), ...(entry.env ?? {}) }
}

/** stderr 解码：外部进程输出是 UTF-8，但 Windows 的 cmd.exe 报错是系统代码页（GBK）。
 *  先按 UTF-8 解，出现 U+FFFD 才回落 GBK（win32 专用） */
function decodeMaybeGbk(buf: Buffer): string {
  if (buf.length === 0) return ''
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  if (!utf8.includes('�')) return utf8
  if (process.platform !== 'win32') return utf8
  return new TextDecoder('gbk', { fatal: false }).decode(buf)
}

/** tools/list 应答归一：两传输共用（stdio / HTTP 的 tools/list 结果同构） */
function parseToolList(res: unknown): McpRemoteTool[] {
  const list = Array.isArray((res as { tools?: unknown } | null)?.tools) ? (res as { tools: unknown[] }).tools : []
  const out: McpRemoteTool[] = []
  for (const raw of list) {
    const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof t.name !== 'string' || !t.name.trim()) continue
    out.push({
      name: t.name.trim(),
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema:
        t.inputSchema && typeof t.inputSchema === 'object' ? (t.inputSchema as object) : { type: 'object', properties: {} },
    })
  }
  return out
}

/** tools/call 应答 → ToolResult（内容块只取 text；工具错误是业务结果 isError，不是协议错误） */
function toToolResult(raw: unknown): ToolResult {
  const r = raw as { content?: unknown; isError?: unknown } | null
  const parts = Array.isArray(r?.content) ? r.content : []
  const text = parts
    .map((p) => {
      const b = p as { type?: unknown; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter(Boolean)
    .join('\n')
  return {
    content: text || '（工具无文本返回）',
    ...(r?.isError === true ? { isError: true } : {}),
  }
}

/** 连接一个外部 MCP server：按 type 分派 stdio / Streamable HTTP 传输 */
export async function connectMcpServer(serverName: string, entry: McpServerEntry): Promise<McpConnection> {
  return mcpServerKind(entry) === 'stdio'
    ? connectMcpStdioServer(serverName, entry)
    : connectMcpHttpServer(serverName, entry)
}

/** stdio 传输：spawn → initialize 握手 → 请求应答配对（id 关联 + 超时 + 取消） */
async function connectMcpStdioServer(serverName: string, entry: McpServerEntry): Promise<McpConnection> {
  const command = entry.command?.trim()
  if (!command) throw new Error(`MCP server「${serverName}」缺少启动命令（type=stdio 需要 command）`)
  const isWin = process.platform === 'win32'
  const cwd = entry.cwd?.trim() || undefined
  // win32 统一 shell:true 单串传参（.cmd/.bat shim 无 shell spawn 直接 EINVAL）；
  // command 与 args 一律过 buildCmdLine 引号包装（cmd-quote.ts 唯一口径），防 cmd 二次解析。
  // POSIX 直启 argv（无 shell 二次解析）
  const child: ChildProcess = isWin
    ? spawn(buildCmdLine(command, entry.args ?? []), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: childEnv(entry),
        cwd,
      })
    : spawn(command, entry.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX 进程组首领：killTree 的 kill(-pid) 才能整树收割（同 runProject detached 惯例）
        detached: true,
        env: childEnv(entry),
        cwd,
      })

  // 清理链登记：before-quit → proc.cancelRunOnce() → killTree（win taskkill /T /F；POSIX 组杀）
  const token = `mcp:${serverName}:${randomUUID()}`
  registerOnceProc(token, child)

  // stderr 按 Buffer 收集再解码：Windows 的 cmd.exe 报错是系统代码页（GBK），
  // 直接按 UTF-8 读会出乱码
  const stderrChunks: Buffer[] = []
  let stderrBytes = 0
  child.stderr?.on('data', (d: Buffer) => {
    if (stderrBytes < STDERR_KEEP) {
      stderrChunks.push(d)
      stderrBytes += d.length
    }
  })
  const readStderr = (): string => decodeMaybeGbk(Buffer.concat(stderrChunks)).trim().slice(0, STDERR_KEEP)

  const pending = new Map<string | number, Pending>()
  let nextId = 1
  let closed = false
  let onCloseCb: ((reason: string) => void) | undefined
  const fireClose = (reason: string): void => {
    const cb = onCloseCb
    onCloseCb = undefined
    cb?.(reason)
  }

  // 子进程先退时 stdin 写入会 EPIPE：不挂 error 处理会变成未捕获 error 事件把主进程打崩
  child.stdin?.on('error', () => { /* 由 exit/error 统一收尾 */ })

  const write = (obj: unknown): void => {
    if (closed || !child.stdin?.writable) return
    child.stdin.write(JSON.stringify(obj) + '\n')
  }

  const rejectAll = (reason: string): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    pending.clear()
  }

  const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      write({ jsonrpc: '2.0', id, method, params })
    })

  const rl: Interface = createInterface({ input: child.stdout! })
  rl.on('line', (line: string) => {
    // Windows 子进程可能发 \r\n：剥尾 \r 再解析
    const text = line.replace(/\r$/, '')
    if (!text.trim()) return
    let msg: RpcMessage
    try {
      msg = JSON.parse(text) as RpcMessage
    } catch {
      return
    }
    const id = msg.id as string | number | undefined
    if (id === undefined) return // notification（无 id）：P0 不消费 server 侧通知
    if (msg.method !== undefined) {
      // server→client 请求：只应答 ping，其余 -32601（与 server.ts 未知方法同口径）
      if (msg.method === 'ping') write({ jsonrpc: '2.0', id, result: {} })
      else write({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${String(msg.method)}` } })
      return
    }
    const p = pending.get(id)
    if (!p) return // 迟到应答（已超时/已取消）：丢弃
    pending.delete(id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(String(msg.error.message ?? 'MCP 调用失败')))
    else p.resolve(msg.result)
  })

  child.on('exit', () => {
    closed = true
    rl.close()
    cancelRunOnce(token)
    const detail = readStderr()
    const reason = `MCP server「${serverName}」进程已退出${detail ? `：${detail}` : ''}`
    rejectAll(reason)
    fireClose(reason)
  })
  child.on('error', (e) => {
    closed = true
    rl.close()
    cancelRunOnce(token)
    const reason = `MCP server「${serverName}」启动失败：${e.message}`
    rejectAll(reason)
    fireClose(reason)
  })

  // Lifecycle › Initialization：initialize 应答后发 notifications/initialized（无响应）。
  // 握手失败必须自毁：此时 close() 句柄还没交出去，不杀则 spawn 的进程树成僵尸
  try {
    await request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qyris', version: '0.1.0' },
      },
      HANDSHAKE_TIMEOUT_MS,
    )
  } catch (e) {
    closed = true
    rejectAll('MCP 握手失败')
    rl.close()
    cancelRunOnce(token)
    throw e
  }
  write({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return {
    serverName,
    async listTools(): Promise<McpRemoteTool[]> {
      return parseToolList(await request('tools/list', {}, HANDSHAKE_TIMEOUT_MS))
    },
    callTool(tool: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
      if (closed) return Promise.reject(new Error('MCP 连接已关闭'))
      const timeoutMs = entry.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
      return new Promise<ToolResult>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('已取消'))
          return
        }
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          signal?.removeEventListener('abort', onAbort)
          reject(new Error(`MCP tools/call 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        const onAbort = (): void => {
          // spec › Utilities › Cancellation：notifications/cancelled 携带被取消请求的 id
          write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: '工具调用已取消' } })
          pending.delete(id)
          clearTimeout(timer)
          reject(new Error('已取消'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve(toToolResult(v))
          },
          reject: (e) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            reject(e)
          },
          timer,
        })
        write({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: input ?? {} } })
      })
    },
    close(): void {
      if (closed) return
      closed = true
      rejectAll('MCP 连接已关闭')
      rl.close()
      // killTree：win taskkill /T /F；POSIX kill(-pid)（依赖 spawn 的 detached）
      cancelRunOnce(token)
      fireClose('MCP 连接已关闭')
    },
    set onClose(cb: ((reason: string) => void) | undefined) {
      onCloseCb = cb
    },
    get onClose(): ((reason: string) => void) | undefined {
      return onCloseCb
    },
  }
}

// ---------------- Streamable HTTP 传输（MCP §Transports） ----------------
//
// POST JSON-RPC 到端点；应答 application/json（单消息）或 text/event-stream（SSE 帧流）。
// 会话头 Mcp-Session-Id 随请求携带（sessionMode:'stateless' 不存不带）；请求头值支持 ${uuid} 插值。
// 重试纪律：仅幂等方法按 options.retryOnDisconnect 重试一次；
// tools/call 非幂等，断连即失败。

/** fetch 的最小结构面（主进程无 DOM lib，按结构收窄） */
interface HttpFetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> } } | null
}

type HttpFetch = (url: string, init: Record<string, unknown>) => Promise<HttpFetchResponse>

function buildHttpHeaders(entry: McpServerEntry, sessionId: string | null): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  for (const [k, v] of Object.entries(entry.headers ?? {})) {
    out[k.toLowerCase()] = String(v).split('${uuid}').join(randomUUID())
  }
  if (sessionId) out['mcp-session-id'] = sessionId
  return out
}

/**
 * 一次 HTTP 往返：POST body → 解析 JSON 或 SSE 应答，返回与 targetId 匹配的消息。
 * SSE 解析：只取 `data:` 行的 JSON 帧（event/id/retry 行忽略；坏帧跳过）。
 * server→client 请求帧（带 method+id）P0 丢弃：纯 POST 通道无反向通路，GET 流属 P2。
 */
async function httpRpc(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  targetId: number | undefined,
  signal?: AbortSignal,
): Promise<{ message: RpcMessage | null; sessionId: string | null }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const onAbort = (): void => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let sseReader: { cancel?: () => Promise<void> } | null = null
  try {
    const res = await (globalThis.fetch as unknown as HttpFetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const sessionId = res.headers.get('mcp-session-id')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (res.status === 202) return { message: null, sessionId } // 通知类：无应答体
    const ctype = res.headers.get('content-type') ?? ''
    if (!ctype.includes('text/event-stream')) {
      try {
        return { message: (await res.json()) as RpcMessage, sessionId }
      } catch {
        return { message: null, sessionId }
      }
    }
    if (!res.body) return { message: null, sessionId }
    const reader = res.body.getReader()
    sseReader = reader
    const decoder = new TextDecoder()
    let buf = ''
    const take = (): RpcMessage | null => {
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          const m = JSON.parse(payload) as RpcMessage
          if (targetId === undefined || m.id === targetId) return m
        } catch {
          /* 坏帧跳过 */
        }
      }
      return null
    }
    let found = take()
    while (!found) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      found = take()
    }
    return { message: found, sessionId }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // SSE 流在匹配帧提前返回时不会走完，必须显式 cancel，否则 body 悬挂占住连接
    void sseReader?.cancel?.().catch(() => {})
  }
}

/** Streamable HTTP 传输：initialize 握手 + 请求应答配对（每次 POST 独立往返） */
async function connectMcpHttpServer(serverName: string, entry: McpServerEntry): Promise<McpConnection> {
  const url = entry.url?.trim()
  if (!url) throw new Error(`MCP server「${serverName}」缺少端点 URL（type=streamableHttp 需要 url）`)
  if (!/^https?:\/\//i.test(url)) throw new Error(`MCP server「${serverName}」URL 仅支持 http/https`)
  const stateless = entry.options?.sessionMode === 'stateless'
  const optTimeout = typeof entry.options?.timeoutMs === 'number' ? entry.options.timeoutMs : NaN
  const requestTimeoutMs = Number.isFinite(optTimeout) && optTimeout > 0 ? Math.floor(optTimeout) : 30_000
  const callTimeoutMs = entry.timeoutMs ?? requestTimeoutMs
  const retryOnce = entry.options?.retryOnDisconnect === true
  const fetchFn = globalThis.fetch as unknown as HttpFetch
  let sessionId: string | null = null
  let closed = false
  let nextId = 1

  /** 一次请求（幂等方法才允许断连重试一次；tools/call 非幂等绝不重试） */
  const rpc = async (
    body: Record<string, unknown>, targetId: number, idempotent: boolean, timeoutMs: number, signal?: AbortSignal,
  ): Promise<RpcMessage> => {
    const attempt = async (): Promise<RpcMessage> => {
      const r = await httpRpc(url, buildHttpHeaders(entry, stateless ? null : sessionId), body, timeoutMs, targetId, signal)
      if (!stateless && r.sessionId) sessionId = r.sessionId
      if (!r.message) throw new Error('MCP 应答中无匹配 id（流提前关闭或超时）')
      return r.message
    }
    try {
      return await attempt()
    } catch (e) {
      if (closed) throw new Error('MCP 连接已关闭')
      if (retryOnce && idempotent && !closed && !signal?.aborted) return attempt()
      throw e
    }
  }

  const request = async (method: string, params: unknown, idempotent: boolean, timeoutMs: number): Promise<unknown> => {
    const id = nextId++
    const msg = await rpc({ jsonrpc: '2.0', id, method, params }, id, idempotent, timeoutMs)
    if (msg.error) throw new Error(String(msg.error.message ?? 'MCP 调用失败'))
    return msg.result
  }

  const notify = (method: string): void => {
    // 通知 best-effort：失败不阻断主流程
    void httpRpc(url, buildHttpHeaders(entry, stateless ? null : sessionId), { jsonrpc: '2.0', method }, requestTimeoutMs, undefined).catch(() => {})
  }

  // Lifecycle › Initialization
  await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'qyris', version: '0.1.0' },
  }, true, requestTimeoutMs)
  notify('notifications/initialized')

  return {
    serverName,
    async listTools(): Promise<McpRemoteTool[]> {
      return parseToolList(await request('tools/list', {}, true, requestTimeoutMs))
    },
    callTool(tool: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
      if (closed) return Promise.reject(new Error('MCP 连接已关闭'))
      if (signal?.aborted) return Promise.reject(new Error('已取消'))
      const id = nextId++
      return rpc(
        { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: input ?? {} } },
        id,
        false,
        callTimeoutMs,
        signal,
      ).then((msg) => {
        if (msg.error) throw new Error(String(msg.error.message ?? 'MCP 调用失败'))
        return toToolResult(msg.result)
      })
    },
    close(): void {
      if (closed) return
      closed = true
      // 会话收尾（stateless 无会话）：DELETE best-effort
      if (!stateless && sessionId) {
        void fetchFn(url, {
          method: 'DELETE',
          headers: buildHttpHeaders(entry, sessionId),
        }).catch(() => {})
      }
    },
  }
}
