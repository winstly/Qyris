/**
 * 对话状态 + Agent 工具循环。
 *
 * 流程：send → 主进程流式补全（ai-delta 事件打字机）→ 返回 AiCompletion
 *   ├─ 无 tool_calls → 结束
 *   └─ 有 tool_calls → 逐个执行（askUserQuestion 会暂停等用户点击卡片）
 *        → 结果回填 history → 再次请求（轮数不设限，「停止生成」兜底）
 *
 * 取消：cancel() 通知主进程 abort 当前 SSE 请求（fetch 层网络硬中断），
 * aiChatStream 随即以「已取消」reject，循环按取消路径收尾。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import { buildSystemPrompt, TOOL_DEFS } from '@/services/ai'
import { executeTool } from '@/services/tools'
import { useAppStore } from './useAppStore'
import { uid, safeParseObject } from '@/utils/id'
import type {
  AiCompletion, ChatMessage, OAIMessage, ToolCall,
} from '@/types'

export type ChatStatus = 'idle' | 'streaming' | 'tools' | 'awaiting-user' | 'error' | 'retrying'

export interface PendingAsk {
  id: string
  question: string
  options: string[] | null
}

/** 预览页选取的元素（带到下轮对话的上下文） */
export interface PickedElement {
  selector: string
  tag: string
  id: string
  text: string
}

interface ChatState {
  messages: ChatMessage[]
  status: ChatStatus
  activeRequestId: string | null
  pendingAsk: PendingAsk | null
  /** askId → 用户选择（卡片回显已答状态） */
  answers: Record<string, string>
  cancelled: boolean
  /** 会话代次：清空对话时 +1，用于让在途的旧循环丢弃过期写入 */
  epoch: number
  /** 预览页选中的元素（发送下一条消息时附带进上下文） */
  pendingElement: PickedElement | null
  /** token 用量：input=最近一次 prompt 大小；output=累计生成 */
  usage: { input: number; output: number }
  /** 当前对话会话 id：AI 写文件的快照按会话分组，重置对话时换新 */
  sessionId: string

