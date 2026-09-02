/**
 * 子任务 agent 的两块 UI：
 * - AgentPanel：dispatch_subtasks 工具卡片内的批次面板（进度 + 每个 agent 一行 + 行内展开实时转录）
 * - AgentView：对话面板的专注视图（通过头部切换器选中某个 agent 后整屏查看）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolCall } from '@/types'
import { useAgentStore, type AgentThread } from '@/store/useAgentStore'
import { fmtTok } from '@/utils/tokens'
import { IconAlert, IconBranch, IconCheck } from '@/components/common/icons'

export const AGENT_STATUS_LABEL: Record<string, string> = {
  pending: '待执行', running: '运行中', done: '完成', error: '异常', cancelled: '已取消',
}

/** 实时转录：文本轮次 + 工具调用入账，按 entries 顺序渲染。
 *  embedded=true（卡片内展开）不限高、不内部滚动，随内容自然生长交给外层消息列表滚动；
 *  全屏模式（专注视图）撑满面板高度、内部滚动。 */
export function AgentTranscript({ thread, embedded = false }: { thread: AgentThread; embedded?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const entryCount = thread.entries.length
  const status = thread.status

  // 新入账自动滚到底（仅在已展开/已挂载时）
  useEffect(() => {
    const el = ref.current
    if (el && !embedded) el.scrollTop = el.scrollHeight
  }, [entryCount, status, embedded])

  return (
    <div className={`agentview__scroll ${embedded ? 'agentview__scroll--embedded' : ''}`} ref={ref}>
      {entryCount === 0 && thread.status === 'running' && <div className="agentview__empty">启动中…</div>}
      {thread.entries.map((e, i) =>
        e.kind === 'text' ? (
          <div key={i} className="agentview__text">{e.content}</div>
        ) : (
          <div key={i} className="agentview__tool" data-status={e.status}>
            <code>{e.name}</code>
            <span>{e.summary}</span>
            {e.status === 'running' && <span className="spinner" aria-label="执行中" />}
          </div>
        ),
      )}
    </div>
  )
}

/** dispatch_subtasks 卡片内的批次面板 */
export function AgentPanel({ cardId }: { cardId: string }) {
  // selector 只取稳定引用；派生数组用 useMemo 计算
  const order = useAgentStore((s) => s.order)
  const threadsMap = useAgentStore((s) => s.threads)
  const threads = useMemo(
    () => order.map((id) => threadsMap[id]).filter((t): t is AgentThread => !!t && t.cardId === cardId),
    [order, threadsMap, cardId],
  )
  const selectThread = useAgentStore((s) => s.selectThread)
  const [openId, setOpenId] = useState<string | null>(null)

  if (threads.length === 0) return null
  const settled = threads.filter((t) => t.status !== 'pending' && t.status !== 'running').length

  return (
    <div className="agentpanel">
      <div className="agentpanel__progress">{settled}/{threads.length} 完成</div>
      {threads.map((t) => (
        <div key={t.id} className="agentpanel__item">
          <div className="agentpanel__rowline">
            <button
              className="agentpanel__row"
              onClick={() => setOpenId((v) => (v === t.id ? null : t.id))}
              aria-expanded={openId === t.id}
            >
              <span className="agentpanel__dot" data-status={t.status} />
              <span className="agentpanel__title">{t.title}</span>
              {(t.tokens.input > 0 || t.tokens.output > 0) && (
                <span className="agentpanel__meta" title="本子 agent 的 token 消耗">↑{fmtTok(t.tokens.input)} ↓{fmtTok(t.tokens.output)}</span>
              )}
              <span className="agentpanel__meta">{t.tier} · {t.model}</span>
              <span className="agentpanel__state" data-status={t.status}>{AGENT_STATUS_LABEL[t.status]}</span>
            </button>
            <button
              className="icon-btn agentpanel__focus"
              onClick={() => selectThread(t.id)}
              aria-label={`专注查看 ${t.title}`}
              title="在专注视图中查看执行进度"
            >
              <IconBranch size={12} />
            </button>
          </div>
          {openId === t.id && (
            <AgentTranscript thread={t} embedded />
          )}
        </div>
      ))}
    </div>
  )
}

/** dispatch_subtasks 的工具卡片（替换默认 ToolCallCard 渲染） */
export function AgentToolCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(() => call.status === 'running')

  return (
    <div className={`toolcard toolcard--${call.status} agentcard`}>
      <button className="toolcard__row agentcard__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="toolcard__icon"><IconBranch size={13} /></span>
        <span className="toolcard__text">子任务编排</span>
        <span className="toolcard__state">
          {call.resultSummary && <span className="toolcard__summary">{call.resultSummary}</span>}
          {call.status === 'running' && <span className="spinner" aria-label="执行中" />}
          {call.status === 'done' && <IconCheck size={12} />}
          {call.status === 'error' && <IconAlert size={12} />}
        </span>
      </button>
      {open && <AgentPanel cardId={call.id} />}
    </div>
  )
}

/** 专注视图：对话面板中整屏查看某个 agent 的实时进度 */
export function AgentView() {
  const thread = useAgentStore((s) => (s.activeThreadId ? s.threads[s.activeThreadId] : undefined))
  const selectThread = useAgentStore((s) => s.selectThread)

  if (!thread) return null

  return (
    <div className="agentview">
      <div className="agentview__head">
        <button className="btn btn--ghost btn--sm" onClick={() => selectThread(null)}>← 主对话</button>
        <span className="agentview__title">{thread.title}</span>
        {(thread.tokens.input > 0 || thread.tokens.output > 0) && (
          <span className="agentpanel__meta" title="本子 agent 的 token 消耗">↑{fmtTok(thread.tokens.input)} ↓{fmtTok(thread.tokens.output)}</span>
        )}
        <span className="agentpanel__meta">{thread.tier} · {thread.model}</span>
        <span className="agentpanel__state" data-status={thread.status}>{AGENT_STATUS_LABEL[thread.status]}</span>
      </div>
      <AgentTranscript thread={thread} />
    </div>
  )
}
