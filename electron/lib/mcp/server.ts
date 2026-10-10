/**
 * MCP stdio server —— 把自有 ToolRegistry 经 Model Context Protocol 暴露给 CLI 类 provider。
 *
 * 为什么存在：claude-cli 走「CLI 自持工具循环」模式（providers/claude-cli.ts 的 executesOwnTools）
 * 后，claude 进程需要一份可执行的工具面。工具实现铁律是「我们自己的代码」（model/types.ts 铁律 2），
 * 所以把 ToolRegistry 挂成一个 stdio MCP server，由 claude 在补全期间 spawn、经 MCP 回调本仓工具。
 * 工具执行权仍在 Qyris——CLI 只是发起调用，真正执行发生在本 server 进程的 executeTool 里。
 *
 * 协议实现（不引 SDK，理由：需要的协议面只有 5 个方法，stdio 是行式 JSON-RPC 2.0，
 * 手写 ≤200 行且零新依赖；SDK 反而把 spawn 生命周期从 provider 手里拿走）：
 *   · 传输：newline-delimited JSON，一行一个消息（MCP spec §Transports › stdio：
 *     "messages MUST be delimited by newlines, and MUST NOT contain embedded newlines"）；
 *   · 消息框架：JSON-RPC 2.0（MCP spec §Base Protocol），request/response/notification 三态，
 *     notification（无 id）绝不回包（JSON-RPC 2.0 §4.2 / MCP §Base Protocol）；
 *   · 方法面（每个方法注明 spec 出处，版本 2025-06-18，https://modelcontextprotocol.io/specification/2025-06-18）：
 *       initialize               —— Lifecycle › Initialization：回 client 请求的 protocolVersion
 *                                   （server 支持该版本时 SHOULD 原样返回）+ capabilities + serverInfo
 *       notifications/initialized —— Lifecycle › Initialization：客户端确认，无响应
 *       tools/list               —— Server › Tools › Listing Tools：{tools: Tool[]}，
 *                                   Tool = {name, description, inputSchema}
 *       tools/call               —— Server › Tools › Calling Tools：{content:[TextContent], isError?}；
 *                                   未知工具 → JSON-RPC error -32602 Invalid params（spec 明文）；
 *                                   执行失败 → **result 内 isError:true**（工具错误是业务结果不是协议错误）
 *       ping                     —— Utilities › Ping：空 result {}
 *       notifications/cancelled  —— Utilities › Cancellation：{requestId, reason?}，中止在途 tools/call
 *   · 未知 request → -32601 Method not found；未知 notification → 静默忽略（无 id 不可回错）。
 *
 * 安全（权限档必须透传，不许默认放开）：
 *   · 暴露面 = toolsForPermission(permission) − 交互型工具（isDeferredTool）；
 *     主进程专属工具（proxy.HOST_ONLY_TOOLS：编排/预览/配置记忆写入）仅在主进程代行通道
 *     （proxy.ts，env 注入）存在时暴露——它们的执行与事件出口必须留在主进程 run 上，
 *     子进程本地执行会丢卡片/转录（见 proxy.ts 文件头）。
 *     权限档从 argv --permission 进来，解析失败 fail-safe 收敛到 'readonly'——宁可少放行不可越权；
 *   · tools/call 双重复核：先查「在暴露面里」（表外名字直接 -32602），再走 executeTool
 *     （其内部还有一次权限复核，fail-closed——两层闸门防「档位改了暴露面没刷新」的时序洞）；
 *   · 结果统一过 clampToolResult（60k 截断），防止 MCP 往返把超长输出灌回模型上下文。
 *
 * 生命周期：由 claude CLI 按 mcp-config spawn 本进程（providers/claude-cli.ts 写配置、传参），
 *   CLI 退出 → stdin 关闭 → 中止全部在途工具 → process.exit(0)。本进程不自己守护、不重连。
 *   stdin 是唯一生命周期信号：CLI 死了 stdin 必关（stdio 管道随父进程回收）。
 *
 * 运行形态：ELECTRON_RUN_AS_NODE=1 下由 Electron 二进制以纯 Node 跑（electron/mcp-server.ts 入口）。
 *   打包态 electron API 不可用——入口处的 electron 桩把 require('electron') 换成「调用即报错」的
 *   代理，让 proc.checkUrlHealthy / secrets.safeStorage 这类调用点响亮降级而不是 Module not found。
 */
