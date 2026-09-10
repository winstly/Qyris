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
 *
 * 多工程常驻：状态按工程（projectPath）隔离。切到别的工程时，本工程的流式循环照常跑，
 * ai-delta/ai-reasoning/cli-tool-event/cli-tool-result/cli-agent-event 事件按 requestId → 工程路由回对应切片，切回即最新。
 *
 * 持久化模型：主进程 SQLite 逐条 write-through——只在稳定点落库（send 的用户消息 / finalize 收尾 /
 * 工具结果回填 / CLI 工具卡建档与回填 / 编辑重发截断），流式增量只在内存；消息有 seq = 已持久化，
 * pending 草稿永远没有 seq。历史不清除：clear() 只是开新会话（换 sessionId，epoch+1），
 * 更早历史由 loadOlder() 沿 keyset 游标向上翻页（见 MessageList 的触顶加载与视口锚定）。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import { buildSystemPrompt, TOOL_DEFS } from '@/services/ai'
import { executeTool } from '@/services/tools'
import { useSettingsStore } from './useSettingsStore'
import { useAppStore } from './useAppStore'
import { useStartupStore } from './useStartupStore'
import { useAgentStore, type AgentEntryTool } from './useAgentStore'
import { uid, safeParseObject } from '@/utils/id'
import { estimateTokens } from '@/utils/tokens'
import { buildHistory } from '@/utils/chatHistory'
import type {
  AiCompletion, ChatMessage, CliAgentEventPayload, MemoryHit, OAIMessage, ToolCall,
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

/** 单个工程的对话切片 */
export interface ChatSlice {
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
  /** token 用量：input=最近一次 prompt 大小；output=累计生成；agents=子 agent 累计（汇总展示） */
  usage: { input: number; output: number; agents?: { input: number; output: number } }
  /** 当前对话会话 id：AI 写文件的快照按会话分组，重置对话时换新 */
  sessionId: string
  /** CLI 模式：模型请求下一轮附带的 Skill id（按已扫描索引校验后写入） */
  cliSkills: string[]
  /** 最近一次记忆上下文取到的会话摘要原文（null = 暂无摘要）；CLI 模式随 aiChatStream 透传主进程前置 */
  lastSummary: string | null
  /** 是否还有更早的历史可向上翻页（keyset 分页游标，restore 时由主进程给出） */
  hasMoreOlder: boolean
  /** 已加载窗口里最老一条消息的 seq（messages_before 的翻页游标） */
  oldestSeq: number | null
  /** 正在向上翻页加载更早历史 */
  loadingOlder: boolean
}

function emptyChatSlice(): ChatSlice {
  return {
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
    cliSkills: [],
    lastSummary: null,
    hasMoreOlder: false,
    oldestSeq: null,
    loadingOlder: false,
  }
}

interface ChatState {
  /** 当前工程（useProjectStore.projectPath 的镜像） */
  current: string | null
  byProject: Record<string, ChatSlice>

  send: (text: string, meta?: import('@/types').MessageMeta) => Promise<void>
  setPendingElement: (el: PickedElement | null) => void
  appendDelta: (requestId: string, delta: string) => void
  appendReasoning: (requestId: string, delta: string) => void
  handleCliToolEvent: (requestId: string, id: string, name: string, phase: 'start' | 'stop', argumentsStr: string) => void
  handleCliToolResult: (requestId: string, id: string, content: string, isError: boolean, tokens?: { input: number; output: number }) => void
  handleCliAgentEvent: (p: CliAgentEventPayload) => void
  answerAsk: (answer: string) => void
  cancelProject: (project: string) => void
  cancel: () => void
  /** 清空当前对话（开新会话）。opts.deleteMessages=真删库内消息；skipFinalExtract=跳过收尾提取
   *  （勾选同时删记忆时用，防止提取把刚删的记忆立刻蒸回来） */
  clear: (opts?: { deleteMessages?: boolean; skipFinalExtract?: boolean }) => void
  /** 向上翻页：沿 oldestSeq 游标向主进程取更早历史并正序 prepend（触顶时由 MessageList 触发） */
  loadOlder: () => Promise<void>
  editAndResend: (messageId: string, newContent: string, meta?: import('@/types').MessageMeta) => Promise<void>
  restore: (messages: ChatMessage[], session: { sessionId: string; hasMoreOlder: boolean; oldestSeq: number | null }) => void
  ensureProject: (path: string) => void
  closeProject: (path: string) => void
}

/** 读某工程的切片 */
function getSlice(project: string): ChatSlice | undefined {
  return useChatStore.getState().byProject[project]
}

/** 写某工程的切片（函数式，不可变更新） */
export function patchSlice(project: string, patch: Partial<ChatSlice>): void {
  useChatStore.setState((s) => {
    const cur = s.byProject[project]
    if (!cur) return s
    return { byProject: { ...s.byProject, [project]: { ...cur, ...patch } } }
  })
}

/** 按 requestId 反查工程（事件只带 requestId，据此路由回发起请求的工程切片）。
 *  活跃请求走 activeRequestId 精确匹配；已结束请求走 completedRequestMap 残留映射——
 *  CLI 子进程 close 后 aiChatStream 立即 resolve，renderer 清空 activeRequestId，
 *  但子 agent 的 cli-agent-event / cli-tool-result 仍在 IPC 队列里排队，需要靠残留映射找到工程。 */
const completedRequestMap = new Map<string, string>() // requestId → project

/** 子 agent 线程 finishDebounce 计时器：每次 cli-agent-event 到达重置，停事件 300ms 后 finishThread */
const agentFinishTimers = new Map<string, ReturnType<typeof setTimeout>>() // threadId → timer
const COMPLETED_MAP_TTL = 30_000 // 30s 后自动清理

function findProjectByRequest(requestId: string): string | undefined {
  const s = useChatStore.getState()
  for (const [project, slice] of Object.entries(s.byProject)) {
    if (slice.activeRequestId === requestId) return project
  }
  // 回退：已结束请求的残留映射
  return completedRequestMap.get(requestId)
}

/** 标记请求完成但不立即清除映射（IPC 残留事件仍需路由） */
function markRequestCompleted(requestId: string, project: string): void {
  completedRequestMap.set(requestId, project)
  setTimeout(() => completedRequestMap.delete(requestId), COMPLETED_MAP_TTL)
}

export const useChatStore = create<ChatState>()((set, get) => ({
  current: null,
  byProject: {},

  ensureProject: (path) => {
    set((s) => ({
      byProject: s.byProject[path] ? s.byProject : { ...s.byProject, [path]: emptyChatSlice() },
      current: path,
    }))
  },

  closeProject: (path) => {
    // 会话收尾提取：关工程 = 会话终止，趁旧 sessionId 还在手先通知（fire-and-forget）
    const cur = get().byProject[path]
    if (cur && cur.messages.length > 0) void api.sessionEnded(path, cur.sessionId).catch(() => {})
    set((s) => {
      const byProject = { ...s.byProject }
      delete byProject[path]
      return { byProject, current: s.current === path ? null : s.current }
    })
  },

  send: async (text, meta) => {
    const project = get().current
    if (!project) return
    const cur = getSlice(project)
    if (!cur || (cur.status !== 'idle' && cur.status !== 'error')) return
    const trimmed = text.trim()
    if (!trimmed && !meta?.element) return
    const el = meta?.element
    const content = el
      ? `[用户选中的预览页元素]\n选择器: ${el.selector}\n标签: ${el.tag}${el.id ? `\nID: ${el.id}` : ''}${el.text ? `\n文本: ${el.text}` : ''}${trimmed ? `\n\n${trimmed}` : ''}`
      : trimmed
    const userMsg: ChatMessage = { id: uid(), role: 'user', content, meta }
    patchSlice(project, { messages: [...cur.messages, userMsg], status: 'streaming', cancelled: false, pendingElement: null })
    // 稳定点：用户消息立即落库，seq 由 append 返回后回挂
    persistUpsert(project, userMsg)
    await runAgentLoop(project)
  },

  setPendingElement: (el) => {
    const project = get().current
    if (project) patchSlice(project, { pendingElement: el })
  },

  appendDelta: (requestId, delta) => {
    const project = findProjectByRequest(requestId)
    if (!project) return
    const s = getSlice(project)
    if (!s || s.cancelled) return
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1] as ChatMessage | undefined
    const kind = assistantTailKind(last)
    if (kind === 'draft') {
      msgs[msgs.length - 1] = { ...last!, content: last!.content + delta }
    } else {
      if (!delta.trim()) return
      if (kind === 'thinking') {
        msgs[msgs.length - 1] = { ...last!, content: delta, pending: true }
      } else {
        msgs.push({ id: uid(), role: 'assistant', content: delta, pending: true })
      }
    }
    patchSlice(project, {
      messages: msgs,
      usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
    })
  },

  appendReasoning: (requestId, delta) => {
    const project = findProjectByRequest(requestId)
    if (!project) return
    const s = getSlice(project)
    if (!s || s.cancelled) return
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1] as ChatMessage | undefined
    const kind = assistantTailKind(last)
    if (kind === 'thinking' || kind === 'draft') {
      msgs[msgs.length - 1] = { ...last!, reasoning: (last!.reasoning ?? '') + delta }
    } else {
      if (!delta.trim()) return
      const collapsed = msgs.map((m) => (m.role === 'assistant' && m.pending ? { ...m, pending: false } : m))
      collapsed.push({ id: uid(), role: 'assistant', content: '', reasoning: delta })
      patchSlice(project, {
        messages: collapsed,
        usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
      })
      return
    }
    patchSlice(project, {
      messages: msgs,
      usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
    })
  },

  handleCliToolEvent: (requestId, id, name, phase, argumentsStr) => {
    const project = findProjectByRequest(requestId)
    if (!project) return
    let created: ChatMessage | undefined
    useChatStore.setState((s) => {
      const cur = s.byProject[project]
      if (!cur || cur.cancelled) return s
      let messages: ChatMessage[]
      if (phase === 'start') {
        const tc: ToolCall = { id, name, args: safeParseObject(argumentsStr), status: 'running' }
        created = { id: uid(), role: 'assistant', content: '', toolCalls: [tc] }
        messages = [...cur.messages, created]
      } else {
        // stop 仅代表指令输入组装完成、工具尚未执行完：只回填参数，状态由 handleCliToolResult 收口
        messages = [...cur.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          const tcs = messages[i].toolCalls
          if (tcs?.some((tc) => tc.id === id)) {
            messages[i] = { ...messages[i], toolCalls: tcs.map((tc) => tc.id === id ? { ...tc, args: safeParseObject(argumentsStr) } : tc) }
            break
          }
        }
      }
      return { byProject: { ...s.byProject, [project]: { ...cur, messages } } }
    })
    // 稳定点：CLI 工具卡建档即落库（结果随后以 patch 回填同一行）
    if (created) persistUpsert(project, created)
    // CLI 子 agent 派发卡（Agent/Task）：在 agent 面板建档，列表与实时转录随后由 cli-agent-event 驱动
    if (phase === 'start' && (name === 'Agent' || name === 'Task') && !getSlice(project)?.cancelled) {
      const args = safeParseObject(argumentsStr)
      const stype = String(args.subagent_type ?? 'general-purpose')
      const [threadId] = useAgentStore.getState().createBatch(
        id,
        [{ title: String(args.description ?? '').trim() || stype, tier: 'CLI', model: stype }],
        project,
      )
      if (threadId) useAgentStore.getState().beginThread(threadId, project)
    }
  },

  /** CLI 工具结果回填：状态收口 + 结果/摘要入卡并记录 toolResults（供历史重建）。
   *  Agent/Task 工具结果分两种：
   *  - async 派发确认（"Async agent launched successfully"）：工具调用本身完成（主卡 done），
   *    但子 agent 转入后台运行——线程保持 running，等完成通知（同 id 的第二个 tool_result）再收口
   *  - 同步结果 / async 完成通知：权威完成信号，立即 finishThread + 收口残留 running entry */
  handleCliToolResult: (requestId, id, content, isError, tokens) => {
    const project = findProjectByRequest(requestId)
    if (!project) return
    if (getSlice(project)?.cancelled) return
    const result = content.length > 2000 ? content.slice(0, 2000) + '…' : content
    const isAsyncLaunch = /^Async agent launched successfully/i.test(content.trim())
    const agentSlice = useAgentStore.getState().byProject[project]
    const thread = agentSlice && Object.values(agentSlice.threads).find((t) => t.cardId === id)
    if (thread) {
      // 清掉可能残留的计时器
      const stale = agentFinishTimers.get(thread.id)
      if (stale) { clearTimeout(stale); agentFinishTimers.delete(thread.id) }
      if (!isAsyncLaunch) {
        useAgentStore.getState().finishThread(thread.id, isError ? 'error' : 'done', result, tokens, project)
        // 线程内仍 running 的工具 entry 一并收口（子 agent tool-result 事件丢失时防永久转圈）
        const staleRunning = thread.entries.filter((e): e is AgentEntryTool => e.kind === 'tool' && e.status === 'running')
        for (const e of staleRunning) {
          useAgentStore.getState().patchTool(thread.id, e.id, { status: isError ? 'error' : 'done', summary: '（随子任务收口）' }, project)
        }
      }
      // async 派发确认 → 线程保持 running，等后台完成通知
    }
    let updated: ChatMessage | undefined
    useChatStore.setState((s) => {
      const cur = s.byProject[project]
      if (!cur || cur.cancelled) return s
      const messages = cur.messages.map((m) => {
        if (!m.toolCalls?.some((tc) => tc.id === id)) return m
        updated = {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.id === id
              ? { ...tc, status: isError ? ('error' as const) : ('done' as const), resultSummary: firstLine(content, 80), result }
              : tc,
          ),
          toolResults: [...(m.toolResults ?? []), { toolCallId: id, content: result }],
        }
        return updated
      })
      if (!updated) return s
      return { byProject: { ...s.byProject, [project]: { ...cur, messages } } }
    })
    // 稳定点：工具结果回填整行覆写（若该卡还在 append 在途，等它收场再写）
    if (updated) persistAfterSettled(project, updated.id)
  },

  /** CLI 子 agent 实时转录：按 parentId 找到派发卡对应线程，文本/工具/结果分别入账。
   *  ⚠️ 线程 finish 只由 cli-tool-result（Agent 工具结果）驱动——子 agent 执行工具期间
   *  CLI 不发任何事件，静默 >300ms 是常态，不能作为完成信号（debounce 方案已证伪）。 */
  handleCliAgentEvent: (p) => {
    const project = findProjectByRequest(p.requestId)
    if (!project) return
    if (getSlice(project)?.cancelled) return
    const agentSlice = useAgentStore.getState().byProject[project]
    const thread = agentSlice && Object.values(agentSlice.threads).find((t) => t.cardId === p.parentId)
    if (!thread) return
    const store = useAgentStore.getState()
    console.log(`[cli-agent] ${p.kind} thread=${thread.id} id=${p.id ?? '-'}`)

    if (p.kind === 'text') {
      const text = (p.text ?? '').trim()
      if (text) store.appendText(thread.id, text, project)
    } else if (p.kind === 'tool') {
      const args = safeParseObject(p.arguments ?? '{}')
      store.appendTool(thread.id, {
        id: p.id || uid(),
        name: p.name ?? 'tool',
        summary: cliToolSummary(p.name ?? '', args),
        status: 'running',
        args,
      }, project)
    } else {
      const content = p.content ?? ''
      const detail = content.length > 2000 ? content.slice(0, 2000) + '…' : content
      store.patchTool(thread.id, p.id ?? '', { status: p.isError ? 'error' : 'done', summary: firstLine(content, 80), result: detail }, project)
    }
  },

  answerAsk: (answer) => {
    const project = get().current
    if (!project) return
    const s = getSlice(project)
    if (!s || !s.pendingAsk) return
    const askId = s.pendingAsk.id
    patchSlice(project, {
      answers: { ...s.answers, [askId]: answer },
      pendingAsk: null,
      status: 'tools',
    })
    askResolvers.get(project)?.(answer)
    askResolvers.delete(project)
  },

  cancelProject: (project) => {
    const cur = getSlice(project)
    if (!cur) return
    patchSlice(project, { cancelled: true })
    // 硬取消：通知主进程 abort 该请求的流（网络层中断，不再消耗响应）
    if (cur.status === 'streaming' && cur.activeRequestId) {
      void api.aiCancel(cur.activeRequestId).catch(() => {})
    }
    // 子 agent 在途请求 + 在途一次性命令硬中断
    void import('@/services/subagent')
      .then((m) => m.cancelActiveAgentRequests())
      .catch(() => {})
    void api.runOnceCancel().catch(() => {})
    // 若正卡在 askUserQuestion，解除挂起
    const s = getSlice(project)
    if (s && s.status === 'awaiting-user' && s.pendingAsk) {
      const askId = s.pendingAsk.id
      patchSlice(project, {
        answers: { ...s.answers, [askId]: '（已取消）' },
        pendingAsk: null,
        status: 'tools',
      })
      askResolvers.get(project)?.('（用户取消了本次提问）')
      askResolvers.delete(project)
    }
  },

  cancel: () => {
    const project = get().current
    if (project) get().cancelProject(project)
  },

  clear: (opts?: { deleteMessages?: boolean; skipFinalExtract?: boolean }) => {
    const project = get().current
    if (!project) return
    const cur = getSlice(project)
    if (!cur) return
    if (cur.status !== 'idle') get().cancel()
    if (opts?.deleteMessages) {
      // 真删除：清掉库内本会话全部消息（seq>0）。此时不做收尾提取——消息都要删了，蒸出的记忆违背预期
      void api.messagesTruncate(project, cur.sessionId, 0).catch(() => {})
    } else if (!opts?.skipFinalExtract && cur.messages.length > 0) {
      // 会话收尾提取：换代前旧 sessionId 还在手，通知主进程做收尾整理 + 短期晋升判断（fire-and-forget）。
      // skipFinalExtract（勾选删除记忆时）必须跳过：否则清空记忆后立刻从旧消息蒸出新记忆，等于没删
      void api.sessionEnded(project, cur.sessionId).catch(() => {})
    }
    // 开新会话：换 sessionId/epoch，旧消息保留但不再自动加载（saveCurrentSession 写 meta 表）
    const newSessionId = uid()
    patchSlice(project, {
      messages: [], status: 'idle', pendingAsk: null, activeRequestId: null,
      answers: {}, pendingElement: null, usage: { input: 0, output: 0 }, sessionId: newSessionId, cliSkills: [], epoch: cur.epoch + 1,
      lastSummary: null,
      hasMoreOlder: false, oldestSeq: null, loadingOlder: false,
    })
    // 持久化新 session ID 到 meta 表：messagesRecent 优先查它，不回退旧会话
    void api.saveCurrentSession(project, newSessionId).catch(() => {})
  },

  loadOlder: async () => {
    const project = get().current
    const cur = project ? getSlice(project) : undefined
    if (!project || !cur || cur.loadingOlder || !cur.hasMoreOlder || cur.oldestSeq === null) return
    const epoch = cur.epoch
    patchSlice(project, { loadingOlder: true })
    try {
      const resp = await api.messagesBefore(project, cur.sessionId, cur.oldestSeq)
      const s = getSlice(project)
      // 换代守卫：翻页期间 clear()/editAndResend() 换了代次，过期响应直接丢弃（prepend 不能复活已删消息）
      if (!s || s.epoch !== epoch) return
      patchSlice(project, {
        messages: [...resp.messages, ...s.messages],
        hasMoreOlder: resp.hasMore,
        oldestSeq: resp.oldestSeq,
      })
    } catch { /* 翻页失败静默：下次滚到顶可重试 */ } finally {
      const s = getSlice(project)
      if (s?.loadingOlder) patchSlice(project, { loadingOlder: false })
    }
  },

  editAndResend: async (messageId, newContent, meta) => {
    const project = get().current
    if (!project) return
    const cur = getSlice(project)
    if (!cur || (cur.status !== 'idle' && cur.status !== 'error')) return
    const trimmed = newContent.trim()
    if (!trimmed) return
    const idx = cur.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const finalMeta = meta ?? cur.messages[idx].meta
    // 内存与库同构：库侧覆写会清空 toolCalls/toolResults/reasoning（见下方 messagePatch），
    // 切片同步清空——否则重启前内存视图残留旧工具卡，与库不一致
    const messages = [
      ...cur.messages.slice(0, idx),
      { ...cur.messages[idx], content: trimmed, meta: finalMeta, reasoning: undefined, toolCalls: undefined, toolResults: undefined },
    ]
    patchSlice(project, {
      messages,
      status: 'streaming',
      cancelled: false,
      pendingAsk: null,
      activeRequestId: null,
      answers: {},
      cliSkills: [],
      epoch: cur.epoch + 1,
    })
    // DB 同步：截断被编辑消息之后的历史（该消息不是 pending，必有 seq），再把该行覆写为编辑后内容——
    // 编辑重发本来就丢掉原 toolCalls/后续消息（上面 slice），库与切片保持一致。
    // patch 失败必须告警：截断已落库而 patch 未落库 → 库内该消息仍是旧内容（重启后可见）。
    const edited = messages[messages.length - 1]
    if (edited.seq !== undefined) {
      const sessionId = cur.sessionId
      void api.messagesTruncate(project, sessionId, edited.seq)
        .catch((e) => { console.warn(`[chat] 编辑重发截断失败：${String(e)}`) })
        .then(() => api.messagePatch(project, sessionId, edited.id, {
          content: edited.content, reasoning: null, tool: { toolCalls: [], toolResults: [] },
        }).catch((e) => { console.warn(`[chat] 编辑重发 patch 失败（库内内容可能未更新）：${String(e)}`) }))
    }
    await runAgentLoop(project)
  },

  restore: (messages, session) => {
    const project = get().current
    if (!project) return
    patchSlice(project, {
      messages,
      status: 'idle',
      pendingAsk: null,
      activeRequestId: null,
      cancelled: false,
      pendingElement: null,
      usage: { input: 0, output: 0 },
      cliSkills: [],
      lastSummary: null,
      sessionId: session.sessionId,
      hasMoreOlder: session.hasMoreOlder,
      oldestSeq: session.oldestSeq,
    })
    // 恢复会话 token 用量（异步，不阻塞渲染）
    void api.loadSessionTokens(project, session.sessionId).then((t) => {
      const s = getSlice(project)
      if (s && s.sessionId === session.sessionId) {
        patchSlice(project, { usage: { ...s.usage, input: t.input, output: t.output } })
      }
    }).catch(() => {})
  },
}))

