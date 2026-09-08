import { useEffect, useLayoutEffect, useRef } from 'react'
import { useChatStore, selectCurrentChat } from '@/store/useChatStore'
import type { ChatMessage } from '@/types'
import { MessageBubble } from './MessageBubble'

/**
 * 消息列表：自动滚动到最新（用户上翻时暂停跟随，回到底部恢复）。
 * 向上翻页：scrollTop 触顶（<80px）且有更早历史时 loadOlder()——触发瞬间先脱离贴底；
 * prepend 完成后用 scrollHeight 增量补偿 scrollTop，保证用户正在看的那条消息原地不动（无推挤跳动）。
 */
export function MessageList() {
  const { messages, status, hasMoreOlder, loadingOlder, sessionId } = useChatStore(selectCurrentChat)
  const loadOlder = useChatStore((s) => s.loadOlder)
  const ref = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  // 上一帧渲染的（会话 id, 首条消息 id, scrollHeight）：同会话内首条 id 变化即 prepend 完成，
  // 用 scrollHeight 差值补偿 scrollTop；跨工程/换会话的 id 变化不算（sessionId 守卫）
  const anchorRef = useRef<{ sessionId: string; firstId: string | null; scrollHeight: number } | null>(null)

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // 触顶翻页：触发瞬间先脱离贴底，防止老消息 prepend 后被贴底逻辑拽走
    if (el.scrollTop < 80 && hasMoreOlder && !loadingOlder) {
      stickRef.current = false
      void loadOlder()
    }
  }

  // 视口锚定：每次渲染后比对首条 id；prepend 造成的高度增量原样加回 scrollTop
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      anchorRef.current = null
      return
    }
    const prev = anchorRef.current
    const firstId = messages[0]?.id ?? null
    if (prev && prev.sessionId === sessionId && firstId !== prev.firstId && prev.firstId !== null) {
      const delta = el.scrollHeight - prev.scrollHeight
      if (delta > 0) el.scrollTop += delta
    }
    anchorRef.current = { sessionId, firstId, scrollHeight: el.scrollHeight }
  })

  useEffect(() => {
    const el = ref.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, status])

  if (messages.length === 0) {
    return (
      <div className="chat__welcome">
        <div className="chat__welcome-title">让 AI 直接操作你的项目</div>
        <ul className="chat__welcome-list">
          <li>「看看 src 目录结构」→ 自动调用 list_files</li>
          <li>「把 README 标题改成 …」→ read_file + write_file，文件树同步刷新</li>
          <li>需要你决策时会弹出选项卡片</li>
        </ul>
        <p className="chat__welcome-hint">发送第一条消息开始</p>
      </div>
    )
  }

  const last = messages[messages.length - 1]
  const waitingFirstToken = status === 'streaming' && !(last?.role === 'assistant' && last.pending)

  return (
    <div className="chat__list" ref={ref} onScroll={onScroll}>
      {messages.map((m: ChatMessage) => (
        <MessageBubble key={m.id} msg={m} />
      ))}
      {waitingFirstToken && (
        <div className="msg msg--ai">
          <div className="thinking" aria-label="正在思考">
            <span /><span /><span />
          </div>
        </div>
      )}
    </div>
  )
}
