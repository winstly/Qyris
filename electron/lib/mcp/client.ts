/**
 * MCP 客户端 —— @modelcontextprotocol/sdk 封装（Qyris 作为 MCP Client 消费外部 server）。
 *
 * 分工边界：协议层（帧解析 / id 配对 / 握手 / session 管理 / 请求超时）全部交 SDK；本文件只留三件事：
 *   · spawn 生命周期：StdioClientTransport 内置 cross-spawn（win32 .cmd shim 已处理，配置写裸命令即可），
 *     但其 close 只杀直接子进程——npx 类 shim 的孙子进程树必须挂 proc 的 killTree 清理链
 *     （win taskkill /T /F；POSIX 组杀），以 transport.pid 经 registerOncePid 登记；
 *   · 环境：buildChildEnv() 重建 PATH（GUI 启动无终端 PATH）并剥离 QYRIS_SSH_CRED_ /
 *     QYRIS_HOST_TOOL_ 键（外部 server 不可见凭据与代行令牌）；SDK env 选项是完整替换；
 *   · stderr 有界缓冲：连接失败 / 断开时报错附带诊断（win cmd.exe 报错按 GBK 解码）；
 *     管道必须持续排空，否则子进程写满缓冲后挂死。
 *
 * SDK 随包：编译期由 electron-vite bundle 进 out/main（rollup 直接吃 dist/esm 源，产物自包含，
 * 完全绕开运行时 exports map）；electron-builder files 白名单不需要为 SDK 加行。
 *
 * HTTP 侧：StreamableHTTPClientTransport 自管 Mcp-Session-Id；${uuid} 请求头插值与
 * stateless（不出站会话头）经 fetch 包装实现——SDK requestInit.headers 是静态的，插值需要
 * 每请求新鲜值；close() 显式 terminateSession()（DELETE 收尾，SDK close 不含这一步）。
 */
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolResult } from '../model/types'
import { buildChildEnv } from '../proc-env'
import { cancelRunOnce, registerOncePid } from '../proc'
import { mcpServerKind, type McpServerEntry } from '../../../shared/mcp'

/** initialize / tools/list 超时（外部 server 冷启动可能较慢） */
const HANDSHAKE_TIMEOUT_MS = 60_000
/** tools/call 缺省超时（stdio；http 缺省取 options.timeoutMs ?? 30000） */
const DEFAULT_CALL_TIMEOUT_MS = 120_000
/** http 单请求缺省超时（initialize / tools/list / 未配 timeoutMs 的 call） */
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000

/** HTTP close 时会话收尾 DELETE 的时限（DELETE 自身无超时，超时即放弃收尾照常关连接） */
const SESSION_DELETE_TIMEOUT_MS = 2_000
/** stderr 诊断缓冲上限（字符），超限丢弃——只留头部报错线索 */
const STDERR_KEEP = 2_000

/** 外部 MCP server 配置条目 / 选项（唯一定义在 shared/mcp.ts，此处再导出供主进程消费） */
export type { McpServerEntry }
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
  /** 连接断开（进程退出 / 启动失败 / 主动 close）时回调一次：持有方据此标记死连接待懒重连 */
  onClose?: (reason: string) => void
}

// ---------------- 共用纯函数（与传输无关） ----------------

/** stderr 解码：外部进程输出是 UTF-8，但 Windows 的 cmd.exe 报错是系统代码页（GBK）。
 *  先按 UTF-8 解，出现 U+FFFD 才回落 GBK（win32 专用） */
function decodeMaybeGbk(buf: Buffer): string {
  if (buf.length === 0) return ''
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  if (!utf8.includes('�')) return utf8
  if (process.platform !== 'win32') return utf8
  return new TextDecoder('gbk', { fatal: false }).decode(buf)
}

/** tools/list 应答归一：两传输共用（SDK 已做过 zod 校验，这里只收窄形状） */
function parseToolList(res: { tools?: unknown[] }): McpRemoteTool[] {
  const out: McpRemoteTool[] = []
  for (const raw of res.tools ?? []) {
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

/** spawn 环境：三平台 PATH 重建 + 剥离敏感键 + server 自带 env 覆盖（SDK env 选项完整替换） */
function childEnv(entry: McpServerEntry): Record<string, string> {
  return { ...buildChildEnv(), ...(entry.env ?? {}) } as Record<string, string>
}

/** 带超时地 await 一个 promise；超时后执行 dispose 清理并 reject */
async function withTimeout<T>(p: Promise<T>, timeoutMs: number, message: string, dispose?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } catch (e) {
    dispose?.()
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** retryOnDisconnect 契约：幂等请求（initialize / tools/list）断连重试一次；tools/call 非幂等不重试 */
function retryOnDisconnectEnabled(entry: McpServerEntry): boolean {
  return entry.options?.retryOnDisconnect === true
}

/** 幂等调用重试闸门（仅 retryOnDisconnect 开启时重试一次） */
async function idempotentOnce<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!enabled) throw e
    return await fn()
  }
}