// ---------- 持久化 write-through ----------
// 只在稳定点逐条落库（主进程 SQLite），流式增量只在内存；消息有 seq = 已持久化。
// 全部 fire-and-forget + 静默吞错：库暂时落后于内存可接受，绝不阻塞对话主链路。

/** message_append 在途登记（msgId → 是否成功）：append 收场前该行不在库里，后续 patch 必须等它 */
const inflightAppends = new Map<string, Promise<boolean>>()

/** 用切片内最新消息状态整行覆写库行（content/reasoning/tool 全量） */
function persistPatchLatest(project: string, sessionId: string, msg: ChatMessage): Promise<void> {
  return api.messagePatch(project, sessionId, msg.id, {
    content: msg.content,
    reasoning: msg.reasoning ?? null,
    tool: { toolCalls: msg.toolCalls ?? [], toolResults: msg.toolResults ?? [] },
  }).then(() => undefined, () => { /* 落库失败静默 */ })
}

/** 稳定点落库统一入口：无 seq → append 新行并回挂 seq；有 seq → patch 原行 */
function persistUpsert(project: string, msg: ChatMessage): void {
  const sessionId = getSlice(project)?.sessionId
  if (!sessionId) return
  if (msg.seq !== undefined) {
    void persistPatchLatest(project, sessionId, msg)
    return
  }
  const p = api.messageAppend(project, sessionId, msg)
    .then((r) => {
      // 回挂 seq：按 id 定位（切片可能已被流式更新）；切片已换代找不到该消息则只当落库成功
      const s = getSlice(project)
      if (s) {
        const messages = s.messages.map((m) => (m.id === msg.id && m.seq === undefined ? { ...m, seq: r.seq } : m))
        if (messages !== s.messages) patchSlice(project, { messages })
      }
      return true
    })
    .catch(() => false)
  inflightAppends.set(msg.id, p)
  void p.then(() => { if (inflightAppends.get(msg.id) === p) inflightAppends.delete(msg.id) })
}

