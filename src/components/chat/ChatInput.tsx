import { useRef, useState, useCallback, useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useChatStore, selectCurrentChat } from '@/store/useChatStore'
import { isDesktop } from '@/services/desktop'
import { fmtTok } from '@/utils/tokens'
import { mergeSkills, skillLoadInstruction } from '@/utils/skillInstruction'
import { IconSend, IconStop, IconClose } from '@/components/common/icons'
import { useSlashCommand, SlashMenu } from './SlashMenu'
import type { SkillMeta } from '@/types'
import { isCliAgentMode } from '../../../shared/ai-mode'

/** 多行输入：Enter 发送 / Shift+Enter 换行，自动增高；生成中可点「停止」。
 *  输入 "/" 触发 Skills 选择菜单；选中后作为上下文，用户继续写描述再发送。 */
export function ChatInput() {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const { status, pendingElement, usage } = useChatStore(selectCurrentChat)
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const dispatchMode = useAppStore((s) => s.settings.dispatchMode)
  const setPendingElement = useChatStore((s) => s.setPendingElement)
  const skillMetas = useAppStore((s) => s.skillMetas)
  const projectSkillMetas = useAppStore((s) => s.projectSkillMetas)

  // Slash 命令菜单
  const savedTextRef = useRef('')
  const prevTextRef = useRef('')
  const [selectedSkills, setSelectedSkills] = useState<SkillMeta[]>([])

  const busy = status === 'streaming' || status === 'tools' || status === 'awaiting-user' || status === 'retrying'
  const disabledHint = !isDesktop
    ? '需在桌面应用内运行（npm run dev）'
    : !isCliAgentMode(dispatchMode) && !hasApiKey
      ? '请先在设置中配置 API Key'
      : undefined

  // 合并项目 Skill + 用户 Skill，项目在前；同 id 去重（同目录挂全局+项目时双行假重复）
  const allSkills = useMemo(() => mergeSkills(projectSkillMetas, skillMetas), [projectSkillMetas, skillMetas])
  const { slashOpen, setSlashOpen, setSlashFilter, slashIndex, setSlashIndex, hoverSlashIndex, filteredSkills, closeSlash } = useSlashCommand(allSkills)

  /** 用户拖过 grip 后高度钉死（不随内容缩回）；双击 grip 重置回自适应 */
  const draggedRef = useRef(false)

  const resize = () => {
    const ta = taRef.current
    if (!ta) return
    const maxH = useAppStore.getState().chatInputMaxH
    ta.style.height = 'auto'
    ta.style.height = `${draggedRef.current ? maxH : Math.min(ta.scrollHeight, maxH)}px`
  }

  /** 输入框顶部 grip 拖高：向上拖增高（96–480px，store 持久化），拖动中高度钉死，双击重置 */
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = useAppStore.getState().chatInputMaxH
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      useAppStore.getState().setChatInputMaxH(startH - (ev.clientY - startY))
      draggedRef.current = true
      const ta = taRef.current
      if (ta) ta.style.height = `${useAppStore.getState().chatInputMaxH}px`
    }
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  /** 选中一个 skill：删除 / 和关键字，恢复暂存文本，光标移到末尾 */
  const selectSkill = useCallback((skill: SkillMeta) => {
    const restored = savedTextRef.current
    closeSlash()

    savedTextRef.current = ''
    setText(restored)
    prevTextRef.current = restored  // 同步更新，否则下次检测 prev 还是 /xxx
    setSelectedSkills((prev) =>
      prev.some((s) => s.id === skill.id)
        ? prev.filter((s) => s.id !== skill.id)
        : [...prev, skill],
    )
    // 光标移到末尾（延迟一帧等 React 渲染完）
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(restored.length, restored.length)
      }
      resize()
    })
  }, [closeSlash])

  const doSend = () => {
    if (slashOpen) {
      // 菜单打开时 Enter 选中当前项
      const skill = filteredSkills[slashIndex]
      if (skill) selectSkill(skill)
      return
    }
    const userText = text.trim()
    if ((!userText && selectedSkills.length === 0 && !pendingElement) || busy || disabledHint) {
      if (disabledHint) console.warn('[chat-input] 发送被禁用：', disabledHint)
      if (busy) console.warn('[chat-input] 忙碌状态：', status)
      return
    }
    const meta: import('@/types').MessageMeta = {}
    if (pendingElement) {
      meta.element = { selector: pendingElement.selector, tag: pendingElement.tag, id: pendingElement.id, text: pendingElement.text }
    }
    let aiMsg = ''
    if (selectedSkills.length > 0) {
      meta.skills = selectedSkills.map((s) => ({ id: s.id, name: s.name }))
      // 生成器唯一来源（措辞是 ai-cli 反解正则的契约），见 utils/skillInstruction.ts
      const skillPart = skillLoadInstruction(selectedSkills.map((s) => s.id))
      aiMsg = userText ? `${skillPart}\n\n${userText}` : skillPart
    } else {
      aiMsg = userText
    }
    // 失败回填：send early return（无项目/状态异常/空文本）时恢复输入现场，
    // 用户输入不凭空消失（func-chat P1-2）
    const sendOut = async () => {
      const ok = await send(aiMsg, meta)
      if (!ok) {
        setText(userText)
        prevTextRef.current = userText
        setSelectedSkills(selectedSkills)
        setPendingElement(meta.element ?? null)
      }
    }
    setText('')
    prevTextRef.current = ''
    setSelectedSkills([])
    setPendingElement(null)
    requestAnimationFrame(resize)
    void sendOut()
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    const prev = prevTextRef.current
    prevTextRef.current = val
    setText(val)
    resize()
    // slash 触发：/ 出现在文本末尾且是词首（行首或空白后）——消息中段补 / 也能唤起，
    // 不要求整条以 / 开头（编辑重发场景原文非空，startsWith 恒 false 曾让菜单永远弹不出）
    const hitOf = (s: string): RegExpExecArray | null => /(^|\s)\/[^\s，]*$/.exec(s)
    const now = hitOf(val)
    if (now && !hitOf(prev) && allSkills.length > 0) {
      savedTextRef.current = prev
      setSlashOpen(true)
      setSlashFilter('')
      return
    }
    if (!slashOpen) return
    // 关闭 slash 菜单
    if (!now) { savedTextRef.current = ''; closeSlash(); return }
    // 更新 slash 过滤关键字（/ 词去掉前导斜杠）
    const afterSlash = now[0].replace(/^\s*\//, '')
    const saved = savedTextRef.current
    setSlashFilter(saved && afterSlash.endsWith(saved) ? afterSlash.slice(0, -saved.length) : afterSlash)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => Math.min(i + 1, filteredSkills.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // 关菜单并把「/过滤词」从输入框里退掉，恢复暂存原文——留着 '/xxx' 下次回车
        // 会把 skill 名当消息正文发出去（误带入聊天的入口之一）
        const restored = savedTextRef.current
        savedTextRef.current = ''
        closeSlash()
        setText(restored)
        prevTextRef.current = restored
        requestAnimationFrame(resize)
        return
      }
      // Enter 在 doSend 中处理
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      doSend()
    }
  }

  return (
    <div className="chat__inputwrap">
      <div
        className="chat__grip"
        onPointerDown={onGripDown}
        onDoubleClick={() => {
          draggedRef.current = false
          useAppStore.getState().setChatInputMaxH(160)
          resize()
        }}
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖拽调整输入框高度，双击重置"
        title="拖拽调整输入框高度 · 双击重置"
      />
      {/* Slash 命令菜单（向上浮出：不挤占消息列表布局，也不被短窗口裁剪） */}
      {slashOpen && (
        <SlashMenu
          filteredSkills={filteredSkills}
          slashIndex={slashIndex}
          selectedIds={new Set(selectedSkills.map((s) => s.id))}
          onSelect={selectSkill}
          onHoverIndex={hoverSlashIndex}
          className="slash-menu--chat"
        />
      )}

      {/* 已选中的 Skills 引用 chips */}
      {selectedSkills.length > 0 && (
        <div className="chat__skill-chips">
          {selectedSkills.map((skill) => (
            <div key={skill.id} className="chat__skill-chip">
              <span className="chat__skill-chip-label">{skill.scope === 'project' ? '项目' : 'Skill'}</span>
              <span className="chat__skill-chip-name">{skill.name}</span>
              <button
                className="chat__skill-chip-clear"
                onClick={() => setSelectedSkills((prev) => prev.filter((s) => s.id !== skill.id))}
                aria-label={`移除 ${skill.name}`}
                title={`移除 ${skill.name}`}
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingElement && (
        <div className="msg__meta-cards">
          <div className="msg__meta-card msg__meta-card--element msg__meta-card--pending">
            <span className="msg__meta-card-label">元素</span>
            <span className="msg__meta-card-name mono">{pendingElement.tag}{pendingElement.id ? `#${pendingElement.id}` : ''}</span>
            {pendingElement.text && <span className="msg__meta-card-hint">{pendingElement.text.slice(0, 60)}</span>}
            <button
              className="msg__meta-card-remove"
              onClick={() => setPendingElement(null)}
              aria-label="清除选中元素"
              title="清除选中元素"
            >
              <IconClose size={10} />
            </button>
          </div>
        </div>
      )}
      <div className={`chat__inputbox ${disabledHint ? 'chat__inputbox--disabled' : ''}`}>
        <textarea
          ref={taRef}
          className="chat__textarea"
          value={text}
          rows={1}
          disabled={!!disabledHint}
          placeholder={
            disabledHint ?? (selectedSkills.length > 0
              ? '补充你的具体需求，Enter 发送…'
              : allSkills.length > 0
                ? '输入 / 唤起 Skill 菜单，或直接对话…'
                : '让 AI 读取、修改项目文件，或回答你的问题…')
          }
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="chat__send chat__send--stop" onClick={cancel} aria-label="停止生成" title="停止生成">
            <IconStop size={14} />
          </button>
        ) : (
          <button
            className="chat__send"
            onClick={doSend}
            disabled={(!text.trim() && selectedSkills.length === 0 && !slashOpen) || !!disabledHint}
            aria-label="发送"
            title="发送 (Enter)"
          >
            <IconSend size={14} />
          </button>
        )}
      </div>
      <div className="chat__hints">
        <span>Enter 发送 · Shift+Enter 换行</span>
        {status === 'awaiting-user' && <span className="chat__hint-ask">AI 正在等待你的选择 ↑</span>}
        {(usage.input > 0 || usage.output > 0) && (
          <span className="chat__tokens">输入 {fmtTok(usage.input)} · 输出 {fmtTok(usage.output)}</span>
        )}
        {usage.agents && (usage.agents.input > 0 || usage.agents.output > 0) && (
          <span className="chat__tokens" title="本次会话所有子 agent 的 token 总消耗">子agent ↑{fmtTok(usage.agents.input)} ↓{fmtTok(usage.agents.output)}</span>
        )}
      </div>
    </div>
  )
}
