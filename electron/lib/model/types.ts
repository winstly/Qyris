/**
 * 模型生态统一契约 —— 全仓唯一真源（Single Source of Truth）。
 *
 * 设计铁律（违反即返工）：
 *   1. 模型 = 纯函数：complete({messages, tools}) → events。**Provider 永不接触会话**。
 *      session / 压缩 / 落盘 / 迁移 全部归 ConversationStore，换 provider 零迁移成本。
 *   2. 工具实现是**我们自己的代码**（tools/），不依赖任何 CLI 自带工具。
 *      CLI 类 provider（claude-cli / codex / opencode）只是「能产出补全的进程」，
 *      定位是 transport，不是 agent——它不开工具、不存会话。
 *   3. Message 语义在此层归一：Anthropic 的 tool_result block / OpenAI 的 role:'tool'
 *      消息，进到上层都长一样。每加一个 provider 只写映射，不动上层。
 *
 * 为什么这么做：后续要按项目支持不同模型方式（Claude API / Codex / OpenCode / 本地），
 * 生态必须自有，不能被任一 CLI 的会话实现绑死。
 */

// ---------- 消息层（provider 无关） ----------

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 文本 / 图片 / 工具调用 / 工具结果，统一成一个内容块模型 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string } // data = base64
  | { type: 'toolUse'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; toolUseId: string; content: string; isError?: boolean }

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** 命中缓存的输入 token（各家口径不同，没有就 0） */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface Message {
  role: Role
  content: ContentPart[]
  /** 供应商无关的元信息：记账 / 排障用，不参与语义 */
  meta?: {
    /** 产出这条消息的 provider id（'anthropic' | 'claude-cli' | …） */
    provider?: string
    /** 模型名（provider 自报） */
    model?: string
    usage?: Usage
    ts?: number
  }
}

// ---------- 补全层（Provider 契约） ----------

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema（draft-07 子集即可，各家都认） */
  inputSchema: object
}

export interface CompletionRequest {
  /** 全量自含：provider 拿到的是完整上下文，不回查任何外部状态 */
  messages: readonly Message[]
  tools?: readonly ToolSchema[]
  signal?: AbortSignal
  options?: {
    temperature?: number
    maxTokens?: number
    /** 强制结构化输出（provider 不支持时由调用方退化为提示词约束 + 解析） */
    jsonSchema?: object
  }
}

export type CompletionEvent =
  | { type: 'text-delta'; text: string }
  /** 思考增量（仅 capabilities.thinking 为 true 时下发）。
   *  不能没有这个事件——否则统一模型层会顺手把 thinking 干掉，
   *  而 thinking 是产品已有能力（渲染层 ai-reasoning 通道在消费）。 */
  | { type: 'reasoning-delta'; text: string }
  /** runner 要执行的工具调用（capabilities.tools=true 时）。
   *  ⚠️ 与 tool-executed 互斥：自持循环的 provider（MCP 模式）**只发 tool-executed**，
   *  因为工具已经（经 MCP 回本进程）执行完了，runner 再执行就是双跑。 */
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  /** 工具已发起、执行中（自持循环/MCP 模式：CLI 刚吐出 tool_use 块，结果未回）。
   *  让 UI 立刻出「执行中」工具卡——否则长命令执行期（npm install 数分钟）聊天窗零反馈。
   *  纯信息性：runner 透传，不执行。 */
  | { type: 'tool-progress'; id: string; name: string; input: unknown }
  /** 工具已被 provider 侧执行完（MCP 模式：CLI 经 MCP 回调本进程 ToolRegistry）。
   *  纯信息性事件——runner 只透传给 UI 建卡，**不再执行**。 */
  | { type: 'tool-executed'; id: string; name: string; input: unknown; result: ToolResult }
  | { type: 'done'; message: Message; usage: Usage }
  | { type: 'error'; error: Error }

export interface ProviderCapabilities {
  streaming: boolean
  /** 原生工具调用（= provider 发 tool-call 事件、**runner 负责执行**）；
   *  不支持时 runner 走提示词模拟 + 解析兜底 */
  tools: boolean
  /** provider 自持工具循环：工具经自己的通道（MCP）执行完再上报 tool-executed。
   *  此时 tools 应为 false（runner 不执行、不传 schemas），本位只做 UI 透传。 */
  executesOwnTools?: boolean
  thinking: boolean
  jsonSchema: boolean
}

/**
 * 模型来源适配器。三类实现：
 *   · 原生 API（anthropic / openai / 各家兼容端点）——HTTP 直连
 *   · 子进程 CLI（claude-cli / codex / opencode）——spawn + 全量 replay 进 stdin
 *   · 测试桩（smoke 用）
 * 无论哪类，都必须满足：无 session、无工具执行、无全局可变状态。
 */
export interface ModelProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  /** 流式补全；最后一个事件恒为 done 或 error */
  complete(req: CompletionRequest): AsyncIterable<CompletionEvent>
  /** 释放子进程 / 连接池等句柄（HTTP 实现可为空） */
  dispose?(): Promise<void> | void
}

// ---------- 工具层（我们自己的实现） ----------

export interface ToolCtx {
  /** 本次调用所属工程根（路径工具用它做越界防护） */
  projectRoot: string | null
  signal?: AbortSignal
  /** 权限档位由 runner 决定，工具只管按档执行 */
  permission: ToolPermission
  /** 长执行工具（run_command 等）逐行实时回调：接了才有执行期反馈，
   *  不接则整段执行期聊天窗静默（npm install 这类几分钟的命令体感就是假死） */
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void
}

/** 工具权限分档：runner 按档拦截，而不是每个工具自己判断 */
export type ToolPermission = 'readonly' | 'write' | 'exec'

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface Tool {
  name: string
  description: string
  inputSchema: object
  /** 该工具所需的最小权限档位 */
  permission: ToolPermission
  execute(input: unknown, ctx: ToolCtx): Promise<ToolResult>
}
