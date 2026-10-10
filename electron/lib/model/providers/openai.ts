/**
 * 模型生态 · OpenAI 兼容 /chat/completions provider（HTTP 直连）。
 * 由 ai-api.ts 的 openaiChatStream 改造而来，按 model/types.ts 契约输出事件流，
 * 最后一个事件恒为 done 或 error。
 *
 * Message 归一在此完成：统一的 toolUse → tool_calls、toolResult → role:'tool' 消息
 * （与 Anthropic 的 tool_result 块互为镜像，上层只见统一 Message）。
 *
 * 两个已知取舍：
 *  · stream_options.include_usage 恒发——done 必须带 usage。主流兼容端点（OpenAI/DeepSeek/
 *    Kimi/GLM/vLLM…）都认；个别极老网关可能 400，报文会带出原文便于定位。
 *  · reasoning_content / reasoning 增量直接丢：契约的 CompletionEvent 没有思考通道，
 *    旧实现的 ai-reasoning 事件在新层没有对应物。
 */
import type {
  CompletionEvent, CompletionRequest, Message, ModelProvider,
  ProviderCapabilities, ToolSchema, Usage,
} from '../types'
import { errorMessage } from '../../util'

type Json = Record<string, any>

export interface OpenAiConfig {
  apiKey: string
  /** 兼容端点各家不同，必填（剥尾斜杠后拼 /chat/completions，不代填任何路径） */
  baseUrl: string
  model: string
  /** 顶轮输出上限；仅在调用方显式给定时下发（兼容端点对 max_tokens 命名不一，不强塞） */
  maxTokens?: number
}

/** 首帧归一的用户引导帧（与 anthropic.ts 同款，两文件各自独立不能共享模块） */
const USER_ANCHOR_TEXT = '（此前内容已省略）请继续。'

const CAPABILITIES: ProviderCapabilities = {  streaming: true,
  tools: true,
  thinking: false, // 同 anthropic：契约无思考通道
  // response_format.json_schema 兼容端点支持面参差，不谎报；结构化由调用方走提示词兜底
  jsonSchema: false,
}

export function createOpenAiProvider(cfg: OpenAiConfig): ModelProvider {
  return {
    id: 'openai',
    capabilities: CAPABILITIES,
    async *complete(req) {
      yield* complete(cfg, req)
    },
  }
}

// ---------------- Message → OpenAI payload ----------------

/** 统一 Message → OpenAI messages。
 *  角色归一：system 原样、assistant 带 tool_calls、工具结果一律拆成独立 role:'tool' 消息
 *  （OpenAI 要求每个 tool_call_id 对应且仅对应一条 tool 消息），且排在同条消息的文本之前。 */
function toOpenAiMessages(messages: readonly Message[]): Json[] {
  const out: Json[] = []
  for (const m of messages) {
    const toolResults: Json[] = []
    const texts: string[] = []
    const images: { mediaType: string; data: string }[] = []
    const toolCalls: Json[] = []

    for (const part of m.content) {
      if (part.type === 'text') {
        if (part.text) texts.push(part.text)
      } else if (part.type === 'image') {
        images.push({ mediaType: part.mediaType, data: part.data })
      } else if (part.type === 'toolUse') {
        toolCalls.push({
          id: part.id,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
        })
      } else if (part.type === 'toolResult') {
        toolResults.push({ role: 'tool', tool_call_id: part.toolUseId, content: part.content })
      }
    }

    if (m.role === 'system') {
      if (texts.length > 0) out.push({ role: 'system', content: texts.join('\n\n') })
      continue
    }
    out.push(...toolResults)

    if (m.role === 'assistant') {
      const content = texts.join('\n\n')
      out.push({
        role: 'assistant',
        content: content || null, // 纯工具调用轮不能塞空串，部分端点会报错
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    // user / tool 轮里混入的文本与图片
    if (images.length > 0) {
      const parts: Json[] = []
      const text = texts.join('\n\n')
      if (text) parts.push({ type: 'text', text })
      for (const img of images) {
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })
      }
      out.push({ role: 'user', content: parts })
    } else if (texts.length > 0) {
      out.push({ role: 'user', content: texts.join('\n\n') })
    }
  }

  // 首帧归一（wire 层兜底，见 types.ts 铁律 3）：OpenAI 本体接受 assistant 开头，但兼容网关
  // 对首条角色要求不一（部分同样要求 user 开头，见 src/utils/chatHistory.ts windowSlice 注释）。
  // store.window() 的 user 锚点层是软的，超 USER_ANCHOR_SLACK 就把首条引导帧留给 wire 层。
  // 补帧对合法序列零影响；tool 配对完整性由 store 的结构层保证，本层不重复裁剪。
  if (out.length > 0 && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: USER_ANCHOR_TEXT })
  }
  return out
}