/** 等 append 收场后按 id 定位消息（失败/换代/找不到回 null）；persistAfterSettled 与 persistMessageMeta 共用 */
async function awaitSettledMsg(project: string, msgId: string): Promise<ChatMessage | null> {
  const sessionId = getSlice(project)?.sessionId
  if (!sessionId) return null
  const inflight = inflightAppends.get(msgId)
  if (inflight && !(await inflight)) return null
  const s = getSlice(project)
  if (!s || s.sessionId !== sessionId) return null
  return s.messages.find((m) => m.id === msgId) ?? null
}

/** 等该消息的 append 收场后再整行覆写（append 失败则行不存在，跳过）；等待期间会话已切换则放弃 */
function persistAfterSettled(project: string, msgId: string): void {
  void (async () => {
    const latest = await awaitSettledMsg(project, msgId)
    if (latest?.seq !== undefined) {
      const sessionId = getSlice(project)?.sessionId
      if (sessionId) await persistPatchLatest(project, sessionId, latest)
    }
  })()
}

/** 折叠扫描改写的既有消息（running→done/error）同步回库，避免重启后残留「执行中」 */
function persistSwept(project: string, swept: ChatMessage[]): void {
  for (const m of swept) {
    if (m.seq !== undefined) persistUpsert(project, m)
  }
}

