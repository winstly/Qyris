import { useState } from 'react'
import type { ChatMessage } from '@/types'
import { IconClose } from '@/components/common/icons'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { AskUserCard } from './AskUserCard'
import { useChatStore } from '@/store/useChatStore'
import { useAppStore } from '@/store/useAppStore'

export function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return <UserMessage msg={msg} />
  }

  const askCalls = msg.toolCalls?.filter((tc) => tc.name === 'askUserQuestion') ?? []
  const otherCalls = msg.toolCalls?.filter((tc) => tc.name !== 'askUserQuestion') ?? []
  // 纯空白文本不算内容；思考过程也算内容（纯思考回复时也不出空壳）
  const hasText = msg.content.trim() !== ''
  const hasReasoning = (msg.reasoning ?? '').trim() !== ''

  return (
    <div className={`msg msg--ai ${msg.error ? 'msg--error' : ''}`}>
      {(hasText || hasReasoning || msg.pending) && (
        <div className="msg__bubble">
          {hasReasoning && <ReasoningBlock content={msg.reasoning!} pending={msg.pending} />}
          {hasText && <Markdown source={msg.content} />}
          {msg.pending && <span className="type-cursor" aria-label="正在输出" />}
        </div>
      )}

      {otherCalls.map((tc) => <ToolCallCard key={tc.id} call={tc} />)}
      {askCalls.map((tc) => <AskUserCard key={tc.id} call={tc} />)}
    </div>
  )
}

function ReasoningBlock({ content, pending }: { content: string; pending?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="reasoning">
      <button
        type="button"
        className="reasoning__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="reasoning__chevron">{open ? '▾' : '▸'}</span>
        <span>{pending ? '正在思考…' : '已深度思考'}</span>
      </button>
      {open && <div className="reasoning__body">{content}</div>}
    </div>
  )
}

/** 用户消息：hover 出「编辑」，编辑态可改后重发；编辑非末条时有回退提醒 */
function UserMessage({ msg }: { msg: ChatMessage }) {
  // 有 meta 时渲染卡片 + 只显示用户文字；无 meta 兼容旧消息
  const hasMeta = !!(msg.meta?.skills?.length || msg.meta?.projectStart)
  // 从原始 content 提取用户文字（系统指令在第一个 \n\n 之前）
  const userText = hasMeta
    ? (msg.meta?.projectStart ? null : msg.content.split('\n\n').slice(1).join('\n\n').trim() || null)
    : null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)
  const [editSkills, setEditSkills] = useState(msg.meta?.skills ?? [])
  // 该消息之后是否还有内容（决定是否要给「回退」提醒）
  const hasLater = useChatStore((s) => {
    const i = s.messages.findIndex((m) => m.id === msg.id)
    return i !== -1 && i < s.messages.length - 1
  })
  const busy = useChatStore((s) => s.status !== 'idle' && s.status !== 'error')

  // 编辑时只提取用户文字，隐藏系统指令
  const editableText = (() => {
    if (msg.meta?.projectStart) return ''
    if (msg.meta?.skills?.length) {
      return msg.content.split('\n\n').slice(1).join('\n\n').trim() || ''
    }
    // 兼容旧格式
    if (msg.content.startsWith('请先用 load_skill')) {
      const parts = msg.content.split('\n\n')
      return parts.length > 1 ? parts.slice(1).join('\n\n').trim() : ''
    }
    return msg.content
  })()

  const submit = async () => {
    const t = draft.trim()
    if (!t) return
    if (t === msg.content) {
      setEditing(false)
      return
    }
    if (hasLater) {
      const ok = await useAppStore.getState().showConfirm(
        '重新编辑并发送',
        '编辑这条消息会移除它之后的所有内容（AI 回复与后续对话），且不可撤销。确定继续吗？',
      )
      if (!ok) return
    }
    void useChatStore.getState().editAndResend(msg.id, t, editSkills.length > 0 ? { skills: editSkills } : undefined)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="msg msg--user">
        {/* 编辑态 skill 卡片（可删除） */}
        {editSkills.length > 0 && (
          <div className="msg__meta-cards">
            {editSkills.map((s) => (
              <div key={s.id} className="msg__meta-card">
                <span className="msg__meta-card-label">Skill</span>
                <span className="msg__meta-card-name">{s.name}</span>
                <button
                  className="msg__meta-card-remove"
                  onClick={() => setEditSkills((prev) => prev.filter((sk) => sk.id !== s.id))}
                  aria-label={`移除 ${s.name}`}
                  title={`移除 ${s.name}`}
                >
                  <IconClose size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        {msg.meta?.projectStart && (
          <div className="msg__meta-cards">
            <div className="msg__meta-card">
              <span className="msg__meta-card-label">启动</span>
              <span className="msg__meta-card-name">AI 探测并启动项目</span>
            </div>
          </div>
        )}
        <div className="msg__edit">
          <textarea
            className="msg__edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={Math.min(Math.max(draft.split('\n').length, 1), 8)}
            aria-label="编辑消息"
            autoFocus
          />
          <div className="msg__edit-actions">
            <span className="msg__edit-hint">Enter 发送 · Shift+Enter 换行</span>
            <button className="btn btn--ghost btn--sm" onClick={() => { setDraft(editableText); setEditSkills(msg.meta?.skills ?? []); setEditing(false) }}>取消</button>
            <button className="btn btn--primary btn--sm" onClick={() => void submit()} disabled={!draft.trim()}>重新发送</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="msg msg--user">
      {/* 系统级元数据卡片 */}
      {hasMeta && (
        <div className="msg__meta-cards">
          {msg.meta!.projectStart && (
            <div className="msg__meta-card">
              <span className="msg__meta-card-label">启动</span>
              <span className="msg__meta-card-name">AI 探测并启动项目</span>
            </div>
          )}
          {msg.meta!.skills?.map((s) => (
            <div key={s.id} className="msg__meta-card">
              <span className="msg__meta-card-label">Skill</span>
              <span className="msg__meta-card-name">{s.name}</span>
            </div>
          ))}
        </div>
      )}
      {/* 用户文字（有 meta 时只显示用户部分，纯系统指令不显示 bubble） */}
      {(!hasMeta || userText) && (
        <div className="msg__bubble">{hasMeta ? userText : msg.content}</div>
      )}
      {/* 系统级消息（纯启动/纯 Skill 无用户文字）不显示编辑按钮 */}
      {!(hasMeta && !userText) && (
        <button
          className="msg__edit-trigger"
          onClick={() => { setDraft(editableText); setEditSkills(msg.meta?.skills ?? []); setEditing(true) }}
          disabled={busy}
          title="编辑并重新发送"
        >
          编辑
        </button>
      )}
    </div>
  )
}