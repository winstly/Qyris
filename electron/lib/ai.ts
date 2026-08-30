/**
 * AI 代理 —— OpenAI 兼容（/chat/completions）+ Anthropic（/v1/messages）双协议。
 * 前端统一用 OpenAI 格式的 messages/tools；选 Anthropic 时在主进程内做协议转换。
 * Key 在主进程内解密直用，明文不经过渲染层。
 */
import { emitToRenderer } from './emitter'
import { getSecretInternal } from './secrets'
import { errorMessage } from './util'

const SECRET_ACCOUNT = 'api_key'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 8192

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export interface AiCompletion {
  content: string | null
  /** 模型的思考过程（reasoning_content / reasoning），有则下发 */
  reasoning: string | null
  toolCalls: AiToolCall[]
  finishReason: string | null
}

type Json = Record<string, any>

const aborts = new Map<string, AbortController>()

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') // 剥尾斜杠即用，不拼任何路径
}

/** 请求级取消：fetch/读流的 await 会以 AbortError 抛出，走"已取消"路径 */
export function aiCancel(requestId: string): void {
  aborts.get(requestId)?.abort()
}

function cancelled(controller: AbortController, e: unknown): boolean {
  return controller.signal.aborted && e instanceof Error && e.name === 'AbortError'
}

export async function aiChatStream(
  requestId: string, provider: string, baseUrl: string, model: string, messages: unknown, tools: unknown,
): Promise<AiCompletion> {
  const key = await getSecretInternal(SECRET_ACCOUNT)
  if (!key) throw new Error('尚未配置 API Key，请打开设置面板填写（将存入系统 keychain）')
  if (provider === 'anthropic') {
    return anthropicChatStream(requestId, key, baseUrl, model, messages, tools)
  }
  return openaiChatStream(requestId, key, baseUrl, model, messages, tools)
}

// ---------------- OpenAI 兼容后端 ----------------

