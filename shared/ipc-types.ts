/**
 * 主进程 ↔ 渲染层 IPC 载荷类型（纯类型，不 import node/electron）。
 * preload 的桥接签名、渲染层 @/types、主进程各模块（fsops/git/ai-cli/memory/service）都从这里取，
 * 不再各自抄一份形状。同名字段的可选性/注释以本文件为准。
 */
import type { StartCommand } from './app-config'

/** 文件读取结果（mtimeMs 供渲染层保存前做冲突检测基线） */
export interface FileContent {
  content: string
  isBinary: boolean
  truncated: boolean
  /** 磁盘文件 mtime（保存前回传做冲突检测的基线） */
  mtimeMs: number
}

/** 单个改动文件条目（git status --porcelain v1 解析） */
export interface GitFileEntry {
  /** 相对仓库路径（rename 显示新路径） */
  path: string
  /** 原路径（仅 rename 有） */
  renamedFrom?: string
  /** X（暂存区状态）：空格=未暂存，M/A/D/R/C 等 */
  x: string
  /** Y（工作区状态） */
  y: string
  /** 已有暂存改动 */
  staged: boolean
  /** 工作区有未暂存改动（含 untracked） */
  unstaged: boolean
  status: 'staged' | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
}

/** git 工作区状态 */
export interface GitStatus {
  isRepo: boolean
  branch: string | null
  /** 相对上游：领先 / 落后（无跟踪分支时为 0） */
  ahead: number
  behind: number
  files: GitFileEntry[]
}

/** 对话流事件载荷（ai.ts 事件桥 → preload → 渲染层三面共用同一形状） */
export interface AiDeltaPayload {
  requestId: string
  delta: string
  projectRoot?: string
}

export interface AiReasoningPayload {
  requestId: string
  delta: string
  projectRoot?: string
}

export interface CliToolEventPayload {
  requestId: string
  id: string
  name: string
  phase: 'start' | 'stop'
  /** 工具参数 JSON 串（stop 阶段为最终入参） */
  arguments: string
  projectRoot?: string
}

export interface CliToolResultPayload {
  requestId: string
  id: string
  content: string
  isError: boolean
  tokens?: { input: number; output: number }
  projectRoot?: string
}

/** CLI 子 agent 事件（electron ai-cli 转发 → 渲染层聊天流） */
export interface CliAgentEventPayload {
  requestId: string
  /** 事件所属工程根（镜像窗口按它把事件路由到对应工程切片） */
  projectRoot?: string
  /** 所属子 agent 派发卡的 tool_use id（Agent/Task） */
  parentId: string
  kind: 'text' | 'tool' | 'tool-result'
  /** kind=tool / tool-result：工具调用 id */
  id?: string
  /** kind=tool：工具名 */
  name?: string
  /** kind=tool：参数 JSON */
  arguments?: string
  /** kind=text：文本内容 */
  text?: string
  /** kind=tool-result：结果文本 */
  content?: string
  /** kind=tool-result：是否错误结果 */
  isError?: boolean
}

/** MCP 测试结果（进程级状态，UI 只读展示；key = `${scope}::${name}`） */
export interface McpTestResult {
  ok: boolean
  tools: { name: string; description: string }[]
  error?: string
  /** 测试进行中（占位记录，结果随后覆盖） */
  testing?: boolean
  /** 结果时间戳 */
  testedAt?: number
}

/** 文件树节点 */
export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'folder'
}

/** 被预览页面的 console 输出条目（主进程按 origin 过滤后转发） */
export interface PreviewConsoleEntry {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug'
  message: string
  sourceId: string
  ts: number
}

