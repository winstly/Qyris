/**
 * 主进程代行通道（host tool proxy）：MCP 子进程 → 主进程的编排类工具代行 RPC。
 *
 * 为什么需要：dispatch_subtasks 是编排工具，卡片/转录事件出口（AgentRunContext）只挂在
 * 主进程 aiChatStream 的 run 上；在 mcp-server 子进程里执行时 runCtx 恒空——子任务照跑
 * 但卡片全丢、编排语义全废（实测形态）。CLI 通道（claude-cli + MCP）的工具面又必须经
 * MCP 暴露，于是编排工具陷入两难：不暴露 = 模型退化成 load_skill 误调（线上形态），
 * 暴露在子进程 = 编排静默失效。代行通道把执行权送回主进程，两个问题一起解。
 *
 * 协议（newline-delimited JSON，一行一消息，仅监听 127.0.0.1）：
 *   请求  {"token":"…","name":"…","input":{…}}
 *   应答  {"ok":true,"content":"…","isError":false} | {"ok":false,"error":"…"}
 * 一连接一调用：客户端发一行、读一行、关连接。长调用（派发可达分钟级）不设超时，
 * 生命周期由调用方（MCP 取消 / run 中止 / 进程退出）与 run 的 AbortSignal 兜底。
 *
 * 安全双闸：
 *   · 令牌每 run 随机（16 字节 hex），只经 mcp-config env 单向注入；任何再往下的子进程
 *     env 由 buildChildEnv 统一剥离（与 QYRIS_SSH_CRED_ 同规，防 run_command 泄漏）；
 *   · 工具名白名单 HOST_ONLY_TOOLS 双侧复核（客户端只发这些、服务端只接这些）——
 *     本通道不是通用 RCE 面，即使令牌泄漏也不能借它执行任意工具。
 */
import { randomBytes } from 'node:crypto'
import { createServer, connect, type Server, type Socket } from 'node:net'
import type { ToolResult } from '../model/types'

/** 只能由主进程执行的工具：执行、事件出口或主进程单例状态必须留在主进程 run 上。
 *  dispatch_subtasks = 编排事件出口；preview_* = 预览面板/控制台缓冲单例；
 *  update_server_tags / memory_save / memory_archive = 落盘后要 fire 本进程配置/记忆变更事件 */
export const HOST_ONLY_TOOLS: readonly string[] = [
  'dispatch_subtasks',
  'preview_open',
  'preview_console',
  'update_server_tags',
  'memory_save',
  'memory_archive',
]

/** env 注入键（buildMcpServerConfig 写入 / parseServerEnv 读出 / buildChildEnv 剥离） */
export const HOST_TOOL_ENV_PORT = 'QYRIS_HOST_TOOL_PORT'
export const HOST_TOOL_ENV_TOKEN = 'QYRIS_HOST_TOOL_TOKEN'
/** 本 session 的 MCP 面额外剔除名单（逗号分隔）：子 session 剔除 dispatch_subtasks 防嵌套派发 */
export const HOST_TOOL_ENV_EXCLUDE = 'QYRIS_HOST_TOOL_EXCLUDE'

/** 通道端点（服务端持有令牌原件；客户端侧目标只有 port+token） */
export interface HostToolProxyTarget {
  port: number
  token: string
}

export interface HostToolProxyEndpoint extends HostToolProxyTarget {
  close(): void
}

/** 服务端执行回调：主进程侧绑定 run 的 ToolCtx 走 ToolRegistry 唯一执行入口 */
export type HostToolExecutor = (name: string, input: unknown) => Promise<ToolResult>

interface WireRequest {
  token?: unknown
  name?: unknown
  input?: unknown
}

interface WireResponse {
  ok?: unknown
  content?: unknown
  isError?: unknown
  error?: unknown
}

function writeLine(sock: Socket, obj: unknown): void {
  sock.write(JSON.stringify(obj) + '\n')
}

/** 打开代行通道（主进程侧）：每 run 一个端点，run 结束 close */
export async function openHostToolProxy(execute: HostToolExecutor): Promise<HostToolProxyEndpoint> {
  const token = randomBytes(16).toString('hex')
  const server: Server = createServer((sock) => {
    let buf = ''
    let handled = false
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.trim() || handled) continue
        handled = true
        void handleRequest(sock, execute, token, line)
      }
    })
    // 连接中断：只影响该调用的应答投递，执行侧由 run 的 AbortSignal 管取消
    sock.on('error', () => { /* EPIPE 等 */ })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    port,
    token,
    close: () => {
      server.close()
      server.unref()
    },
  }
}

async function handleRequest(
  sock: Socket, execute: HostToolExecutor, token: string, line: string,
): Promise<void> {
  const done = (obj: unknown): void => {
    if (!sock.destroyed) writeLine(sock, obj)
  }
  let req: WireRequest
  try {
    req = JSON.parse(line) as WireRequest
  } catch {
    done({ ok: false, error: '请求不是合法 JSON' })
    return
  }
  if (typeof req.token !== 'string' || req.token !== token) {
    done({ ok: false, error: '通道令牌不匹配' })
    return
  }
  const name = typeof req.name === 'string' ? req.name : ''
  if (!HOST_ONLY_TOOLS.includes(name)) {
    done({ ok: false, error: `工具「${name}」不允许走主进程代行通道` })
    return
  }
  try {
    const r = await execute(name, req.input ?? {})
    done({ ok: true, content: r.content, isError: r.isError === true })
  } catch (e) {
    done({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * 发起一次代行调用（MCP 子进程侧）：一连接一调用，读到应答即关。
 * 失败收敛为 isError ToolResult（协议错误/通道断开都不是「工具没跑完」之外的语义，
 * 与 executeTool 的 fail-closed 口径一致），让模型拿着错误自纠而不是把异常漏给 MCP 协议层。
 */
export function callHostTool(
  target: HostToolProxyTarget, name: string, input: unknown, signal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const fail = (msg: string): void => resolve({ content: msg, isError: true })
    if (signal?.aborted) {
      fail('已取消')
      return
    }
    const sock = connect(target.port, '127.0.0.1')
    let settled = false
    let buf = ''
    const settle = (r: ToolResult): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      sock.destroy()
      resolve(r)
    }
    const onAbort = (): void => settle({ content: '已取消', isError: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    sock.setEncoding('utf8')
    sock.on('connect', () => {
      writeLine(sock, { token: target.token, name, input })
    })
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let res: WireResponse
      try {
        res = JSON.parse(buf.slice(0, nl)) as WireResponse
      } catch {
        settle({ content: '主进程代行应答不是合法 JSON', isError: true })
        return
      }
      if (res.ok === true) {
        settle({
          content: typeof res.content === 'string' ? res.content : String(res.content ?? ''),
          ...(res.isError ? { isError: true } : {}),
        })
      } else {
        settle({ content: `主进程代行失败：${String(res.error ?? '未知错误')}`, isError: true })
      }
    })
    sock.on('error', (e) => {
      settle({ content: `主进程代行通道不可用：${e instanceof Error ? e.message : String(e)}`, isError: true })
    })
    sock.on('close', () => {
      settle({ content: '主进程代行通道提前关闭', isError: true })
    })
  })
}

/** env → 通道目标（缺任一键或端口非法 = null，不暴露 host-only 工具） */
export function hostProxyFromEnv(env: NodeJS.ProcessEnv = process.env): HostToolProxyTarget | null {
  const port = Number(env[HOST_TOOL_ENV_PORT])
  const token = env[HOST_TOOL_ENV_TOKEN]
  if (!Number.isInteger(port) || port <= 0 || !token) return null
  return { port, token }
}