/** 会话 token 用量持久化（fire-and-forget，runAgentLoop 每轮结束时调用） */
function persistTokens(project: string, epoch: number): void {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  void api.saveSessionTokens(project, s.sessionId, { input: s.usage.input, output: s.usage.output }).catch(() => {})
}

// ---------- Agent 循环 ----------

/** 稳定空切片，选择器兜底 */
const EMPTY_CHAT: ChatSlice = emptyChatSlice()

/** 取当前工程的对话切片（组件选择器用，返回稳定引用） */
export function selectCurrentChat(s: ChatState): ChatSlice {
  return (s.current && s.byProject[s.current]) || EMPTY_CHAT
}

/** 可重试的错误：网络类；业务类错误（鉴权、参数）不重试 */
function isRetryableError(msg: string): boolean {
  return /无法连接|连接中断|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|econnreset|fetch failed|网络|超时/i.test(msg)
}

/** 分片 sleep：每 500ms 检查一次取消，返回 true 表示被「停止」中断 */
function sleepInterruptible(project: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const step = 500
    let elapsed = 0
    const tick = (): void => {
      if (getSlice(project)?.cancelled) {
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

/** project → ask 的挂起 resolver（多工程并存时各自独立） */
const askResolvers = new Map<string, (v: string) => void>()

// ---------- 记忆上下文（P2）：会话摘要 + 长期记忆检索，防抖为每个 runAgentLoop 一次 ----------

/** 剥掉 Skill 指令前缀 / 元素注入前缀，取检索用纯文本（不必完美，够检索即可） */
function searchQueryOf(content: string): string {
  return content
    .replace(/^请先用 load_skill[^\n]*\n\n/s, '')
    .replace(/^\[用户选中的预览页元素\][^\n]*\n\n/s, '')
    .trim()
}

/** 单条记忆的注入行：content 截 80 字摘要 */
function memoryLine(h: MemoryHit): string {
  const digest = h.content.length > 80 ? h.content.slice(0, 80) + '…' : h.content
  return `- [${h.category}] ${h.title}：${digest}`
}

/** 引用 chip：把命中的记忆 id/title 写进最后一条 user 消息 meta.citations（纯 UI 元数据，不进 AI payload），并同步回库 */
function patchCitations(project: string, epoch: number, citations: { id: string; title: string }[]): void {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  const msgs = [...s.messages]
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      msgs[i] = { ...msgs[i], meta: { ...msgs[i].meta, citations } }
      patchSlice(project, { messages: msgs })
      persistMessageMeta(project, msgs[i].id)
      return
    }
  }
}

/** 引用 chip 落库：等 append 收场后 patch 完整 meta（失败静默） */
function persistMessageMeta(project: string, msgId: string): void {
  void (async () => {
    const latest = await awaitSettledMsg(project, msgId)
    if (!latest?.meta?.citations?.length) return
    const sessionId = getSlice(project)?.sessionId
    if (sessionId) void api.messagePatch(project, sessionId, msgId, { meta: latest.meta }).catch(() => {})
  })()
}

/**
 * 取本轮记忆上下文：工作记忆会话摘要 + 按最后一条 user 消息的长期记忆检索。
 * 每个 runAgentLoop 只调一次（防抖）；请求失败静默回 null，绝不阻塞对话主链路。
 * 返回摘要原文（CLI 模式经 aiChatStream 透传）与注入 system 区的两个文本块（均可为 null）；
 * 检索命中同时回写引用 chip。
 */
async function fetchMemoryContext(project: string, epoch: number, messages: ChatMessage[]): Promise<{
  summary: string | null
  summaryBlock: string | null
  memoryBlock: string | null
}> {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return { summary: null, summaryBlock: null, memoryBlock: null }
  let query = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { query = searchQueryOf(messages[i].content); break }
  }
  const [summary, searched] = await Promise.all([
    api.memorySessionContext(project, s.sessionId).then((r) => r.summary).catch(() => null),
    query ? api.memorySearch(query, project, 6).catch(() => null) : Promise.resolve(null),
  ])
  if (searched && searched.hits.length > 0) {
    patchCitations(project, epoch, searched.hits.map((h) => ({ id: h.id, title: h.title })))
  }
  return {
    summary,
    // 「【此前会话进展】」标题是 CLI 序列化路径（electron/lib/ai-cli.ts serializeConversation）的
    // 双拷贝契约——tsconfig 隔离无法共享常量，改动必须两处同步并跑 smoke:cli
    summaryBlock: summary ? `【此前会话进展】\n${summary}` : null,
    memoryBlock: searched && searched.hits.length > 0
      ? '【长期记忆（供参考，可能过时）】\n' + searched.hits.map(memoryLine).join('\n')
      : null,
  }
}

