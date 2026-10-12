/**
 * MCP 配置契约的跨进程共用面（不 import node/electron）：
 * 配置条目类型（McpServerEntry / McpServerOptions，唯一定义）+ 启停/传输判别纯函数。
 * 渲染层（@/types 再导出）与主进程（mcp/client 再导出）都从这里取（单一定义）。
 */

/** 外部 MCP server 配置条目（config.json 的 mcpServers 值形状） */
export interface McpServerEntry {
  /** 传输类型：'stdio'（缺省）| 'streamableHttp' | 'http'（Streamable HTTP） */
  type?: 'stdio' | 'streamableHttp' | 'http'
  /** stdio：启动命令（win32 自动 cmd.exe /c 包装，配置里写裸命令即可） */
  command?: string
  args?: string[]
  /** stdio：工作目录 */
  cwd?: string
  /** streamableHttp：端点 URL */
  url?: string
  /** http：请求头（值支持 ${uuid} 插值） */
  headers?: Record<string, string>
  /** 环境变量（stdio 注入子进程；http 侧仅随配置保留） */
  env?: Record<string, string>
  /** 描述（列表展示） */
  description?: string
  /** 停用（启停唯一落点；历史 enabled:false 在 config.sanitizeMcpServers 归一到此字段） */
  disabled?: boolean
  /** 自动放行的调用面（保留字段；权限映射后续接） */
  autoApprove?: string[]
  options?: McpServerOptions
  transport?: Record<string, unknown>
  /** @deprecated 历史导入口径，语义与 disabled 相反；读侧由 isMcpEnabled 兼容，写侧只落 disabled */
  enabled?: boolean
  /** 该 server 全部工具所需最小权限档；缺省 exec（外部工具 fail-safe 只在满档会话暴露） */
  permission?: 'readonly' | 'write' | 'exec'
  /** tools/call 超时毫秒；stdio 缺省 120000，http 缺省取 options.timeoutMs ?? 30000 */
  timeoutMs?: number
}

/** 传输与稳定性选项（导入 schema 的 options 段）：当前生效项只有 sessionMode / timeoutMs /
 *  retryOnDisconnect 三个，其余键仅随配置保留（导入/编辑 round-trip 不丢字段），不产生行为 */
export interface McpServerOptions {
  captureStderr?: boolean
  stderrLogLevel?: string
  /** 保留字段（未实现）：连接重建策略 */
  restartOnCrash?: boolean
  maxRestartAttempts?: number
  shutdownTimeoutMs?: number
  messageDelimiter?: string
  /** 保留字段（未实现）：坏帧始终跳过 */
  validateJsonFrames?: boolean
  /** http：'stateless' = 不带会话头（无状态部署） */
  sessionMode?: string
  /** http：单请求超时毫秒（缺省 30000） */
  timeoutMs?: number
  /** http：幂等请求（initialize/tools/list）断连重试一次；tools/call 非幂等不重试 */
  retryOnDisconnect?: boolean
  maxSseReconnectAttempts?: number
  sseHeartbeatIntervalMs?: number
  validateOrigin?: boolean
  allowedOrigins?: string[]
  [key: string]: unknown
}

/**
 * 启停判别（唯一口径）：读侧兼容两种导入口径——import schema 的 disabled /
 * 历史 Qyris 扩展的 enabled——写侧只落 disabled（config.sanitizeMcpServers 归一）。
 */
export function isMcpEnabled(entry: { enabled?: boolean; disabled?: boolean } | null | undefined): boolean {
  return !!entry && entry.enabled !== false && entry.disabled !== true
}

/**
 * 传输类型判别（唯一口径：客户端 connectMcpServer 与 MCP 面板 UI 共用）。
 * type 显式优先：'stdio' 归 stdio，其余显式 type（streamableHttp / http / 未知）归 HTTP；
 * 无 type 时按字段推断——有 url 无 command 归 HTTP，否则 stdio。
 */
export function mcpServerKind(entry: { type?: string; command?: string; url?: string } | null | undefined): 'stdio' | 'streamableHttp' {
  if (!entry) return 'stdio'
  if (entry.type) return entry.type === 'stdio' ? 'stdio' : 'streamableHttp'
  return entry.url && !entry.command ? 'streamableHttp' : 'stdio'
}