  send: (text: string, meta?: import('@/types').MessageMeta) => Promise<void>
  setPendingElement: (el: PickedElement | null) => void
  appendDelta: (requestId: string, delta: string) => void
  appendReasoning: (requestId: string, delta: string) => void
  answerAsk: (answer: string) => void
  cancel: () => void
  clear: () => void
  /** 编辑某条用户消息并重发：截断其后所有内容，重新跑 Agent 循环 */
  editAndResend: (messageId: string, newContent: string, meta?: import('@/types').MessageMeta) => Promise<void>
  /** 恢复历史会话（打开项目时从磁盘加载） */
  restore: (messages: ChatMessage[]) => void
}

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  status: 'idle',
  activeRequestId: null,
  pendingAsk: null,
  answers: {},
  cancelled: false,
  epoch: 0,
  pendingElement: null,
  usage: { input: 0, output: 0 },
  sessionId: uid(),

  send: async (text, meta) => {
    const { status } = get()
    if (status !== 'idle' && status !== 'error') return
    const trimmed = text.trim()
    if (!trimmed) return
    const el = get().pendingElement
    const content = el
      ? `[已选中预览元素]\n选择器: ${el.selector}\n标签: ${el.tag}${el.id ? `\nID: ${el.id}` : ''}${el.text ? `\n文本: ${el.text}` : ''}\n\n${trimmed}`
      : trimmed
    const userMsg: ChatMessage = { id: uid(), role: 'user', content, meta }
    set((s) => ({ messages: [...s.messages, userMsg], status: 'streaming', cancelled: false, pendingElement: null }))
    await runAgentLoop()
  },

  appendDelta: (requestId, delta) => {
    const s = get()
    if (s.cancelled || requestId !== s.activeRequestId) return
    const last = s.messages[s.messages.length - 1]
    if (last && last.role === 'assistant' && last.pending) {
      set({
        messages: [...s.messages.slice(0, -1), { ...last, content: last.content + delta }],
        usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
      })
    } else {
      // 尚无草稿且 delta 纯空白：不创建气泡（避免模型开头输出空行产生空白气泡）
      if (!delta.trim()) return
      set((s2) => ({
        messages: [...s2.messages, { id: uid(), role: 'assistant', content: delta, pending: true }],
        usage: { ...s2.usage, output: s2.usage.output + estimateTokens(delta) },
      }))
    }
  },

  appendReasoning: (requestId, delta) => {
    const s = get()
    if (s.cancelled || requestId !== s.activeRequestId) return
    const last = s.messages[s.messages.length - 1]
    if (last && last.role === 'assistant' && last.pending) {
      set({
        messages: [...s.messages.slice(0, -1), { ...last, reasoning: (last.reasoning ?? '') + delta }],
        usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
      })
    } else {
      // 思考先于正文到达：先建一个 content 空的草稿挂上 reasoning
      if (!delta.trim()) return
      set((s2) => ({
        messages: [...s2.messages, { id: uid(), role: 'assistant', content: '', reasoning: delta, pending: true }],
        usage: { ...s2.usage, output: s2.usage.output + estimateTokens(delta) },
      }))
    }
  },

  answerAsk: (answer) => {
    const s = get()
    if (!s.pendingAsk) return
    const askId = s.pendingAsk.id
    set((s2) => ({
      answers: { ...s2.answers, [askId]: answer },
      pendingAsk: null,
      status: 'tools',
    }))
    askResolver?.(answer)
    askResolver = null
  },

  cancel: () => {
    set({ cancelled: true })
    // 硬取消：通知主进程 abort 当前流式请求（网络层中断，不再消耗响应）
    const cur = get()
    if (cur.status === 'streaming' && cur.activeRequestId) {
      void api.aiCancel(cur.activeRequestId).catch(() => {})
    }
    // 若正卡在 askUserQuestion，解除挂起让循环走到下一轮的取消检查
    const s = get()
    if (s.status === 'awaiting-user' && s.pendingAsk) {
      const askId = s.pendingAsk.id
      set((s2) => ({
        answers: { ...s2.answers, [askId]: '（已取消）' },
        pendingAsk: null,
        status: 'tools',
      }))
      askResolver?.('（用户取消了本次提问）')
      askResolver = null
    }
  },

  clear: () => {
    // 若正在运行：先触发取消（cancelled 置 true + 硬中断主进程请求，让在途循环在下一检查点退出）；
    // 不在此复位 cancelled——运行中清空需保留 true 以终止旧循环，idle 时它本就是 false（下次 send 会重置）
    if (get().status !== 'idle') get().cancel()
    set((s) => ({
      messages: [], status: 'idle', pendingAsk: null, activeRequestId: null,
      answers: {}, pendingElement: null, usage: { input: 0, output: 0 }, sessionId: uid(), epoch: s.epoch + 1,
    }))
  },

  setPendingElement: (el) => set({ pendingElement: el }),

  editAndResend: async (messageId, newContent, meta) => {
    const s = get()
    if (s.status !== 'idle' && s.status !== 'error') return
    const trimmed = newContent.trim()
    if (!trimmed) return
    const idx = s.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    // 截断到该消息（更新内容），丢弃其后所有对话；epoch 自增让旧循环过期
    // 使用新 meta（如有），否则保留原 meta，让 buildHistory 能重建系统指令
    const finalMeta = meta ?? s.messages[idx].meta
    const messages = [
      ...s.messages.slice(0, idx),
      { ...s.messages[idx], content: trimmed, meta: finalMeta },
    ]
    set({
      messages,
      status: 'streaming',
      cancelled: false,
      pendingAsk: null,
      activeRequestId: null,
      answers: {},
      epoch: s.epoch + 1,
    })
    await runAgentLoop()
  },

  restore: (messages) =>
    set({
      messages,
      status: 'idle',
      pendingAsk: null,
      activeRequestId: null,
      cancelled: false,
      pendingElement: null,
      usage: { input: 0, output: 0 },
    }),
}))

// ---------- Agent 循环 ----------

/** 粗略 token 估算：ASCII 4 字符 / 非 ASCII（中日韩等）1 字符 ≈ 1 token */
function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

/** 可重试的错误：网络类（连接不通/中断/超时/DNS 等）；业务类错误（鉴权、参数）不重试 */
function isRetryableError(msg: string): boolean {
  return /无法连接|连接中断|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|econnreset|fetch failed|网络|超时/i.test(msg)
}