/** 连接一个外部 MCP server：按 type 分派 stdio / Streamable HTTP 传输 */
export async function connectMcpServer(serverName: string, entry: McpServerEntry): Promise<McpConnection> {
  const connect = (): Promise<McpConnection> =>
    mcpServerKind(entry) === 'stdio'
      ? connectMcpStdioServer(serverName, entry)
      : connectMcpHttpServer(serverName, entry)
  return idempotentOnce(retryOnDisconnectEnabled(entry), connect)
}

// ---------------- stdio 传输 ----------------

async function connectMcpStdioServer(serverName: string, entry: McpServerEntry): Promise<McpConnection> {
  const command = entry.command?.trim()
  if (!command) throw new Error(`MCP server「${serverName}」缺少启动命令（type=stdio 需要 command）`)

  const transport = new StdioClientTransport({
    command,
    args: entry.args ?? [],
    env: childEnv(entry),
    cwd: entry.cwd?.trim() || undefined,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'qyris', version: '0.1.0' }, { capabilities: {} })

  // stderr 持续排空进有界缓冲（不消费会撑爆管道把子进程挂死），诊断在失败 / 断开时报错附带
  const stderrChunks: Buffer[] = []
  let stderrBytes = 0
  transport.stderr?.on('data', (d: Buffer) => {
    if (stderrBytes < STDERR_KEEP) {
      stderrChunks.push(d)
      stderrBytes += d.length
    }
  })
  const readStderr = (): string => decodeMaybeGbk(Buffer.concat(stderrChunks)).trim().slice(0, STDERR_KEEP)

  // 连接失败也要能树杀：进程可能已 spawn 而握手失败，此时句柄还没交出去，不杀则成僵尸
  const token = `mcp:${serverName}:${randomUUID()}`
  let unregisterPid: (() => void) | null = null
  const killTree = (): void => {
    unregisterPid?.()
    unregisterPid = null
    unregisterPid = registerOncePid(token, transport.pid)
    cancelRunOnce(token)
  }

  let lastError = ''
  client.onerror = (e) => {
    lastError = e.message
  }
  let closed = false
  let onCloseCb: ((reason: string) => void) | undefined
  client.onclose = () => {
    if (closed) return // 主动 close 已派发过，不重复
    closed = true
    // 进程已死：只注销 pid 登记，不再 killTree——pid 可能已被系统回收复用，
    // 退出时的全量 cancelRunOnce 扫到死条目会误杀无关进程
    unregisterPid?.()
    unregisterPid = null
    const detail = readStderr()
    const reason = lastError
      ? `MCP server「${serverName}」连接断开：${lastError}${detail ? `（${detail}）` : ''}`
      : `MCP server「${serverName}」进程已退出${detail ? `：${detail}` : ''}`
    onCloseCb?.(reason)
  }

  try {
    await withTimeout(
      client.connect(transport),
      HANDSHAKE_TIMEOUT_MS,
      `MCP server「${serverName}」连接超时（${HANDSHAKE_TIMEOUT_MS}ms）`,
      killTree,
    )
  } catch (e) {
    killTree()
    throw e
  }
  // spawn 已成功：挂全局清理链（before-quit → killTree 树杀，覆盖 shim 孙子进程）
  unregisterPid = registerOncePid(token, transport.pid)

  return {
    serverName,
    async listTools(): Promise<McpRemoteTool[]> {
      return idempotentOnce(retryOnDisconnectEnabled(entry), async () =>
        parseToolList(await client.listTools({}, { timeout: HANDSHAKE_TIMEOUT_MS })))
    },
    async callTool(tool: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
      const timeoutMs = entry.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
      try {
        const res = await client.callTool({ name: tool, arguments: (input ?? {}) as Record<string, unknown> }, undefined, {
          signal,
          timeout: timeoutMs,
        })
        return toToolResult(res)
      } catch (e) {
        if (signal?.aborted) throw new Error('已取消')
        throw e
      }
    },
    close(): void {
      if (closed) return
      closed = true
      // SDK close 优雅终止直接子进程并 reject 在途请求；树杀兜底清 shim 孙子进程
      void client.close().catch(() => {})
      cancelRunOnce(token)
      onCloseCb?.('MCP 连接已关闭')
    },
    set onClose(cb: ((reason: string) => void) | undefined) {
      onCloseCb = cb
    },
    get onClose(): ((reason: string) => void) | undefined {
      return onCloseCb
    },
  }
}

