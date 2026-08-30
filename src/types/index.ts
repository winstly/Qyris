// ---------- 文件系统 ----------

export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'folder'
}

export interface FileContent {
  content: string
  isBinary: boolean
  truncated: boolean
}

// ---------- 编译 / 预览 ----------

/** idle=未运行 building=编译中 deploying=部署中 running=运行中 error=异常 */
export type BuildPhase = 'idle' | 'building' | 'deploying' | 'running' | 'error'

export interface BuildOutputEvent {
  stream: 'stdout' | 'stderr'
  line: string
}

export interface BuildExitEvent {
  code: number
}

export interface FsChangedEvent {
  paths: string[]
}

// ---------- AI / 对话 ----------

export interface AiSettings {
  baseUrl: string
  model: string
  provider: 'openai' | 'anthropic'
}

export interface RecentProject {
  path: string
  name: string
  lastOpened: number
}

/** Skill 文件的 frontmatter 摘要（不含 body 内容） */
export interface SkillMeta {
  /** 唯一标识：相对 skillsDir 的文件路径（如 "debug-react.md"） */
  id: string
  /** 显示名称（来自 frontmatter name，缺省取文件名） */
  name: string
  /** 一句话描述 */
  description: string
  /** 触发关键词列表 */
  triggers: string[]
}

export interface AppConfig {
  lastProjectPath: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiProvider: 'openai' | 'anthropic' | null
  recentProjects?: RecentProject[]
  /** Skills 目录绝对路径（可选） */
  skillsDir?: string | null
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
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  resultSummary?: string
  /** 展开详情时显示（已截断） */
  result?: string
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
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
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
