/**
 * 桌宠面板渲染入口：完整复刻主窗口的项目列表和对话面板。
 * 底部导航栏（类手机客户端）切换项目/对话，中间内容区铺满。
 * 全局事件接线/主题/桌宠状态上报与主窗口共用 useDesktopEvents（防两份漂移）。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { useDesktopEvents, useThemeSync, usePetChatStatus } from '@/hooks/useDesktopEvents'
import { ProjectsTab } from '@/components/workspace/ProjectsTab'
import { ChatPanel } from '@/components/chat/ChatPanel'
import '@/styles/tokens.css'
import '@/styles/panels.css'
import '@/styles/chat.css'
import '@/styles/memory.css'
import '@/styles/shell.css'
import '@/styles/sidebar.css'
import './panel.css'

type Tab = 'projects' | 'chat'

const NAV_ITEMS: { id: Tab; label: string; icon: JSX.Element }[] = [
  {
    id: 'projects',
    label: '项目',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
    ),
  },
  {
    id: 'chat',
    label: '对话',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
  },
]

function PetPanelApp() {
  // 默认落在对话 tab（桌宠点开面板最常用的就是对 AI 说话）
  const [tab, setTab] = useState<Tab>('chat')
  const theme = useAppStore((s) => s.theme)

  useEffect(() => { void useAppStore.getState().boot() }, [])

  // 主题/桌宠状态/全局事件接线与主窗口共用同一实现
  useThemeSync(theme)
  usePetChatStatus()
  useDesktopEvents({
    // 面板整个窗口只为一个工程服务，直接按载荷刷新文件树（主窗口做当前工程过滤+节流）
    onFsChanged: (p) => { useFileStore.getState().notifyExternalChange(p.paths) },
  })

  return (
    <div className="pet-panel">
      {/* 内容区：铺满 nav 上方 */}
      <div className="pet-panel__content">
        {tab === 'projects' ? <ProjectsTab /> : <ChatPanel showHeaderActions={false} />}
      </div>

      {/* 底部导航栏 */}
      <nav className="pet-panel__nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`pet-panel__nav-item ${tab === item.id ? 'pet-panel__nav-item--active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<PetPanelApp />)