/** 分片 sleep：每 500ms 检查一次取消，返回 true 表示被「停止」中断 */
function sleepInterruptible(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const step = 500
    let elapsed = 0
    const tick = (): void => {
      if (useChatStore.getState().cancelled) {
        resolve(true)
        return
      }
      elapsed += step
      if (elapsed >= ms) resolve(false)
      else setTimeout(tick, step)
    }
    setTimeout(tick, step)
  })
}

let askResolver: ((v: string) => void) | null = null

async function runAgentLoop() {
  const store = useChatStore
  const epoch = store.getState().epoch
  const { messages } = store.getState()
  const history = buildHistory(messages)

  // 工具调用不设轮数上限（用户拍板）：由「停止生成」取消（cancelled 每轮检查）兜底
  for (;;) {
    // 已取消：不再发起下一轮请求
    if (store.getState().cancelled) {
      finalizeDraft('（已取消）', false, epoch)
      store.setState({ status: 'idle', activeRequestId: null })
      return
    }
    // 估算本轮输入 token（当前上下文的文本量）
    let inputTok = 0
    for (const m of history) {
      if (typeof m.content === 'string') inputTok += estimateTokens(m.content)
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) inputTok += estimateTokens(tc.function.arguments ?? '')
      }
    }
    store.setState((s) => ({ usage: { input: inputTok, output: s.usage.output } }))
    // 请求 + 失败重试：可重试错误（网络类）每 15s 重试一次，最多 10 次；全程可被「停止」打断
    let completion: AiCompletion
    let attempt = 0
    for (;;) {
      if (store.getState().cancelled) {
        finalizeDraft('（已取消）', false, epoch)
        store.setState({ status: 'idle', activeRequestId: null })
        return
      }
      const requestId = uid()
      store.setState({ status: 'streaming', activeRequestId: requestId })
      try {
        const { settings, projectPath, skillMetas } = useAppStore.getState()
        const payload: OAIMessage[] = [
          { role: 'system', content: buildSystemPrompt(projectPath, skillMetas) },
          ...history,
        ]
        completion = await api.aiChatStream(
          requestId, settings.provider, settings.baseUrl, settings.model, payload, TOOL_DEFS,
        )
        break
      } catch (e) {
        const msg = String(e)
        // 用户取消 → 不重试、不进异常态
        if (store.getState().cancelled) {
          finalizeDraft('（已取消）', false, epoch)
          store.setState({ status: 'idle', activeRequestId: null })
          return
        }
        // 不可重试错误 或 重试次数用尽 → 异常态
        if (!isRetryableError(msg) || attempt >= 10) {
          finalizeDraft(msg, true, epoch)
          store.setState({ status: 'error', activeRequestId: null })
          return
        }
        attempt++
        store.setState({ status: 'retrying', activeRequestId: null })
        const interrupted = await sleepInterruptible(15000)
        if (interrupted || store.getState().cancelled) {
          finalizeDraft('（已取消）', false, epoch)
          store.setState({ status: 'idle', activeRequestId: null })
          return
        }
      }
    }

    const assistantId = finalizeAssistant(completion, epoch)
    history.push(toHistoryEntry(completion))

    if (completion.toolCalls.length === 0) {
      store.setState({ status: 'idle', activeRequestId: null })
      return
    }

    // 逐个执行工具，结果回填到 assistant 消息与 history
    store.setState({ status: 'tools' })
    for (const tc of completion.toolCalls) {
      patchToolCard(tc.id, { status: 'running' }, epoch)
      let result: string
      let summary: string
      try {
        const args = safeParseObject(tc.arguments)
        if (tc.name === 'askUserQuestion') {
          const answer = await askUser(tc.id, String(args.question ?? '请回答'), parseOptions(args.options))
          result = `用户回答：${answer}`
          summary = answer
        } else {
          const out = await executeTool(tc.name, args)
          result = out.result
          summary = out.summary
        }
      } catch (e) {
        result = `工具执行失败：${String(e)}`
        summary = '执行失败'
      }
      const ok = !result.startsWith('错误') && !result.startsWith('工具执行失败')
      patchToolCard(tc.id, {
        status: ok ? 'done' : 'error',
        resultSummary: summary,
        result: result.length > 2000 ? result.slice(0, 2000) + '…' : result,
      }, epoch)
      appendToolResult(assistantId, { toolCallId: tc.id, content: result }, epoch)
      history.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }
}

// ---------- 组装 OpenAI 历史 ----------