/** 记忆提取触发（fire-and-forget）：稳定点交给主进程滚动提取，会话已换代则丢弃 */
function fireMaybeExtract(project: string, epoch: number): void {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  void api.memoryMaybeExtract(project, s.sessionId).catch(() => {})
}

async function runAgentLoop(project: string) {
  const slice0 = getSlice(project)
  const epoch = slice0?.epoch ?? 0
  const messages = slice0?.messages ?? []
  const history = buildHistory(messages)
  const appState = useSettingsStore.getState()
  // 记忆上下文每轮循环只取一次：摘要/记忆块跨迭代复用，请求失败静默
  const { summary, summaryBlock, memoryBlock } = await fetchMemoryContext(project, epoch, messages)
  // 取记忆期间会话已换代（clear/editAndResend）：本循环整体作废
  if (getSlice(project)?.epoch !== epoch) return
  // 摘要存切片（跨工具轮迭代复用 + 可观测）；CLI 模式经 opts.sessionSummary/memoryBlock 透传主进程
  // （CLI 路径丢 system 消息，二者由 serializeConversation 前置进正文）；API 模式忽略 opts（已在 system）
  patchSlice(project, { lastSummary: summary })

  // CLI 模式：把上一轮模型请求附带的 Skill 以标记注入本轮首条 user 历史
  if (appState.settings.dispatchMode === 'claude-cli' && slice0 && slice0.cliSkills.length > 0) {
    const pending = slice0.cliSkills
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        history[i] = { ...history[i], content: `${history[i].content ?? ''}\n[附带 Skill：${pending.join(', ')}]` }
        break
      }
    }
  }

  // 工具调用不设轮数上限：由「停止生成」取消（cancelled 每轮检查）兜底
  let lastRequestId: string | null = null
  for (;;) {
    if (getSlice(project)?.cancelled) {
      finalizeDraft(project, '（已取消）', false, epoch)
      if (lastRequestId) markRequestCompleted(lastRequestId, project)
      patchSlice(project, { status: 'idle', activeRequestId: null })
      return
    }
    let inputTok = 0
    for (const m of history) {
      if (typeof m.content === 'string') inputTok += estimateTokens(m.content)
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) inputTok += estimateTokens(tc.function.arguments ?? '')
      }
    }
    patchSlice(project, { usage: { input: inputTok, output: getSlice(project)?.usage.output ?? 0 } })

    let completion: AiCompletion
    let attempt = 0
    for (;;) {
      if (getSlice(project)?.cancelled) {
        finalizeDraft(project, '（已取消）', false, epoch)
        patchSlice(project, { status: 'idle', activeRequestId: null })
        return
      }
      const requestId = uid()
      lastRequestId = requestId
      patchSlice(project, { status: 'streaming', activeRequestId: requestId })
      try {
        const { settings, skillMetas } = useSettingsStore.getState()
        const projectSkillMetas = useAppStore.getState().projectSkillMetas
        // 合并用户级 + 项目级 Skill（项目在前，用户在后）
        const allSkills = [...projectSkillMetas, ...skillMetas]
        // 单 system 消息合并：基础提示词 + 会话摘要（在前）+ 长期记忆（在后）
        const systemContent = [buildSystemPrompt(project, allSkills), summaryBlock, memoryBlock]
          .filter((b): b is string => !!b)
          .join('\n\n')
        const payload: OAIMessage[] = [
          { role: 'system', content: systemContent },
          ...history,
        ]
        completion = await api.aiChatStream(
          requestId, settings.provider, settings.baseUrl, settings.model, payload, TOOL_DEFS,
          settings.dispatchMode, project, { sessionSummary: summary, memoryBlock },
        )
        break
      } catch (e) {
        const msg = String(e)
        if (getSlice(project)?.cancelled) {
          finalizeDraft(project, '（已取消）', false, epoch)
          markRequestCompleted(requestId, project)
          patchSlice(project, { status: 'idle', activeRequestId: null })
          return
        }
        if (!isRetryableError(msg) || attempt >= 10) {
          finalizeDraft(project, msg, true, epoch)
          markRequestCompleted(requestId, project)
          patchSlice(project, { status: 'error', activeRequestId: null })
          return
        }
        attempt++
        patchSlice(project, { status: 'retrying', activeRequestId: null })
        const interrupted = await sleepInterruptible(project, 15000)
        if (interrupted || getSlice(project)?.cancelled) {
          finalizeDraft(project, '（已取消）', false, epoch)
          markRequestCompleted(requestId, project)
          patchSlice(project, { status: 'idle', activeRequestId: null })
          return
        }
      }
    }

    const assistantId = finalizeAssistant(project, completion, epoch)
    history.push(toHistoryEntry(completion))

    if (appState.settings.dispatchMode === 'claude-cli') {
      // 合并用户级 + 项目级 Skill 校验
      const projectMetas = useAppStore.getState().projectSkillMetas
      const knownSkills = new Set([...appState.skillMetas, ...projectMetas].map((m) => m.id))
      const skillReq = (completion.nextSkill ?? []).map((s) => s.trim()).filter((s) => s && knownSkills.has(s))
      const cmds = (completion.startCommands ?? [])
        .map((s) => ({
          name: String(s?.name ?? '').trim(),
          run: String(s?.run ?? '').trim(),
          url: typeof s?.url === 'string' && s.url.trim() ? s.url.trim() : undefined,
        }))
        .filter((s) => s.name && s.run)
      // [[START_COMMANDS]] 协议：AI 编译首次提交 + 发给 AI 修复后的修正均生效
      if (cmds.length > 0) {
        void useStartupStore.getState().setStartupCommands(cmds, project)
      }
      if (getSlice(project)?.epoch === epoch) patchSlice(project, { cliSkills: skillReq })
    }

    if (completion.toolCalls.length === 0) {
      if (lastRequestId) markRequestCompleted(lastRequestId, project)
      patchSlice(project, { status: 'idle', activeRequestId: null })
      // CLI 会话收尾：扫尾仍在 running 的 CLI 子 agent 线程（async 后台子 agent 的
      // 完成通知可能在 CLI 退出前未到达，会话结束即视为完成，防面板永久转圈）
      const agentSlice = useAgentStore.getState().byProject[project]
      if (agentSlice) {
        for (const t of Object.values(agentSlice.threads)) {
          if (t.tier === 'CLI' && t.status === 'running') {
            useAgentStore.getState().finishThread(t.id, 'done', '（CLI 会话结束，子任务收口）', undefined, project)
          }
        }
      }
      fireMaybeExtract(project, epoch)
      persistTokens(project, epoch)
      return
    }

    // 主 agent 继续执行工具调用：旧 requestId 的子 agent 事件可能还在 IPC 队列
    if (lastRequestId) markRequestCompleted(lastRequestId, project)
    patchSlice(project, { status: 'tools' })
    for (const tc of completion.toolCalls) {
      patchToolCard(project, tc.id, { status: 'running' }, epoch)
      let result: string
      let summary: string
      try {
        const args = safeParseObject(tc.arguments)
        if (tc.name === 'askUserQuestion') {
          const answer = await askUser(project, tc.id, String(args.question ?? '请回答'), parseOptions(args.options))
          result = `用户回答：${answer}`
          summary = answer
        } else {
          const out = await executeTool(tc.name, args, tc.id, project)
          result = out.result
          summary = out.summary
        }
      } catch (e) {
        result = `工具执行失败：${String(e)}`
        summary = '执行失败'
      }
      const ok = !result.startsWith('错误') && !result.startsWith('工具执行失败')
      patchToolCard(project, tc.id, {
        status: ok ? 'done' : 'error',
        resultSummary: summary,
        result: result.length > 2000 ? result.slice(0, 2000) + '…' : result,
      }, epoch)
      appendToolResult(project, assistantId, { toolCallId: tc.id, content: result }, epoch)
      history.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
    fireMaybeExtract(project, epoch)
  }
}

