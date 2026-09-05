import { useEffect, useRef } from 'react'
import { useChatStore, selectCurrentChat } from '@/store/useChatStore'
import type { ChatMessage } from '@/types'
import { MessageBubble } from './MessageBubble'

/** 消息列表：自动滚动到最新（用户上翻时暂停跟随，回到底部恢复）。 */
export function MessageList() {
  const { messages, status } = useChatStore(selectCurrentChat)
  const ref = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

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
