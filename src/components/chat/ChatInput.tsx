import { useRef, useState, useCallback, useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useChatStore } from '@/store/useChatStore'
import { isDesktop } from '@/services/desktop'
import { fmtTok } from '@/utils/tokens'
import { IconSend, IconStop, IconClose, IconTarget, IconCheck } from '@/components/common/icons'
import type { SkillMeta } from '@/types'

/** 多行输入：Enter 发送 / Shift+Enter 换行，自动增高；生成中可点「停止」。
 *  输入 "/" 触发 Skills 选择菜单；选中后作为上下文，用户继续写描述再发送。 */
export function ChatInput() {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const status = useChatStore((s) => s.status)
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const pendingElement = useChatStore((s) => s.pendingElement)
  const setPendingElement = useChatStore((s) => s.setPendingElement)
  const usage = useChatStore((s) => s.usage)
  const skillMetas = useAppStore((s) => s.skillMetas)

  // Slash 命令菜单状态
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  // 输入 / 之前的文本暂存（用户输入 / 前的内容）
  const savedTextRef = useRef('')
  // 追踪上一次文本值，用于检测何时插入了 /
  const prevTextRef = useRef('')

  // 已选中的 Skills（多选，选中后不发送，等用户写描述再一起发）
  const [selectedSkills, setSelectedSkills] = useState<SkillMeta[]>([])

  const busy = status === 'streaming' || status === 'tools' || status === 'awaiting-user' || status === 'retrying'
  const disabledHint = !isDesktop
    ? '需在桌面应用内运行（npm run dev）'
    : !hasApiKey
      ? '请先在设置中配置 API Key'
      : undefined

  // 过滤匹配的 skills
  const filteredSkills = slashOpen
    ? skillMetas.filter((s) => {
        if (!slashFilter) return true
        const q = slashFilter.toLowerCase()
        return s.name.toLowerCase().includes(q)
          || s.id.toLowerCase().includes(q)
          || s.description.toLowerCase().includes(q)
          || s.triggers.some((t) => t.toLowerCase().includes(q))
      })
    : []

  // slashFilter 变化时重置选中索引
  useEffect(() => { setSlashIndex(0) }, [slashFilter])

  // 方向键导航时自动滚动到可见区域
  useEffect(() => {
    if (!slashOpen) return
    const el = document.querySelector('.slash-menu__item--active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashOpen])

  const resize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }

  const closeSlash = useCallback(() => {
    setSlashOpen(false)
    setSlashFilter('')
    setSlashIndex(0)
  }, [])

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
    if ((!userText && selectedSkills.length === 0) || busy || disabledHint) return
    // 构建 AI 消息（系统指令）和 UI 元数据（卡片）
    let aiMsg = ''
    const meta: import('@/types').MessageMeta = {}
    if (selectedSkills.length > 0) {
      meta.skills = selectedSkills.map((s) => ({ id: s.id, name: s.name }))
      const ids = selectedSkills.map((s) => s.id).join(', ')
      const skillPart = selectedSkills.length > 1
        ? `请先用 load_skill 依次加载以下 ${selectedSkills.length} 个 Skill，全部加载后再执行：${ids}`
        : `请先用 load_skill 加载 Skill「${ids}」，再执行。`
      aiMsg = userText ? `${skillPart}\n\n${userText}` : skillPart
    } else {
      aiMsg = userText
    }
    setText('')
    prevTextRef.current = ''
    setSelectedSkills([])
    requestAnimationFrame(resize)
    void send(aiMsg, meta)
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    const prev = prevTextRef.current
    prevTextRef.current = val
    setText(val)
    resize()
    // 检测 "/" 触发：现在以 / 开头但之前不以 / 开头 → 用户在开头插入了 /
    if (val.startsWith('/') && !prev.startsWith('/') && !slashOpen && skillMetas.length > 0) {
      // 暂存之前的文本（"帮我" 变成 "/帮我" → 暂存 "帮我"）
      savedTextRef.current = prev
      setSlashOpen(true)
      setSlashFilter('')
    } else if (slashOpen) {
      if (!val.startsWith('/')) {
        savedTextRef.current = ''
        closeSlash()
      } else {
        // 搜索关键字 = / 之后、暂存文本之前的部分
        // /react帮我 → savedText="帮我" → keyword="react"
        const afterSlash = val.slice(1)
        const saved = savedTextRef.current
        const keyword = saved && afterSlash.endsWith(saved)
          ? afterSlash.slice(0, -saved.length)
          : afterSlash
        setSlashFilter(keyword)
      }
    }
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
        savedTextRef.current = ''
        closeSlash()
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
      {/* Slash 命令菜单 */}
      {slashOpen && filteredSkills.length > 0 && (
        <div className="slash-menu" role="listbox" aria-label="选择 Skill">
          {filteredSkills.map((skill, i) => (
            <div
              key={skill.id}
              className={`slash-menu__item ${i === slashIndex ? 'slash-menu__item--active' : ''}`}
              role="option"
              aria-selected={selectedSkills.some((s) => s.id === skill.id)}
              onMouseEnter={() => setSlashIndex(i)}
              onClick={() => void selectSkill(skill)}
            >
              <div className="slash-menu__item-name">
                {selectedSkills.some((s) => s.id === skill.id) ? (
                  <span className="slash-menu__item-check"><IconCheck size={10} /></span>
                ) : (
                  <span className="slash-menu__item-check-placeholder" />
                )}
                <span>{skill.name}</span>
              </div>
              {skill.description && <span className="slash-menu__item-desc">{skill.description}</span>}
            </div>
          ))}
          <div className="slash-menu__hint">
            <span>↑↓ 导航 · Enter 选择 · Esc 关闭</span>
          </div>
        </div>
      )}
      {slashOpen && filteredSkills.length === 0 && (
        <div className="slash-menu">
          <div className="slash-menu__empty">无匹配的 Skill</div>
          <div className="slash-menu__hint">
            <span>Esc 关闭</span>
          </div>
        </div>
      )}

      {/* 已选中的 Skills 引用 chips */}
      {selectedSkills.length > 0 && (
        <div className="chat__skill-chips">
          {selectedSkills.map((skill) => (
            <div key={skill.id} className="chat__skill-chip">
              <span className="chat__skill-chip-label">Skill</span>
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
        <div className="chat__picked">
          <IconTarget size={12} />
          <span className="chat__picked-label">已选元素</span>
          <code className="chat__picked-sel mono">{pendingElement.selector}</code>
          {pendingElement.text && <span className="chat__picked-text">{pendingElement.text.slice(0, 40)}</span>}
          <button className="chat__picked-clear" onClick={() => setPendingElement(null)} aria-label="清除选中元素" title="清除选中元素">
            <IconClose size={11} />
          </button>
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
              : skillMetas.length > 0
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