/** Skill 文件的 frontmatter 摘要（不含 body 内容） */
export interface SkillMeta {
  /** 唯一标识：Skill 子目录名（如 "debug-react"，多目录时按目录序首中优先） */
  id: string
  /** 显示名称（来自 frontmatter name，缺省取文件名） */
  name: string
  /** 一句话描述 */
  description: string
  /** 触发关键词列表 */
  triggers: string[]
  /** 来源：user=全局用户级（settings 配置目录），project=项目级（.qyris/skills/ 或项目追加目录） */
  scope?: 'user' | 'project'
}

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export interface AiCompletion {
  content: string | null
  reasoning: string | null
  toolCalls: AiToolCall[]
  finishReason: string | null
  /** 仅 CLI 模式：模型请求下一轮附带的 Skill id 列表（消费方按已扫描索引校验后采用） */
  nextSkill?: string[]
  /** 仅 CLI 模式：模型提交的启动命令清单（AI 编译场景；消费方落盘 startupCommands） */
  startCommands?: StartCommand[] | null
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  resultSummary?: string
  /** 展开详情时显示（已截断） */
  result?: string
  /** 执行期实时输出（run_command 等长命令的逐行流；经 cli-agent-event kind=text 追加） */
  output?: string
}

export interface ToolResultEntry {
  toolCallId: string
  content: string
}

/** 用户消息的系统级元数据（UI 渲染卡片用，不影响 AI 收到的内容） */
export interface MessageMeta {
  /** 引用的 Skills（显示卡片用） */
  skills?: { id: string; name: string }[]
  /** AI 启动项目（显示卡片用） */
  projectStart?: boolean
  /** AI 部署阶段标记：聊天里只显示「部署」meta 卡，指令原文不展示 */
  deployStart?: boolean
  /** 预览页选中的元素（显示卡片用） */
  element?: { selector: string; tag: string; id: string; text: string }
  /** 本条消息触发的记忆检索命中（引用 chip 展示用，纯 UI 元数据，不参与 AI payload） */
  citations?: { id: string; title: string }[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 落库序号（主进程 SQLite write-through 成功后回挂）：有 seq = 已持久化；流式 pending 草稿永远没有 seq */
  seq?: number
  /** 模型的思考过程（reasoning_content），有则折叠展示 */
  reasoning?: string
  /** 流式生成中（打字机光标） */
  pending?: boolean
  error?: boolean
  /** 本条 assistant 消息发起的工具调用 */
  toolCalls?: ToolCall[]
  /** 对应工具的执行结果（回传给模型的历史也由此重建） */
  toolResults?: ToolResultEntry[]
  /** 用户消息的系统级元数据（卡片渲染用） */
  meta?: MessageMeta
}

/** message_patch 的载荷：对已落库消息的指定字段做覆盖（未给出的字段保持原值；meta 显式 null = 清空） */
export interface ChatMessagePatch {
  content?: string
  reasoning?: string | null
  tool?: { toolCalls?: ToolCall[]; toolResults?: ToolResultEntry[] }
  meta?: MessageMeta | null
}

// ---------- 记忆（分层记忆系统：short=会话工作记忆 / long=长期沉淀） ----------

export type MemoryTier = 'short' | 'long'

export type MemoryCategory = 'preference' | 'fact' | 'event' | 'lesson' | 'skill' | 'summary'

export type MemoryStatus = 'active' | 'merged' | 'archived'

/** mem_items 行（主进程 SQLite，camelCase 直出） */
export interface MemoryItem {
  id: string
  /** 工程键（sha1 前 16 位；'global' = 跨工程） */
  projectKey: string
  /** short 层归属会话；long 层为 null */
  sessionId: string | null
  tier: MemoryTier
  category: MemoryCategory
  /** 一行摘要 */
  title: string
  content: string
  /** 溯源 JSON（message ids / snapshot refs） */
  sourceJson: string | null
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  status: MemoryStatus
  supersededBy: string | null
  createdAt: number
  updatedAt: number
}

/** 语义/关键词检索命中（score 为主进程 RRF 融合分，仅排序用） */
export interface MemoryHit extends MemoryItem {
  score: number
}

/** 记忆字段更新（memory_update / mem agent patch op 共用） */
export interface MemoryPatch {
  title?: string
  content?: string
  category?: string
  importance?: number
}

/** 记忆库统计（memoryStats，全局口径不分工程） */
export interface MemoryStats {
  total: number
  byTier: Record<string, number>
  byCategory: Record<string, number>
  /** 本地 embedding 模型就绪（false = 降级仅关键词检索） */
  embedReady: boolean
  /** sqlite-vec 扩展可用 */
  vecAvailable: boolean
  dbBytes: number
  /** mem agent 蒸馏累计 token（近似值，清空记忆时归零；未跑过蒸馏时缺省） */
  distillTokens?: { input: number; output: number }
}
