import { useState, useEffect } from 'react'
import type { ChatMessage, SkillMeta } from '@/types'
import { IconClose, IconCheck } from '@/components/common/icons'
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

/** 从消息 content 提取用户文字：仅当内容以 Skill 系统指令开头时剥掉首段（指令与用户文字以空行分隔）。
 *  不含指令前缀的消息整段都是用户文字，原样返回。 */
function extractUserText(content: string): string {
  if (content.startsWith('请先用 load_skill')) {
    return content.split('\n\n').slice(1).join('\n\n').trim()
  }
  return content.trim()
}

/** 用户消息：hover 出「编辑」，编辑态可改后重发；编辑非末条时有回退提醒 */
function UserMessage({ msg }: { msg: ChatMessage }) {
  // 有 meta 时渲染卡片 + 只显示用户文字；无 meta 兼容旧消息
  const hasMeta = !!(msg.meta?.skills?.length || msg.meta?.projectStart)
  const userText = hasMeta ? (msg.meta?.projectStart ? null : extractUserText(msg.content) || null) : null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)
  const [editSkills, setEditSkills] = useState(msg.meta?.skills ?? [])
  const skillMetas = useAppStore((s) => s.skillMetas)
  // Slash 命令菜单（编辑态支持 / 选 skill，与 ChatInput 一致）
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  // 该消息之后是否还有内容（决定是否要给「回退」提醒）
  const hasLater = useChatStore((s) => {
    const i = s.messages.findIndex((m) => m.id === msg.id)
    return i !== -1 && i < s.messages.length - 1
  })
  const busy = useChatStore((s) => s.status !== 'idle' && s.status !== 'error')

  // 编辑时只提取用户文字，隐藏系统指令（纯系统消息没有可编辑文字）
  const editableText = msg.meta?.projectStart ? '' : extractUserText(msg.content)
  const originalSkills = msg.meta?.skills ?? []

  const filteredSkills = slashOpen
    ? skillMetas.filter((s) => {
        if (!slashFilter) return true
        const q = slashFilter.toLowerCase()
        return s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
          || s.description.toLowerCase().includes(q) || s.triggers.some((t) => t.toLowerCase().includes(q))
      })
    : []

  const closeSlash = () => { setSlashOpen(false); setSlashFilter(''); setSlashIndex(0) }

  // 方向键导航时自动滚动到可见区域（与 ChatInput 一致）
  useEffect(() => {
    if (!slashOpen) return
    const el = document.querySelector('.slash-menu--edit .slash-menu__item--active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashOpen])

  /** 编辑态选/取消 skill（toggle）：已选的再选=移除；只剥掉 / 前缀保留原文 */
  const selectSkill = (skill: SkillMeta) => {
    closeSlash()
    setDraft((prev) => prev.startsWith('/') ? prev.slice(1) : prev)
    setEditSkills((prev) =>
      prev.some((s) => s.id === skill.id)
        ? prev.filter((s) => s.id !== skill.id)
        : [...prev, { id: skill.id, name: skill.name }],
    )
  }

  const submit = async () => {
    const t = draft.trim()
    if (!t) return
    // 文字没变且 skill 列表也没变 → 无需重发
    const skillsChanged = editSkills.length !== originalSkills.length ||
      editSkills.some((s, i) => s.id !== originalSkills[i]?.id)
    if (t === editableText && !skillsChanged) {
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
    void useChatStore.getState().editAndResend(msg.id, t, { skills: editSkills })
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
              <span className="msg__meta-card-name">AI 编译（识别启动命令）</span>
            </div>
          </div>
        )}
        <div className="msg__edit">
          <textarea
            className="msg__edit-textarea"
            value={draft}
            onChange={(e) => {
              const val = e.target.value
              setDraft(val)
              if (val.startsWith('/') && !slashOpen && skillMetas.length > 0) {
                setSlashOpen(true)
                setSlashFilter('')
              } else if (slashOpen) {
                if (!val.startsWith('/')) { closeSlash() }
                else {
                  const afterSlash = val.slice(1)
                  setSlashFilter(afterSlash.length <= 20 && !afterSlash.includes('，') ? afterSlash : '')
                }
              }
            }}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => Math.min(i + 1, filteredSkills.length - 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return }
                if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (slashOpen && filteredSkills[slashIndex]) { selectSkill(filteredSkills[slashIndex]); return }
                void submit()
              }
            }}
            rows={Math.min(Math.max(draft.split('\n').length, 1), 8)}
            aria-label="编辑消息"
            autoFocus
          />
          {/* Slash 菜单：在 textarea 下方正常流，容器自动滚动 */}
          {slashOpen && filteredSkills.length > 0 && (
            <div className="slash-menu slash-menu--edit" role="listbox" aria-label="选择 Skill">
              {filteredSkills.map((skill, i) => (
                <div
                  key={skill.id}
                  className={`slash-menu__item ${i === slashIndex ? 'slash-menu__item--active' : ''}`}
                  role="option"
                  aria-selected={i === slashIndex}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => selectSkill(skill)}
                >
                  <div className="slash-menu__item-name">
                    {editSkills.some((s) => s.id === skill.id) ? (
                      <span className="slash-menu__item-check"><IconCheck size={10} /></span>
                    ) : (
                      <span className="slash-menu__item-check-placeholder" />
                    )}
                    <span>{skill.name}</span>
                  </div>
                  {skill.description && <span className="slash-menu__item-desc">{skill.description}</span>}
                </div>
              ))}
              <div className="slash-menu__hint"><span>↑↓ 导航 · Enter 选择 · Esc 关闭</span></div>
            </div>
          )}
          {slashOpen && filteredSkills.length === 0 && (
            <div className="slash-menu slash-menu--edit">
              <div className="slash-menu__empty">无匹配的 Skill</div>
              <div className="slash-menu__hint"><span>Esc 关闭</span></div>
            </div>
          )}
          <div className="msg__edit-actions">
            <span className="msg__edit-hint">Enter 发送 · Shift+Enter 换行{skillMetas.length > 0 ? ' · / 选 Skill' : ''}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => { setDraft(editableText); setEditSkills(msg.meta?.skills ?? []); setEditing(false) }}>取消</button>
            <button className="btn btn--primary btn--sm" onClick={() => void submit()} disabled={!draft.trim() && editSkills.length === 0}>重新发送</button>
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
              <span className="msg__meta-card-name">AI 编译（识别启动命令）</span>
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