function toOpenAiTools(tools?: readonly ToolSchema[]): Json[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema as Json) ?? { type: 'object', properties: {} },
    },
  }))
}

function safeInput(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

// ---------------- SSE 流 → CompletionEvent ----------------

interface StreamAccum {
  text: string
  usage: Usage
  /** 按 index 分槽拼 tool_call 增量（id/name/arguments 都可能是碎片式下发） */
  slots: { id: string; name: string; arguments: string }[]
}

function processLine(rawLine: string, acc: StreamAccum): CompletionEvent[] {
  const line = rawLine.trimEnd()
  if (!line.startsWith('data:')) return []
  const data = line.slice(5).trim()
  if (data === '[DONE]') return []
  if (!data) return []
  let json: Json
  try {
    json = JSON.parse(data) as Json
  } catch {
    return []
  }

  if (json.usage) {
    const u = json.usage as Json
    acc.usage.inputTokens = num(u.prompt_tokens)
    acc.usage.outputTokens = num(u.completion_tokens)
    const details = u.prompt_tokens_details as Json | undefined
    acc.usage.cacheReadTokens = num(details?.cached_tokens)
    acc.usage.cacheWriteTokens = 0
  }

  const choice = json?.choices?.[0] as Json | undefined
  if (!choice) return []
  const delta = (choice.delta ?? {}) as Json

  const events: CompletionEvent[] = []
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    acc.text += delta.content
    events.push({ type: 'text-delta', text: delta.content })
  }
  const tcs = delta.tool_calls
  if (Array.isArray(tcs)) {
    for (const tc of tcs as Json[]) {
      const idx = typeof tc?.index === 'number' ? tc.index : acc.slots.length
      while (acc.slots.length <= idx) acc.slots.push({ id: '', name: '', arguments: '' })
      const slot = acc.slots[idx]
      if (typeof tc?.id === 'string' && tc.id.length > 0) slot.id = tc.id
      if (typeof tc?.function?.name === 'string') slot.name += tc.function.name
      if (typeof tc?.function?.arguments === 'string') slot.arguments += tc.function.arguments
    }
  }
  return events
}

async function* complete(cfg: OpenAiConfig, req: CompletionRequest): AsyncIterable<CompletionEvent> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (req.signal?.aborted) {
    yield { type: 'error', error: new Error('已取消') }
    return
  }
  req.signal?.addEventListener('abort', onAbort, { once: true })

  const messages = toOpenAiMessages(req.messages)
  const tools = toOpenAiTools(req.tools)
  const acc: StreamAccum = { text: '', usage: { inputTokens: 0, outputTokens: 0 }, slots: [] }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    const body: Json = {
      model: cfg.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (tools) body.tools = tools
    if (req.options?.temperature != null) body.temperature = req.options.temperature
    if (req.options?.maxTokens != null) body.max_tokens = req.options.maxTokens

    let response: Response
    try {
      response = await fetch(`${trimBaseUrl(cfg.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
      let text = ''
      try {
        text = await response.text()
      } catch { /* 正文读不到就空 */ }
      if (text.length > 600) text = text.slice(0, 600) + '…'
      yield { type: 'error', error: new Error(`API 返回错误 ${response.status} ${response.statusText}：${text}`) }
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
      yield { type: 'error', error: fatal }
      return
    }

    const toolUses = acc.slots
      .filter((s) => s.name.length > 0)
      // 缺 id 时按槽位序号合成：同名并行调用不能共用一个 tool_call_id
      .map((s, i) => ({ id: s.id || `call_${s.name}_${i}`, name: s.name, input: safeInput(s.arguments) }))
    if (acc.text === '' && toolUses.length === 0) {
      yield { type: 'error', error: new Error('OpenAI 流正常结束但既无正文也无工具调用') }
      return
    }
    if (acc.usage.inputTokens === 0 && acc.usage.outputTokens === 0) {
      acc.usage.inputTokens = estimateTokens(JSON.stringify(messages).length)
      acc.usage.outputTokens = estimateTokens(acc.text.length)
    }

    // tool-call 事件收口于流末（OpenAI 的 delta 只给碎片，结束才知道哪些 call 完整）
    for (const t of toolUses) yield { type: 'tool-call', id: t.id, name: t.name, input: t.input }

    const content: Message['content'] = []
    if (acc.text) content.push({ type: 'text', text: acc.text })
    for (const t of toolUses) content.push({ type: 'toolUse', id: t.id, name: t.name, input: t.input })
    yield {
      type: 'done',
      message: { role: 'assistant', content, meta: { provider: 'openai', model: cfg.model, usage: acc.usage } },
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
