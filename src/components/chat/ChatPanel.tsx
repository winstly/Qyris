import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useChatStore, selectCurrentChat, type ChatStatus } from '@/store/useChatStore'
import { useFileStore } from '@/store/useFileStore'
import { useAgentStore, selectCurrentAgent } from '@/store/useAgentStore'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { AgentView } from './AgentPanel'
import { Select } from '@/components/common/Select'
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
  const { status, sessionId } = useChatStore(selectCurrentChat)
  const hasMessages = useChatStore((s) => selectCurrentChat(s).messages.length > 0)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const hasSessionChanges = useFileStore((s) => Object.values(s.snapshots).some((v) => v.sessionId === sessionId))
  const { order: agentOrder, threads: agentThreads, activeThreadId } = useAgentStore(selectCurrentAgent)
  const selectThread = useAgentStore((s) => s.selectThread)

  // 切换器只列活跃的 agent
  const liveAgentIds = useMemo(
    () =>
      agentOrder.filter((id) => {
        const st = agentThreads[id]?.status
        return st === 'running' || st === 'pending'
      }),
    [agentOrder, agentThreads],
  )
  const showAgentBar = liveAgentIds.length > 0 || !!activeThreadId

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
    if (ok) {
      useChatStore.getState().clear()
      useAgentStore.getState().clear()
    }
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

      {/* agent 切换器：只列活着的 agent（完成/取消自动清理出列表）；正在查看的线程始终保留选项 */}
      {showAgentBar && (
        <div className="chat__agentbar">
          <Select
            size="sm"
            value={activeThreadId ?? 'main'}
            onChange={(v) => selectThread(v === 'main' ? null : v)}
            options={[
              { value: 'main', label: '主对话' },
              ...liveAgentIds.map((id) => {
                const t = agentThreads[id]
                const flag = t?.status === 'running' ? ' ●' : ' ○'
                return { value: id, label: `${t?.title ?? id}${flag}` }
              }),
              ...(activeThreadId && !liveAgentIds.includes(activeThreadId) && agentThreads[activeThreadId]
                ? [{ value: activeThreadId, label: `${agentThreads[activeThreadId].title}（已结束）` }]
                : []),
            ]}
            ariaLabel="切换查看 agent"
          />
        </div>
      )}

      {activeThreadId && agentThreads[activeThreadId] ? <AgentView /> : <MessageList />}
      <ChatInput />
    </aside>
  )
}