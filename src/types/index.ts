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

// ---------- Git 工作区 ----------

/** 单个改动文件条目（git status --porcelain v1 解析，与 electron/lib/git.ts 保持一致） */
export interface GitFileEntry {
  /** 相对仓库路径（rename 显示新路径） */
  path: string
  /** 原路径（仅 rename 有） */
  renamedFrom?: string
  x: string
  y: string
  /** 已有暂存改动 */
  staged: boolean
  /** 工作区有未暂存改动（含 untracked） */
  unstaged: boolean
  status: 'staged' | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  /** 相对上游：领先 / 落后（无跟踪分支时为 0） */
  ahead: number
  behind: number
  files: GitFileEntry[]
}

// ---------- 预览控制台 ----------

/** 被预览页面的 console 输出条目（主进程按 origin 过滤后转发） */
export interface PreviewConsoleEntry {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug'
  message: string
  sourceId: string
  ts: number
}

// ---------- 编译 / 预览 ----------

/** idle=未运行 building=编译中 deploying=部署中 running=运行中 error=异常 */
export type BuildPhase = 'idle' | 'building' | 'deploying' | 'running' | 'error'

// ---------- AI / 对话 ----------

/** 任务档位模型配置：空缺的档位回退主模型 */
export interface ModelTiers {
  /** 深度推理：疑难调试 / 架构分析 */
  thinking?: string
  /** 轻量快速（Haiku 级）：批量查找 / 轻量总结 */
  fast?: string
  /** 中等（Sonnet 级）：常规代码修改 */
  middle?: string
  /** 最重（Opus 级）：复杂重构 / 跨模块改动 */
  heavy?: string
}

export interface AiSettings {
  baseUrl: string
  /** 主模型：规划 + 复杂任务 + 兜底；CLI 模式下透传为 claude --model */
  model: string
  provider: 'openai' | 'anthropic'
  /** 调度模型方式：api=HTTP 直连；claude-cli=本机 Claude Code CLI 自主 agent */
  dispatchMode: 'api' | 'claude-cli'
  /** CLI 权限模式：auto=跳过权限确认；readonly=只读工具白名单 */
  cliPermission: 'auto' | 'readonly'
  /** 可选档位模型 */
  tiers?: ModelTiers
}

export interface RecentProject {
  path: string
  name: string
  lastOpened: number
}

/** 单个服务的启动命令（AI 编译阶段的识别结果，按项目路径存档） */
export interface StartCommand {
  name: string
  run: string
  /** 本地预览地址（AI 编译时已知则上报，如 http://localhost:8000）；启动时作为初始检测地址 */
  url?: string
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

export interface AppConfig {
  lastProjectPath: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiProvider: 'openai' | 'anthropic' | null
  /** 任务档位模型（thinking/fast/middle/heavy，空缺回退主模型） */
  aiTiers?: ModelTiers
  /** 调度模型方式：api=HTTP 直连；claude-cli=本机 Claude Code CLI */
  aiDispatchMode?: 'api' | 'claude-cli'
  /** CLI 权限模式：auto=跳过权限确认；readonly=只读工具白名单 */
  aiCliPermission?: 'auto' | 'readonly'
  recentProjects?: RecentProject[]
  /** Skills 目录列表（兼容旧单目录 skillsDir 字段，读取时合并去重） */
  skillsDirs?: string[]
  /** @deprecated 旧单目录字段：仅启动迁移时写 null 清空，其余写入方一律用 skillsDirs */
  skillsDir?: string | null
  /** 项目绝对路径 → 已识别的启动命令列表（AI 编译产出，「全部运行」直接执行） */
  startupCommands?: Record<string, StartCommand[]>
  /** 项目绝对路径 → 项目级 Skill 目录列表（用户在技能面板添加的额外目录） */
  projectSkillsDirsMap?: Record<string, string[]>
  /** 记忆整理触发轮次：累计多少轮 AI 回复后滚动提取（2..60），缺省 6 */
  memExtractRounds?: number
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
}

export interface ToolResultEntry {
  toolCallId: string
  content: string
}

/** CLI 子 agent 事件（electron ai-cli 转发，载荷结构与 preload 内联版保持一致） */
export interface CliAgentEventPayload {
  requestId: string
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

/** 用户消息的系统级元数据（UI 渲染卡片用，不影响 AI 收到的内容） */
export interface MessageMeta {
  /** 引用的 Skills（显示卡片用） */
  skills?: { id: string; name: string }[]
  /** AI 启动项目（显示卡片用） */
  projectStart?: boolean
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

// ---------- 记忆（分层记忆系统，见 docs/memory-system-design.md） ----------

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
  /** mem agent 蒸馏累计 token（近似值） */
  distillTokens?: { input: number; output: number }
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