// ---------- 组装 OpenAI 历史 ----------

/** 结果摘要：首个非空行截断 */
function firstLine(s: string, cap: number): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > cap ? line.slice(0, cap) + '…' : line
}

/** CLI 子 agent 工具行摘要：优先代表性参数（与 ToolCallCard 的 target 提取同构），无名参回退工具名 */
function cliToolSummary(name: string, args: Record<string, unknown>): string {
  const raw = String(args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.url ?? args.query ?? '')
  const line = raw.split('\n')[0].trim()
  return (line || name).slice(0, 80)
}

// buildHistory / windowSlice 已抽到 utils/chatHistory.ts（纯函数，可被冒烟脚本直接断言）

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

function assistantTailKind(m: ChatMessage | undefined): 'draft' | 'thinking' | 'none' {
  if (!m || m.role !== 'assistant' || (m.toolCalls?.length ?? 0) > 0) return 'none'
  if (m.pending) return 'draft'
  return (m.reasoning ?? '') !== '' ? 'thinking' : 'none'
}

function stripStreamedPrefix(msgs: ChatMessage[], pendingIdx: number, content: string): string {
  let prefix = ''
  for (let i = pendingIdx - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant') break
    if (m.toolCalls?.length || !m.content) continue
    prefix = m.content + prefix
  }
  return prefix && content.startsWith(prefix) ? content.slice(prefix.length) : content
}

