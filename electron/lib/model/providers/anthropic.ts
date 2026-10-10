/**
 * 模型生态 · Anthropic Messages API（HTTP 直连）provider。
 * 由 ai-api.ts 的 anthropicChatStream 改造而来，按 model/types.ts 契约输出事件流，
 * 最后一个事件恒为 done 或 error。
 *
 * 与旧实现的差异（迁移边界，勿回退）：
 *  · 不碰 emitter / 窗口路由——事件只走 AsyncIterable，无全局可变状态（旧实现靠 requestId 索引 abort 表）
 *  · Message 的 toolUse / toolResult 在此归一成 tool_use / tool_result 块，上层只见统一 Message
 *  · 不开 thinking：CompletionEvent 没有思考通道，思考内容交不出去，开了只多烧 token
 *    （旧实现开 thinking 是因为旧事件流有 ai-reasoning 通道可下发）
 */
import type {
  CompletionEvent, CompletionRequest, Message, ModelProvider,
  ProviderCapabilities, ToolSchema, Usage,
} from '../types'
import { errorMessage } from '../../util'

type Json = Record<string, any>

export interface AnthropicConfig {
  apiKey: string
  /** 兼容网关基址（剥尾斜杠后拼 /v1/messages，不代填任何路径）；缺省官方 */
  baseUrl?: string
  model: string
  /** 顶轮输出上限。Anthropic 必填项，缺省 8192 */
  maxTokens?: number
}

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 8192
/** 首帧归一的用户引导帧：仅当序列以 assistant 开头时补。刻意短、不编造用户诉求，
 *  只把角色序修合法，避免污染语义。openai.ts 有同款（部分兼容网关同样要求 user 开头）。 */
const USER_ANCHOR_TEXT = '（此前内容已省略）请继续。'

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  // thinking_delta 已映射为 reasoning-delta（见 processLine）；模型不开 thinking 时不会有该事件
  thinking: true,
  // Anthropic 无 json_schema 强约束（旧实现也不发），结构化由调用方走提示词兜底
  jsonSchema: false,
}

export function createAnthropicProvider(cfg: AnthropicConfig): ModelProvider {
  return {
    id: 'anthropic',
    capabilities: CAPABILITIES,
    async *complete(req) {
      yield* complete(cfg, req)
    },
  }
}

// ---------------- Message → Anthropic payload ----------------

/** 统一 Message → { system, messages }。
 *  Anthropic 要求 user/assistant 严格交替，且 tool_result 块必须排在该轮 content 数组最前、
 *  并紧跟在携带 tool_use 的 assistant 轮之后——所以连续同角色要合并，合并时 tool_result 归并到最前。 */
function toAnthropicPayload(messages: readonly Message[]): { system: string | null; messages: Json[] } {
  const systemParts: string[] = []
  const out: Json[] = []
  let lastRole: 'user' | 'assistant' | null = null

  const push = (role: 'user' | 'assistant', toolResults: Json[], others: Json[]): void => {
    if (toolResults.length === 0 && others.length === 0) return
    if (out.length > 0 && lastRole === role) {
      const prev = out[out.length - 1] as { content: Json[] }
      const prevTr = prev.content.filter((b) => b.type === 'tool_result')
      const prevOther = prev.content.filter((b) => b.type !== 'tool_result')
      // tool_result 全部顶到最前，其余保持相对顺序续后
      prev.content = [...prevTr, ...toolResults, ...prevOther, ...others]
      return
    }
    out.push({ role, content: [...toolResults, ...others] })
    lastRole = role
  }

  for (const m of messages) {
    if (m.role === 'system') {
      const text = textOf(m.content)
      if (text) systemParts.push(text)
      continue
    }
    const toolResults: Json[] = []
    const others: Json[] = []
    for (const part of m.content) {
      if (part.type === 'text') {
        if (part.text) others.push({ type: 'text', text: part.text })
      } else if (part.type === 'image') {
        others.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } })
      } else if (part.type === 'toolUse') {
        others.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} })
      } else if (part.type === 'toolResult') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: part.toolUseId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        })
      }
    }
    push(m.role === 'assistant' ? 'assistant' : 'user', toolResults, others)
  }

  // 首帧归一（wire 层兜底，见 types.ts 铁律 3）：Anthropic 硬性要求首条消息是 user，
  // 否则直接 400。store.window() 的 user 锚点层是软的（回补代价超 USER_ANCHOR_SLACK 就保
  // 结构边界、把首条引导帧留给 wire 层），所以这里必须补，不能指望调用方保证。
  // toolUse/toolResult 的配对完整性由 store 的结构层保证，本层不再重复裁剪。
  if (out.length > 0 && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: USER_ANCHOR_TEXT }] })
  }

  // 前缀缓存断点：末条消息的最后一个块挂 cache_control，把到此为止的整条前缀（含 system）
  // 一起缓存，下一轮同前缀直接命中。全量 replay 的模式下没有这个断点 = 每轮全价。
  // ⚠️ 全请求**只放一个 message 级断点**：放两个会让倒数第二条的 KV 页多活一轮白烧
  //（源码 addCacheBreakpoints 注释点名的反直觉坑）。
  if (out.length > 0) {
    const last = out[out.length - 1] as { content: Json[] }
    const blocks = last.content
    if (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1] as Record<string, unknown>
      blocks[blocks.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } }
    }
  }

  return { system: systemParts.join('\n\n') || null, messages: out }
}

