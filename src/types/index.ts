/**
 * 渲染层类型面：跨进程载荷（IPC/配置/MCP）唯一定义在 shared/，此处再导出供渲染层消费；
 * 仅渲染层自己的模型（设置表单 / wire 格式 / 编译相位）留在此文件。
 */
import type {
  AiCompletion, AiDeltaPayload, AiReasoningPayload, AiToolCall, ChatMessage, ChatMessagePatch,
  CliAgentEventPayload, CliToolEventPayload, CliToolResultPayload, FileContent, GitFileEntry, GitStatus,
  MemoryCategory, MemoryHit, MemoryItem, MemoryPatch, MemoryStats, MemoryStatus, MemoryTier,
  MessageMeta, PreviewConsoleEntry, SkillMeta, ToolCall, ToolResultEntry, TreeNode,
} from '../../shared/ipc-types'
import type { AppConfig, DeployServer, ModelTiers, RecentProject, StartCommand } from '../../shared/app-config'
import type { McpServerEntry, McpServerOptions } from '../../shared/mcp'

export type {
  AiCompletion, AiDeltaPayload, AiReasoningPayload, AiToolCall, ChatMessage, ChatMessagePatch,
  CliAgentEventPayload, CliToolEventPayload, CliToolResultPayload, FileContent, GitFileEntry, GitStatus,
  MemoryCategory, MemoryHit, MemoryItem, MemoryPatch, MemoryStats, MemoryStatus, MemoryTier,
  MessageMeta, PreviewConsoleEntry, SkillMeta, ToolCall, ToolResultEntry, TreeNode,
  AppConfig, DeployServer, ModelTiers, RecentProject, StartCommand,
  McpServerEntry, McpServerOptions,
}

// ---------- 仅渲染层模型 ----------

/** idle=未运行 building=编译中 deploying=部署中 running=运行中 error=异常 */
export type BuildPhase = 'idle' | 'building' | 'deploying' | 'running' | 'error'

export interface AiSettings {
  baseUrl: string
  /** 主模型：规划 + 复杂任务 + 兜底；CLI 模式下透传为 claude --model */
  model: string
  provider: 'openai' | 'anthropic'
  /** 调度模型方式：api=HTTP 直连；claude-cli=本机 Claude Code CLI 自主 agent */
  dispatchMode: 'api' | 'claude-cli'
  /** CLI 权限模式：auto=跳过权限确认；readonly=只读工具白名单 */
  cliPermission: 'auto' | 'readonly'
  /** CLI 可执行文件名/路径（缺省 'claude'） */
  cliCommand?: string | null
  /** 主对话工具循环轮数上限（API/CLI 通用）；null=缺省 60 */
  maxTurns?: number | null
  /** 子 agent 单任务工具循环轮数上限；null=缺省 20 */
  subagentMaxTurns?: number | null
  /** 可选档位模型 */
  tiers?: ModelTiers
}

// ---------- OpenAI 兼容 wire format ----------

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
}

export interface OAIToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}