function collapseStreamingMessages(
  msgs: ChatMessage[], toolStatus: 'done' | 'error', exceptId?: string,
): { messages: ChatMessage[]; swept: ChatMessage[] } {
  const swept: ChatMessage[] = []
  let changed = false
  const out = msgs.map((m) => {
    if (m.role !== 'assistant') return m
    const sweepTools = m.id !== exceptId && (m.toolCalls?.some((tc) => tc.status === 'running') ?? false)
    if (!m.pending && !sweepTools) return m
    changed = true
    const next: ChatMessage = {
      ...m,
      pending: false,
      toolCalls: sweepTools
        ? m.toolCalls!.map((tc) => tc.status === 'running'
            ? {
                ...tc,
                status: toolStatus,
                ...(toolStatus === 'error' && !tc.resultSummary ? { resultSummary: '已中断' } : {}),
              }
            : tc)
        : m.toolCalls,
    }
    swept.push(next)
    return next
  })
  return changed ? { messages: out, swept } : { messages: msgs, swept }
}

function finalizeDraft(project: string, text: string, isError: boolean, epoch: number) {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  const msgs = [...s.messages]
  let pendingIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].pending) { pendingIdx = i; break }
  }
  let finalized: ChatMessage | undefined
  if (pendingIdx !== -1) {
    finalized = { ...msgs[pendingIdx], content: text || msgs[pendingIdx].content || '（无内容）', pending: false, error: isError }
    msgs[pendingIdx] = finalized
  } else if (text) {
    finalized = { id: uid(), role: 'assistant', content: text, error: isError }
    msgs.push(finalized)
  }
  const collapsed = collapseStreamingMessages(msgs, 'error')
  if (finalized || collapsed.messages !== msgs) {
    patchSlice(project, { messages: collapsed.messages })
  }
  // 稳定点：取消/错误收尾的消息此前未持久化 → append；被扫描改写的旧卡（running→error）→ patch
  if (finalized) persistUpsert(project, finalized)
  persistSwept(project, collapsed.swept)
}

