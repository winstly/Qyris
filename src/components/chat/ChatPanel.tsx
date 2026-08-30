import { useAppStore } from '@/store/useAppStore'
import { useChatStore, type ChatStatus } from '@/store/useChatStore'
import { useFileStore } from '@/store/useFileStore'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { IconGear, IconTrash, IconUndo } from '@/components/common/icons'

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: '待命',
  streaming: '生成中',
  tools: '执行工具',
  'awaiting-user': '等你回答',
  error: '出错',
  retrying: '重试中',
}

export function ChatPanel() {
  const status = useChatStore((s) => s.status)
  const hasMessages = useChatStore((s) => s.messages.length > 0)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const sessionId = useChatStore((s) => s.sessionId)
  const hasSessionChanges = useFileStore((s) => Object.values(s.snapshots).some((v) => v.sessionId === sessionId))

  const revertSession = async () => {
    const ok = await useAppStore.getState().showConfirm(
      '回退本次会话',
      '将恢复本次对话中 AI 修改的所有文件到对话开始前，且不可撤销。确定吗？',
    )
    if (!ok) return
    const n = await useFileStore.getState().restoreSession(sessionId)
    void useAppStore.getState().showAlert(
      '已回退',
      n > 0 ? `已回退 ${n} 个文件到会话开始前。` : '本次会话没有可回退的文件改动。',
    )
  }

  const clearChat = async () => {
    const ok = await useAppStore.getState().showConfirm('清空对话', '确定清空当前全部对话吗？此操作不可撤销。')
    if (ok) useChatStore.getState().clear()
  }

  return (
    <aside className="chat" aria-label="AI 对话栏">
      <header className="chat__head">
        <span className="chat__dot" data-status={status} />
        <span className="chat__title">AI 助手</span>
        <span className="chat__status" data-status={status}>{STATUS_LABEL[status]}</span>
        <div className="chat__head-actions">
          <button className="icon-btn" onClick={() => void revertSession()} disabled={!hasSessionChanges} aria-label="回退会话" title="回退本次会话的 AI 文件改动">
            <IconUndo size={15} />
          </button>
          <button className="icon-btn" onClick={() => void clearChat()} disabled={!hasMessages} aria-label="清空对话" title="清空对话">
            <IconTrash size={15} />
          </button>
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="AI 设置" title="AI 设置">
            <IconGear size={15} />
          </button>
        </div>
      </header>

      <MessageList />
      <ChatInput />
    </aside>
  )
}