function buildHistory(messages: ChatMessage[]): OAIMessage[] {
  const out: OAIMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      let content = m.content
      // 有 meta 时，确保系统指令存在（编辑重发可能只保留了用户文字）
      if (m.meta?.skills?.length && !content.includes('load_skill')) {
        const ids = m.meta.skills.map((s) => s.id).join(', ')
        const instr = m.meta.skills.length > 1
          ? `请先用 load_skill 依次加载以下 ${m.meta.skills.length} 个 Skill，全部加载后再执行：${ids}`
          : `请先用 load_skill 加载 Skill「${ids}」，再执行。`
        content = content ? `${instr}\n\n${content}` : instr
      }
      out.push({ role: 'user', content })
      continue
    }
    if (m.pending) continue // 流式中的半成品不进历史
    if (m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        })),
      })
      for (const tr of m.toolResults ?? []) {
        out.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content })
      }
    } else if (m.content) {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

function toHistoryEntry(c: AiCompletion): OAIMessage {
  return {
    role: 'assistant',
    content: c.content ?? null,
    tool_calls: c.toolCalls.length
      ? c.toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.arguments },
        }))
      : undefined,
  }
}

// ---------- 消息收尾辅助 ----------

/** 关闭流式草稿：错误 / 取消时以给定文本收尾 */
function finalizeDraft(text: string, isError: boolean, epoch: number) {
  const s = useChatStore.getState()
  if (s.epoch !== epoch) return // 会话已清空/换代：丢弃过期写入
  const last = s.messages[s.messages.length - 1]
  if (last && last.role === 'assistant' && last.pending) {
    useChatStore.setState({
      messages: [
        ...s.messages.slice(0, -1),
        { ...last, content: text || last.content || '（无内容）', pending: false, error: isError },
      ],
    })
  } else if (text) {
    useChatStore.setState({
      messages: [...s.messages, { id: uid(), role: 'assistant', content: text, error: isError }],
    })
  }
}

/** 补全返回后定稿：回填权威内容并挂上工具调用卡片，返回消息 id */
function finalizeAssistant(completion: AiCompletion, epoch: number): string {
  const s = useChatStore.getState()
  if (s.epoch !== epoch) return '' // 会话已清空/换代：丢弃过期写入
  const last = s.messages[s.messages.length - 1]
  const draftOpen = !!(last && last.role === 'assistant' && last.pending)

  const toolCalls: ToolCall[] = completion.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: safeParseObject(tc.arguments),
    status: 'running',
  }))

  let content = completion.content ?? ''
  // 纯空白内容按空处理：无工具卡片时显示占位文案，避免定稿出空白气泡
  if (!content.trim() && !toolCalls.length) {
    content = (draftOpen ? last.content.trim() : '') || '（模型未返回内容）'
  }

  if (draftOpen) {
    const updated: ChatMessage = { ...last, content, pending: false, toolCalls }
    useChatStore.setState({ messages: [...s.messages.slice(0, -1), updated] })
    return updated.id
  }
  const msg: ChatMessage = { id: uid(), role: 'assistant', content, pending: false, toolCalls }
  useChatStore.setState({ messages: [...s.messages, msg] })
  return msg.id
}

function patchToolCard(toolCallId: string, patch: Partial<ToolCall>, epoch: number) {
  if (useChatStore.getState().epoch !== epoch) return
  useChatStore.setState((s) => ({
    messages: s.messages.map((m) =>
      m.toolCalls?.some((t) => t.id === toolCallId)
        ? { ...m, toolCalls: m.toolCalls!.map((t) => (t.id === toolCallId ? { ...t, ...patch } : t)) }
        : m,
    ),
  }))
}

function appendToolResult(messageId: string, entry: { toolCallId: string; content: string }, epoch: number) {
  if (useChatStore.getState().epoch !== epoch) return
  useChatStore.setState((s) => ({
    messages: s.messages.map((m) =>
      m.id === messageId ? { ...m, toolResults: [...(m.toolResults ?? []), entry] } : m,
    ),
  }))
}

// ---------- askUserQuestion ----------

function askUser(toolCallId: string, question: string, options: string[] | null): Promise<string> {
  return new Promise<string>((resolve) => {
    useChatStore.setState({
      status: 'awaiting-user',
      pendingAsk: { id: toolCallId, question, options },
    })
    askResolver = resolve
  })
}

function parseOptions(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const list = v.map(String).filter((s) => s.length > 0)
  return list.length ? list : null
}