function finalizeAssistant(project: string, completion: AiCompletion, epoch: number): string {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return ''

  const toolCalls: ToolCall[] = completion.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: safeParseObject(tc.arguments),
    status: 'running',
  }))

  let pendingIdx = -1
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'assistant' && s.messages[i].pending) { pendingIdx = i; break }
  }
  const draftOpen = pendingIdx !== -1
  const last = draftOpen ? s.messages[pendingIdx] : s.messages[s.messages.length - 1]

  let content = completion.content ?? ''
  if (draftOpen) content = stripStreamedPrefix(s.messages, pendingIdx, content)
  if (!content.trim() && !toolCalls.length) {
    content = (draftOpen ? last.content.trim() : '') || '（模型未返回内容）'
  }

  const reasoning = draftOpen ? (last.reasoning ?? undefined) : undefined

  if (draftOpen) {
    const updated: ChatMessage = { ...last, content, pending: false, toolCalls: [...(last.toolCalls ?? []), ...toolCalls] }
    const msgs = [...s.messages]
    msgs[pendingIdx] = updated
    const collapsed = collapseStreamingMessages(msgs, 'done', updated.id)
    patchSlice(project, { messages: collapsed.messages })
    // 稳定点：收尾消息落库（draft 未持久化 → append；已有 seq → patch）
    persistUpsert(project, updated)
    persistSwept(project, collapsed.swept)
    return updated.id
  }
  const msg: ChatMessage = { id: uid(), role: 'assistant', content, pending: false, toolCalls }
  if (reasoning) msg.reasoning = reasoning
  const collapsed = collapseStreamingMessages([...s.messages, msg], 'done', msg.id)
  patchSlice(project, { messages: collapsed.messages })
  persistUpsert(project, msg)
  persistSwept(project, collapsed.swept)
  // 孤儿思考消息（只有 reasoning、无 pending 标记，模型直接转工具调用时留下）随本稳定点补落库，否则永远不入库
  const prev = s.messages[s.messages.length - 1]
  if (
    prev && prev.role === 'assistant' && !prev.pending && prev.seq === undefined &&
    !prev.toolCalls?.length && (prev.reasoning ?? '').length > 0
  ) {
    persistUpsert(project, prev)
  }
  return msg.id
}

function patchToolCard(project: string, toolCallId: string, patch: Partial<ToolCall>, epoch: number) {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  patchSlice(project, {
    messages: s.messages.map((m) =>
      m.toolCalls?.some((t) => t.id === toolCallId)
        ? { ...m, toolCalls: m.toolCalls!.map((t) => (t.id === toolCallId ? { ...t, ...patch } : t)) }
        : m,
    ),
  })
}

function appendToolResult(project: string, messageId: string, entry: { toolCallId: string; content: string }, epoch: number) {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  let updated: ChatMessage | undefined
  patchSlice(project, {
    messages: s.messages.map((m) => {
      if (m.id !== messageId) return m
      updated = { ...m, toolResults: [...(m.toolResults ?? []), entry] }
      return updated
    }),
  })
  // 稳定点：工具结果整行覆写（含最新 toolCalls 状态）；该行的 append 若还在途则等它收场
  if (updated) persistAfterSettled(project, messageId)
}

// ---------- askUserQuestion ----------

function askUser(project: string, toolCallId: string, question: string, options: string[] | null): Promise<string> {
  return new Promise<string>((resolve) => {
    patchSlice(project, {
      status: 'awaiting-user',
      pendingAsk: { id: toolCallId, question, options },
    })
    askResolvers.set(project, resolve)
  })
}

function parseOptions(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const list = v.map(String).filter((s) => s.length > 0)
  return list.length ? list : null
}