async function openaiChatStream(
  requestId: string, key: string, baseUrl: string, model: string, messages: unknown, tools: unknown,
): Promise<AiCompletion> {
  const controller = new AbortController()
  aborts.set(requestId, controller)

  let response: Response
  try {
    response = await fetch(`${trimBaseUrl(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: true }), // tools 恒在，可为 null
      signal: controller.signal,
    })
  } catch (e) {
    aborts.delete(requestId)
    if (cancelled(controller, e)) throw new Error('已取消')
    throw new Error(`无法连接 AI 服务：${errorMessage(e)}`)
  }

  if (!response.ok) {
    aborts.delete(requestId)
    let body = ''
    try {
      body = await response.text()
    } catch {
      /* 正文读不到就空 */
    }
    if (body.length > 600) body = body.slice(0, 600) + '…' // 按字符截 600
    throw new Error(`API 返回错误 ${response.status} ${response.statusText}：${body}`)
  }

  let content = ''
  let reasoning = ''
  const slots: AiToolCall[] = []
  let finishReason: string | null = null
  let done = false

  const processLine = (rawLine: string): void => {
    const line = rawLine.trimEnd()
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      done = true
      return
    }
    if (!data) return
    let json: Json
    try {
      json = JSON.parse(data) as Json
    } catch {
      return
    }
    const choice = json?.choices?.[0] as Json | undefined
    if (!choice) return

    const delta = (choice.delta ?? {}) as Json
    const text = delta.content
    if (typeof text === 'string' && text.length > 0) {
      content += text
      emitToRenderer('ai-delta', { requestId, delta: text })
    }
    // 思考过程：兼容 DeepSeek 系 `reasoning_content` 与 OpenAI o 系 `reasoning`
    const think =
      typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' && delta.reasoning.length > 0
          ? delta.reasoning
          : ''
    if (think) {
      reasoning += think
      emitToRenderer('ai-reasoning', { requestId, delta: think })
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason

    const tcs = delta.tool_calls
    if (Array.isArray(tcs)) {
      for (const tc of tcs as Json[]) {
        const idx = typeof tc?.index === 'number' ? tc.index : 0
        while (slots.length <= idx) slots.push({ id: '', name: '', arguments: '' })
        const slot = slots[idx]
        if (typeof tc?.id === 'string' && tc.id.length > 0) slot.id = tc.id // id 覆盖
        if (typeof tc?.function?.name === 'string') slot.name += tc.function.name // name 追加
        if (typeof tc?.function?.arguments === 'string') slot.arguments += tc.function.arguments // arguments 追加
      }
    }
  }

  try {
    const reader = response.body!.getReader()
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
          processLine(line)
          if (done) break
        }
      }
      if (streamDone || done) break
    }
  } catch (e) {
    aborts.delete(requestId)
    if (cancelled(controller, e)) throw new Error('已取消')
    throw new Error(`连接中断：${errorMessage(e)}`)
  }
  aborts.delete(requestId)

  return {
    content: content.length > 0 ? content : null,
    reasoning: reasoning.length > 0 ? reasoning : null,
    toolCalls: slots.filter((s) => s.name.length > 0),
    finishReason,
  }
}

// ---------------- Anthropic 后端 ----------------

/** OpenAI messages/tools → Anthropic system + messages（tool_use/tool_result 块） */
function toAnthropicPayload(messagesIn: unknown): { system: string | null; messages: Record<string, unknown>[] } {
  const msgs = (Array.isArray(messagesIn) ? messagesIn : []) as Json[]
  const system = msgs
    .filter((m) => m?.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n\n') || null

  const out: Record<string, unknown>[] = []
  let i = 0
  while (i < msgs.length) {
    const m = msgs[i]
    const role = m?.role
    if (role === 'system') {
      i++
    } else if (role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : '' })
      i++
    } else if (role === 'assistant') {
      const tcs = Array.isArray(m.tool_calls) ? (m.tool_calls as Json[]) : []
      if (tcs.length) {
        const blocks: Record<string, unknown>[] = []
        if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of tcs) {
          let input: Json = {}
          try {
            input = JSON.parse(typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}')
          } catch {
            input = {}
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name ?? '', input })
        }
        out.push({ role: 'assistant', content: blocks })
      } else {
        out.push({ role: 'assistant', content: typeof m.content === 'string' ? m.content : '' })
      }
      i++
    } else if (role === 'tool') {
      const results: Record<string, unknown>[] = []
      while (i < msgs.length && msgs[i]?.role === 'tool') {
        results.push({
          type: 'tool_result',
          tool_use_id: (msgs[i] as Json).tool_call_id ?? '',
          content: typeof msgs[i].content === 'string' ? msgs[i].content : '',
        })
        i++
      }
      out.push({ role: 'user', content: results })
    } else {
      i++
    }
  }
  return { system, messages: out }
}

function toAnthropicTools(toolsIn: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(toolsIn) || toolsIn.length === 0) return undefined
  return (toolsIn as Json[]).map((t) => ({
    name: t.function?.name ?? '',
    description: t.function?.description ?? '',
    input_schema: (t.function?.parameters as Json) ?? { type: 'object', properties: {} },
  }))
}

async function anthropicChatStream(
  requestId: string, key: string, baseUrl: string, model: string, messages: unknown, tools: unknown,
): Promise<AiCompletion> {
  const { system, messages: anthropicMessages } = toAnthropicPayload(messages)
  const anthropicTools = toAnthropicTools(tools)

  const controller = new AbortController()
  aborts.set(requestId, controller)

  let response: Response
  try {
    response = await fetch(`${trimBaseUrl(baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system,
        messages: anthropicMessages,
        tools: anthropicTools,
        max_tokens: MAX_TOKENS,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 4096 },
      }),
      signal: controller.signal,
    })
  } catch (e) {
    aborts.delete(requestId)
    if (cancelled(controller, e)) throw new Error('已取消')
    throw new Error(`无法连接 AI 服务：${errorMessage(e)}`)
  }

  if (!response.ok) {
    aborts.delete(requestId)
    let body = ''
    try {
      body = await response.text()
    } catch {
      /* 正文读不到就空 */
    }
    if (body.length > 600) body = body.slice(0, 600) + '…'
    throw new Error(`API 返回错误 ${response.status} ${response.statusText}：${body}`)
  }

  let content = ''
  let reasoning = ''
  const slots: AiToolCall[] = []
  let currentTool: AiToolCall | null = null
  let finishReason: string | null = null
  let done = false

  const processLine = (rawLine: string): void => {
    const line = rawLine.trimEnd()
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data) return
    let json: Json
    try {
      json = JSON.parse(data) as Json
    } catch {
      return
    }
    const type = json.type as string | undefined
    if (type === 'content_block_start') {
      const block = json.content_block as Json | undefined
      if (block?.type === 'tool_use') {
        currentTool = { id: (block.id as string) ?? '', name: (block.name as string) ?? '', arguments: '' }
        slots.push(currentTool)
      }
    } else if (type === 'content_block_delta') {
      const delta = json.delta as Json | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        content += delta.text
        emitToRenderer('ai-delta', { requestId, delta: delta.text })
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        reasoning += delta.thinking
        emitToRenderer('ai-reasoning', { requestId, delta: delta.thinking })
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && currentTool) {
        currentTool.arguments += delta.partial_json
      }
    } else if (type === 'message_delta') {
      const sr = (json.delta as Json | undefined)?.stop_reason
      if (typeof sr === 'string') finishReason = sr
    } else if (type === 'message_stop') {
      done = true
    }
  }

  try {
    const reader = response.body!.getReader()
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
          processLine(line)
          if (done) break
        }
      }
      if (streamDone || done) break
    }
  } catch (e) {
    aborts.delete(requestId)
    if (cancelled(controller, e)) throw new Error('已取消')
    throw new Error(`连接中断：${errorMessage(e)}`)
  }
  aborts.delete(requestId)

  return {
    content: content.length > 0 ? content : null,
    reasoning: reasoning.length > 0 ? reasoning : null,
    toolCalls: slots.filter((s) => s.name.length > 0),
    finishReason,
  }
}