function toAnthropicTools(tools?: readonly ToolSchema[]): Json[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.inputSchema as Json) ?? { type: 'object', properties: {} },
  }))
}

function textOf(content: Message['content']): string {
  return content
    .filter((p): p is Extract<Message['content'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}

/** 工具入参兜底：流式拼出来的 JSON 也可能残缺，parse 不出就给 {}。
 *  契约的 input 是 unknown，但 Tool.execute 与历史回放都吃对象，塞裸字符串会让下游二次编码。 */
function safeInput(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

/** 流式失败降级非流式（stream:false）一次。
 *  只在调用方确认「尚未发出任何正文/工具」时才安全——已发出再重试会让正文重复。
 *  降级失败返回 null，由调用方按原错误收尾，不掩盖真实原因。 */
async function completeNonStreaming(
  cfg: AnthropicConfig,
  system: string | null,
  messages: Json[],
  tools: Json[] | undefined,
  signal: AbortSignal,
): Promise<{ message: Message; usage: Usage } | null> {
  try {
    const res = await fetch(`${trimBaseUrl(cfg.baseUrl ?? 'https://api.anthropic.com')}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        system,
        messages,
        tools,
        max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      }),
      signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as Json
    const content: Message['content'] = []
    const blocks = Array.isArray(data.content) ? (data.content as Json[]) : []
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text) content.push({ type: 'text', text: b.text })
      else if (b.type === 'tool_use') {
        content.push({ type: 'toolUse', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input ?? {} })
      }
    }
    if (content.length === 0) return null
    const u = (data.usage ?? {}) as Json
    const usage: Usage = {
      inputTokens: Number(u.input_tokens ?? 0),
      outputTokens: Number(u.output_tokens ?? 0),
      cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
      cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
    }
    return {
      message: { role: 'assistant', content, meta: { provider: 'anthropic', model: cfg.model, usage } },
      usage,
    }
  } catch {
    return null
  }
}

// ---------------- SSE 流 → CompletionEvent ----------------

interface StreamAccum {
  text: string
  toolUses: { id: string; name: string; input: unknown }[]
  usage: Usage
  currentTool: { id: string; name: string; json: string } | null
}

/** 解析一行 SSE（event:/data: 混排，只吃 data:）。就地更新 acc，返回本行要下发的事件。
 *  返回 {type:'error'} 表示流内致命错误，调用方必须立即收尾且不得再发 done。 */
function processLine(rawLine: string, acc: StreamAccum): CompletionEvent[] {
  const line = rawLine.trimEnd()
  if (!line.startsWith('data:')) return []
  const data = line.slice(5).trim()
  if (!data) return []
  let json: Json
  try {
    json = JSON.parse(data) as Json
  } catch {
    return []
  }
  const type = json.type as string | undefined

  if (type === 'message_start') {
    const u = (json.message as Json | undefined)?.usage as Json | undefined
    if (u) {
      acc.usage.inputTokens += num(u.input_tokens)
      acc.usage.cacheReadTokens = (acc.usage.cacheReadTokens ?? 0) + num(u.cache_read_input_tokens)
      acc.usage.cacheWriteTokens = (acc.usage.cacheWriteTokens ?? 0) + num(u.cache_creation_input_tokens)
    }
    return []
  }
  if (type === 'content_block_start') {
    const block = json.content_block as Json | undefined
    if (block?.type === 'tool_use') {
      acc.currentTool = { id: String(block.id ?? ''), name: String(block.name ?? ''), json: '' }
    }
    return []
  }
  if (type === 'content_block_delta') {
    const delta = json.delta as Json | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      acc.text += delta.text
      return [{ type: 'text-delta', text: delta.text }]
    }
    if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && acc.currentTool) {
      acc.currentTool.json += delta.partial_json
    }
    // thinking_delta → reasoning-delta：思考是过程可见性，不进正文、不落 store。
    // signature_delta 是思考块的签名校验（API 完整性用），对展示无意义，丢。
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
      return [{ type: 'reasoning-delta', text: delta.thinking }]
    }
    return []
  }
  if (type === 'content_block_stop') {
    const cur = acc.currentTool
    if (!cur) return []
    acc.currentTool = null
    const input = safeInput(cur.json)
    acc.toolUses.push({ id: cur.id, name: cur.name, input })
    return [{ type: 'tool-call', id: cur.id, name: cur.name, input }]
  }
  if (type === 'message_delta') {
    const u = (json as Json).usage as Json | undefined
    if (u) acc.usage.outputTokens += num(u.output_tokens)
    return []
  }
  if (type === 'error') {
    const msg = (json.error as Json | undefined)?.message
    return [{ type: 'error', error: new Error(`Anthropic 流内错误：${String(msg ?? '未知')}`) }]
  }
  return []
}

async function* complete(cfg: AnthropicConfig, req: CompletionRequest): AsyncIterable<CompletionEvent> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (req.signal?.aborted) {
    yield { type: 'error', error: new Error('已取消') }
    return
  }
  req.signal?.addEventListener('abort', onAbort, { once: true })

  const { system, messages } = toAnthropicPayload(req.messages)
  const tools = toAnthropicTools(req.tools)
  const acc: StreamAccum = {
    text: '',
    toolUses: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    currentTool: null,
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    let response: Response
    try {
      response = await fetch(`${trimBaseUrl(cfg.baseUrl ?? 'https://api.anthropic.com')}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': cfg.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: cfg.model,
          system,
          messages,
          tools,
          max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: true,
        }),
        signal: controller.signal,
      })
    } catch (e) {
      yield {
        type: 'error',
        error: controller.signal.aborted ? new Error('已取消') : new Error(`无法连接 AI 服务：${errorMessage(e)}`),
      }
      return
    }

    if (!response.ok) {
      let body = ''
      try {
        body = await response.text()
      } catch { /* 正文读不到就空 */ }
      if (body.length > 600) body = body.slice(0, 600) + '…'
      yield { type: 'error', error: new Error(`API 返回错误 ${response.status} ${response.statusText}：${body}`) }
      return
    }

    let fatal: Error | null = null
    reader = response.body!.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    for (;;) {
      const { value, done: streamDone } = await reader.read()
      if (value) {
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          for (const ev of processLine(line, acc)) {
            if (ev.type === 'error') {
              fatal = ev.error
              break
            }
            yield ev
          }
          if (fatal) break
        }
      }
      if (streamDone || fatal) break
    }
    if (fatal) {
      // 流式失败且尚未发出任何正文 → 降级非流式重试一次（对齐源码 onStreamingFallback 的容错思路）
      if (acc.text === '' && acc.toolUses.length === 0) {
        const retry = await completeNonStreaming(cfg, system, messages, tools, controller.signal)
        if (retry) {
          yield { type: 'done', message: retry.message, usage: retry.usage }
          return
        }
      }
      yield { type: 'error', error: fatal }
      return
    }

    // 无正文也无工具调用 = 流白跑（网关吞正文等异常）。先降级非流式试一次，再按错误收尾，
    // 不让调用方拿到空 done
    if (acc.text === '' && acc.toolUses.length === 0) {
      const retry = await completeNonStreaming(cfg, system, messages, tools, controller.signal)
      if (retry) {
        yield { type: 'done', message: retry.message, usage: retry.usage }
        return
      }
      yield { type: 'error', error: new Error('Anthropic 流正常结束但既无正文也无工具调用') }
      return
    }
    // 个别兼容网关不回 usage：按字符估（与 memory/agent.ts 的 /4 口径一致），记账不留 0
    if (acc.usage.inputTokens === 0 && acc.usage.outputTokens === 0) {
      acc.usage.inputTokens = estimateTokens(JSON.stringify(messages).length)
      acc.usage.outputTokens = estimateTokens(acc.text.length)
    }

    const content: Message['content'] = []
    if (acc.text) content.push({ type: 'text', text: acc.text })
    for (const t of acc.toolUses) content.push({ type: 'toolUse', id: t.id, name: t.name, input: t.input })
    yield {
      type: 'done',
      message: { role: 'assistant', content, meta: { provider: 'anthropic', model: cfg.model, usage: acc.usage } },
      usage: acc.usage,
    }
  } catch (e) {
    yield {
      type: 'error',
      error: controller.signal.aborted ? new Error('已取消') : new Error(`连接中断：${errorMessage(e)}`),
    }
  } finally {
    req.signal?.removeEventListener('abort', onAbort)
    try {
      await reader?.cancel()
    } catch { /* 流已关 */ }
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}
