/**
 * 全局顶栏 = 自绘标题栏（无边框窗口）：品牌门面 + 主题切换 + 对话栏折叠 + 窗口三键。
 * 整条 -webkit-app-region: drag（可拖动移动窗口；双击拖拽区 = 系统最大化/还原），
 * 所有按钮 no-drag。关闭键走主进程 close 分流（ask/minimize/quit），
 * 与被替换的系统 X 完全同路径——ClosePromptDialog 逻辑原样继承。
 * 浏览器预览（非 desktop）隐藏三键与拖拽行为。
 */
import { useEffect, useState } from 'react'
import { useAppStore, type Theme } from '@/store/useAppStore'
import { isDesktop } from '@/services/desktop'
import { AppIcon } from '@/components/common/AppIcon'

const THEME_META: Record<Theme, { label: string; icon: string; next: Theme }> = {
  system: { label: '跟随系统', icon: 'ri-contrast-2-line', next: 'light' },
  light: { label: '亮色', icon: 'ri-sun-line', next: 'dark' },
  dark: { label: '暗色', icon: 'ri-moon-line', next: 'system' },
}

export function AppTopbar() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const chatPanelCollapsed = useAppStore((s) => s.chatPanelCollapsed)
  const toggleChatPanel = useAppStore((s) => s.toggleChatPanel)
  const meta = THEME_META[theme]
  const [maximized, setMaximized] = useState(false)

  // 最大化状态跟切（按钮图标 maximize ⇄ restore）
  useEffect(() => {
    if (!isDesktop || !window.desktopAPI) return
    return window.desktopAPI.onWindowState((p) => setMaximized(!!p.maximized))
  }, [])

  return (
    <header className="app__topbar" data-desktop={isDesktop || undefined}>
      <div className="brand-mark">
        <div className="brand-mark__avatar" aria-hidden>
          <AppIcon className="app-logo" />
        </div>
        <div>
          <div className="brand-mark__name">Qyris 工作台</div>
          <div className="brand-mark__sub">轻驭 · AI 协同编程</div>
        </div>
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => setTheme(meta.next)}
          title={`主题：${meta.label}（点击切换）`}
          aria-label={`主题：${meta.label}，点击切换`}
        >
          <i className={`od-icon ${meta.icon}`} />
        </button>
        <button
          type="button"
          className={`btn btn--icon ${chatPanelCollapsed ? 'btn--icon--active' : ''}`}
          onClick={toggleChatPanel}
          title={chatPanelCollapsed ? '展开对话栏 (Ctrl+J)' : '折叠对话栏 (Ctrl+J)'}
          aria-label={chatPanelCollapsed ? '展开对话栏' : '折叠对话栏'}
          aria-pressed={!chatPanelCollapsed}
        >
          <i className="od-icon ri-message-3-line" />
        </button>
      </div>
      {isDesktop && (
        <div className="topbar__winbtns" role="group" aria-label="窗口控制">
          <button
            type="button"
            className="topbar__winbtn"
            onClick={() => void window.desktopAPI?.minimizeWindow()}
            aria-label="最小化"
            title="最小化"
          >
            <i className="od-icon ri-subtract-line" />
          </button>
          <button
            type="button"
            className="topbar__winbtn"
            onClick={() => void window.desktopAPI?.toggleMaximize()}
            aria-label={maximized ? '还原' : '最大化'}
            title={maximized ? '还原' : '最大化'}
          >
            <i className={`od-icon ${maximized ? 'ri-window-2-line' : 'ri-window-line'}`} />
          </button>
          <button
            type="button"
            className="topbar__winbtn topbar__winbtn--close"
            onClick={() => void window.desktopAPI?.requestWindowClose()}
            aria-label="关闭"
            title="关闭"
          >
            <i className="od-icon ri-close-line" />
          </button>
        </div>
      )}
    </header>
  )
}