// ---------------- Streamable HTTP 传输（SDK StreamableHTTPClientTransport） ----------------

/**
 * fetch 包装：每次请求做 entry.headers 的 ${uuid} 插值（SDK requestInit.headers 是静态的，
 * 插值需要新鲜值）；stateless 模式剥出站 mcp-session-id（无状态部署不携带会话头）。
 */
function wrapFetchWithDynamicHeaders(entry: McpServerEntry): FetchLike {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      headers.set(k.toLowerCase(), String(v).split('${uuid}').join(randomUUID()))
    }
    if (entry.options?.sessionMode === 'stateless') headers.delete('mcp-session-id')
    return fetch(url, { ...init, headers })
  }) as FetchLike
}

async function connectMcpHttpServer(serverName: string, entry: McpServerEntry): Promise<McpConnection> {
  const url = entry.url?.trim()
  if (!url) throw new Error(`MCP server「${serverName}」缺少端点 URL（type=streamableHttp 需要 url）`)
  if (!/^https?:\/\//i.test(url)) throw new Error(`MCP server「${serverName}」URL 仅支持 http/https`)

  const optTimeout = typeof entry.options?.timeoutMs === 'number' ? entry.options.timeoutMs : NaN
  const requestTimeoutMs = Number.isFinite(optTimeout) && optTimeout > 0 ? Math.floor(optTimeout) : DEFAULT_HTTP_REQUEST_TIMEOUT_MS
  const callTimeoutMs = entry.timeoutMs ?? requestTimeoutMs

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: wrapFetchWithDynamicHeaders(entry) as FetchLike,
  })
  const client = new Client({ name: 'qyris', version: '0.1.0' }, { capabilities: {} })

  let lastError = ''
  client.onerror = (e) => {
    lastError = e.message
  }
  let closed = false
  let onCloseCb: ((reason: string) => void) | undefined
  client.onclose = () => {
    if (closed) return
    closed = true
    onCloseCb?.(lastError ? `MCP server「${serverName}」连接断开：${lastError}` : `MCP server「${serverName}」连接已关闭`)
  }

  try {
    await withTimeout(
      client.connect(transport),
      HANDSHAKE_TIMEOUT_MS,
      `MCP server「${serverName}」连接超时（${HANDSHAKE_TIMEOUT_MS}ms）`,
      () => void transport.close().catch(() => {}),
    )
  } catch (e) {
    void transport.close().catch(() => {})
    throw e
  }

  return {
    serverName,
    async listTools(): Promise<McpRemoteTool[]> {
      return idempotentOnce(retryOnDisconnectEnabled(entry), async () =>
        parseToolList(await client.listTools({}, { timeout: requestTimeoutMs })))
    },
    async callTool(tool: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const res = await client.callTool({ name: tool, arguments: (input ?? {}) as Record<string, unknown> }, undefined, {
          signal,
          timeout: callTimeoutMs,
        })
        return toToolResult(res)
      } catch (e) {
        if (signal?.aborted) throw new Error('已取消')
        throw e
      }
    },
    close(): void {
      if (closed) return
      closed = true
      // 会话收尾 DELETE（SDK close 不含）限时 best-effort：DELETE 无自身超时且其 abort 要等
      // transport.close()，挂死会楔住 client.close 与在途请求的收口——超时即照常关连接
      void Promise.race([
        transport.terminateSession().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, SESSION_DELETE_TIMEOUT_MS)),
      ])
        .then(() => client.close())
        .catch(() => {})
      onCloseCb?.('MCP 连接已关闭')
    },
    set onClose(cb: ((reason: string) => void) | undefined) {
      onCloseCb = cb
    },
    get onClose(): ((reason: string) => void) | undefined {
      return onCloseCb
    },
  }
}