import type { ToolCtx, ToolPermission, ToolResult } from '../model/types'
import { clampToolResult, executeTool, isDeferredTool, toolsForPermission } from '../tools'
import { callHostTool, HOST_ONLY_TOOLS, hostProxyFromEnv, HOST_TOOL_ENV_EXCLUDE, type HostToolProxyTarget } from './proxy'

/** MCP server 名：claude 侧工具名前缀 mcp__<name>__<tool> 由它派生（实测 wire 形态） */
export const MCP_SERVER_NAME = 'qyris-tools'

/** claude stream-json 里 MCP 工具调用的全名（实测：`mcp__qyris-tools__list_dir`） */
export function mcpToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`
}

/** 逆映射：全名 → 本 server 的工具名；非本 server 的调用（内置/其他 MCP）返回 null */
export function parseMcpToolName(full: string): string | null {
  const prefix = `mcp__${MCP_SERVER_NAME}__`
  return full.startsWith(prefix) ? full.slice(prefix.length) : null
}

// ---------------- argv 装配（electron/mcp-server.ts 入口解析产物） ----------------

export interface McpServerConfig {
  /** 权限档（fail-safe：缺省/非法 → 'readonly'） */
  permission: ToolPermission
  /** 工程根（路径工具越界防护）；null = 未打开工程 */
  projectRoot: string | null
  /** 主进程代行通道（编排类工具，见 proxy.ts）；null = 暴露面不含 HOST_ONLY_TOOLS */
  hostProxy: HostToolProxyTarget | null
  /** 本 session 额外剔除的工具名（子 session 剔除 dispatch_subtasks，防嵌套派发） */
  excludeTools?: readonly string[]
}

/**
 * argv + env → 配置。argv 只认 --permission / --project-root；未知参数带告警继续（配置面以
 * 最小化为原则，新参数必须在这里显式登记——静默接受会掩盖 provider/server 两端配置漂移）。
 * 代行通道走 env（proxy.hostProxyFromEnv：QYRIS_HOST_TOOL_PORT/TOKEN，由 mcp-config 注入），
 * 不走 argv——令牌经 argv 会进进程列表可见面。
 * fail-safe 口径：值缺失、非法、空串一律收敛最严档/null，不让 server 起不来。
 */
export function parseServerArgv(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const PERMS: readonly ToolPermission[] = ['readonly', 'write', 'exec']
  let permission: ToolPermission = 'readonly'
  let projectRoot: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--permission') {
      const v = argv[++i]
      const hit = PERMS.find((p) => p === v)
      if (hit) permission = hit
      else warn(`--permission 值非法（${String(v)}），按 readonly 兜底`)
    } else if (a === '--project-root') {
      const v = argv[++i]
      projectRoot = v && v.trim() ? v : null
    } else {
      warn(`未知参数「${String(a)}」，已忽略`)
    }
  }
  return {
    permission,
    projectRoot,
    hostProxy: hostProxyFromEnv(env),
    excludeTools: (env[HOST_TOOL_ENV_EXCLUDE] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

function warn(msg: string): void {
  // stdout 只走协议（MCP stdio 契约），诊断一律 stderr
  process.stderr.write(`[qyris-mcp] ${msg}\n`)
}

// ---------------- JSON-RPC 2.0 消息层 ----------------

type JsonRpcId = string | number | null

interface RpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

function isNotification(msg: RpcRequest): boolean {
  return msg.id === undefined // JSON-RPC 2.0 §4.1/§4.2：无 id（含 null？—— null 视为 response，见下）
}

function resultMessage(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function errorMessage(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

/** JSON-RPC 2.0 §5.1 保留错误码（MCP §Base Protocol 沿用） */
const ERR_PARSE = -32700
const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602

// ---------------- MCP 协议核心（可测：io 以回调注入，不做全局副作用） ----------------

export interface McpIo {
  /** 写一行响应（已含换行前的单行 JSON） */
  send(line: string): void
}

export interface McpCore {
  /** 消费一行入站 JSON；解析失败按 -32700 应答（有 id 时） */
  line(raw: string): void
  /** 通知层取消：server 关闭/CLI 断开时中止全部在途工具 */
  cancelAll(reason: string): void
}

/** MCP 规定的 initialize 协商版本（server 只声明这一个，client 请求其他版本时按 spec 回自己的最新） */
const SUPPORTED_PROTOCOL_VERSION = '2025-06-18'

export function createMcpCore(cfg: McpServerConfig, io: McpIo): McpCore {
  // 暴露面一次算定：权限档贯穿本次 server 生命周期（provider 每次补全拉新进程，档位变更自然生效）。
  // 编排工具（HOST_ONLY_TOOLS）走主进程代行通道（proxy.ts）执行，通道未注入时不暴露——
  // 在本进程直接跑会丢卡片/转录（AgentRunContext 的事件出口只挂在主进程 ai.ts）。
  // excludeTools：本 session 再剔除（子 session 剔 dispatch_subtasks 防嵌套派发）。
  const surface = toolsForPermission(cfg.permission)
    .filter((t) => !isDeferredTool(t.name))
    .filter((t) => !HOST_ONLY_TOOLS.includes(t.name) || cfg.hostProxy != null)
    .filter((t) => !(cfg.excludeTools ?? []).includes(t.name))
  const surfaceNames = new Set(surface.map((t) => t.name))

  // 在途 tools/call：requestId → AbortController（notifications/cancelled 与 cancelAll 按它中止）
  const inflight = new Map<JsonRpcId, AbortController>()

  const reply = (id: JsonRpcId, result: unknown): void => io.send(resultMessage(id, result))
  const replyError = (id: JsonRpcId, code: number, message: string): void =>
    io.send(errorMessage(id, code, message))

  /** tools/call：经 ToolRegistry 唯一执行入口（权限复核 + 截断都在那边），双层闸门的第二层 */
  const callTool = (id: JsonRpcId, params: unknown): void => {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown }
    const name = typeof p.name === 'string' ? p.name : ''
    if (!name || !surfaceNames.has(name)) {
      // spec（Server › Tools › Calling Tools）：未知/不可用工具名应答 -32602 Invalid params
      replyError(id, ERR_INVALID_PARAMS, `未知工具或不在当前权限档暴露面：${name || '(空)'}`)
      return
    }
    const ac = new AbortController()
    inflight.set(id, ac)
    const ctx: ToolCtx = { projectRoot: cfg.projectRoot, signal: ac.signal, permission: cfg.permission }
    // 编排类工具回主进程执行（run 的事件出口在那里）；其余就地执行。
    // 通道缺失时 fail-closed 报错而不是就地跑（surface 已挡一层，双保险防暴露面漂移）
    const exec = HOST_ONLY_TOOLS.includes(name)
      ? (cfg.hostProxy
          ? callHostTool(cfg.hostProxy, name, p.arguments ?? {}, ac.signal)
          : Promise.resolve<ToolResult>({ content: `工具「${name}」需要主进程代行通道，本会话未注入`, isError: true }))
      : executeTool(name, p.arguments ?? {}, ctx)
    const settle = (r: ToolResult): void => {
      if (!inflight.delete(id)) return // 已被 cancel：不回包（spec：取消后 result/response 均不应再发）
      const clipped = clampToolResult(r)
      // CallToolResult：文本内容 + 可选 isError（只在失败时带，省字节也对齐 spec 示例）
      reply(id, {
        content: [{ type: 'text', text: clipped.content }],
        ...(clipped.isError ? { isError: true } : {}),
      })
    }
    exec.then(settle, (err: unknown) => {
      if (ac.signal.aborted) return // 中止引发的异常：不回包
      settle({ content: `工具执行失败：${err instanceof Error ? err.message : String(err)}`, isError: true })
    })
  }

  return {
    line(raw) {
      let msg: RpcRequest
      try {
        msg = JSON.parse(raw) as RpcRequest
      } catch {
        // 协议帧损坏：有 id 可应答就回 -32700；连 id 都没有（非对象/半行）只能丢帧
        // （spec §Base Protocol：JSON-RPC 批量帧不在 stdio 传输使用，一行恒一消息）
        try {
          const probe = JSON.parse(raw) as RpcRequest
          if (probe && typeof probe === 'object' && 'id' in probe && probe.id !== undefined && probe.id !== null) {
            replyError(probe.id as JsonRpcId, ERR_PARSE, 'Parse error')
          }
        } catch {
          warn(`丢弃无法解析的入站帧（${raw.slice(0, 80)}）`)
        }
        return
      }
      if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
        // response 帧（CLI 侧对我们不存在 server→client 请求）或垃圾帧：忽略
        return
      }
      const id = (msg.id ?? null) as JsonRpcId
      const notification = isNotification(msg)
      switch (msg.method) {
        case 'initialize': {
          // Lifecycle › Initialization：回显 client 的 protocolVersion（支持时），声明 tools 能力
          const requested = (msg.params as { protocolVersion?: unknown } | null)?.protocolVersion
          const version = typeof requested === 'string' ? requested : SUPPORTED_PROTOCOL_VERSION
          reply(id, {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: MCP_SERVER_NAME, version: '1.0.0' },
            instructions: '轻驭工作台项目工具（文件 / git / 命令 / 工程 / 技能）。路径参数传项目内相对路径。',
          })
          return
        }
        case 'notifications/initialized':
          // Lifecycle › Initialization：客户端确认握手完成；notification，无响应
          return
        case 'tools/list':
          // Server › Tools › Listing Tools：暴露面（已按权限档过滤 + 去交互型）
          reply(id, {
            tools: surface.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          })
          return
        case 'tools/call':
          if (notification) return // tools/call 必是 request；缺 id 按 protocol 违规丢弃
          callTool(id, msg.params)
          return
        case 'ping':
          // Utilities › Ping：空 result
          reply(id, {})
          return
        case 'notifications/cancelled': {
          // Utilities › Cancellation：中止对应在途调用；已完成的自然 no-op
          const target = (msg.params as { requestId?: unknown } | null)?.requestId
          const ac = inflight.get(target as JsonRpcId)
          if (ac) {
            inflight.delete(target as JsonRpcId)
            ac.abort(String((msg.params as { reason?: unknown })?.reason ?? 'MCP cancelled'))
          }
          return
        }
        default:
          if (notification) return // 未知 notification：静默（JSON-RPC 不允许对 notification 回错）
          replyError(id, ERR_METHOD_NOT_FOUND, `Method not found: ${msg.method}`)
      }
    },
    cancelAll(reason) {
      for (const [, ac] of inflight) ac.abort(reason)
      inflight.clear()
    },
  }
}

// ---------------- 进程装配（由 electron/mcp-server.ts 入口调用） ----------------

/** 起 stdio server：行式读 stdin、单行写 stdout；stdin 关闭即中止在途并退出（见文件头生命周期） */
export function startMcpStdioServer(cfg: McpServerConfig): void {
  const core = createMcpCore(cfg, { send: (line) => process.stdout.write(line + '\n') })
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.trim()) core.line(line)
    }
  })
  process.stdin.on('end', () => {
    // CLI 退出 → stdin 关闭：中止在途工具（工具按 ctx.signal 自杀/树杀），给一点收尾余量后退出
    core.cancelAll('MCP server 关闭（CLI 已退出）')
    setTimeout(() => process.exit(0), 500).unref()
  })
  process.stdin.on('error', () => process.exit(0))
  // 兜底：任何未捕获异常都不能让进程挂着占住管道——响亮上 stderr 后退出（CLI 侧会报 server 失联）
  process.on('uncaughtException', (err) => {
    warn(`未捕获异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    core.cancelAll('MCP server 崩溃')
    process.exit(1)
  })
}