export async function aiTestConnection(provider: string, baseUrl: string, model: string): Promise<string> {
  const key = await getSecretInternal(SECRET_ACCOUNT)
  if (!key) throw new Error('尚未配置 API Key')

  const headers = provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${key}` }

  // Anthropic：第三方兼容网关（阿里云/智谱）通常无 /v1/models，改测 /v1/messages 连通性
  if (provider === 'anthropic') {
    let response: Response
    try {
      response = await fetch(`${trimBaseUrl(baseUrl)}/v1/messages`, { method: 'GET', headers })
    } catch (e) {
      throw new Error(`连接失败：${errorMessage(e)}`)
    }
    if (response.status === 404) return '服务返回 404 —— /v1/messages 端点不存在，请检查 Base URL 路径'
    if (response.status === 401 || response.status === 403) return '服务可达，但返回 401/403 —— 请检查 API Key'
    return `连接成功（/v1/messages 端点可达，服务返回 ${response.status}）`
  }

  // OpenAI：验证 /models 模型列表
  let response: Response
  try {
    response = await fetch(`${trimBaseUrl(baseUrl)}/models`, { headers })
  } catch (e) {
    throw new Error(`连接失败：${errorMessage(e)}`)
  }
  if (response.status === 401 || response.status === 403) {
    return '服务可达，但返回 401/403 —— 请检查 API Key'
  }
  if (!response.ok) {
    return `服务返回 ${response.status}（连接成功，模型列表端点可能不可用，直接对话试试）`
  }
  let json: Json
  try {
    json = (await response.json()) as Json
  } catch {
    return '连接成功'
  }
  const data: Json[] = Array.isArray(json?.data) ? json.data : []
  const ids = data.filter((m) => typeof m?.id === 'string').map((m) => m.id)
  if (ids.length === 0) return '连接成功（服务未返回模型列表，直接对话试试）'
  const preview = ids.slice(0, 5).join('、') + (ids.length > 5 ? '...' : '')
  return ids.includes(model)
    ? `连接成功 · 模型列表中包含「${model}」`
    : `连接成功 · 模型列表中未见「${model}」：${preview}`
}