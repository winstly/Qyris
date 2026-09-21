import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { previewSetVisible, isDesktop } from '@/services/desktop'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useIsWide } from '@/hooks/useMediaQuery'
import { useDesktopEvents, useThemeSync, usePetChatStatus } from '@/hooks/useDesktopEvents'
import { Workspace } from '@/components/workspace/Workspace'
import { MemorySidebar } from '@/components/shell/MemorySidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { StatusBar } from '@/components/shell/StatusBar'
import { SettingsDialog } from '@/components/shell/SettingsDialog'
import { ClosePromptDialog } from '@/components/shell/ClosePromptDialog'
import { Dialogs } from '@/components/common/Dialogs'
import { IconAlert, IconChevron } from '@/components/common/icons'
export default function App() {
  const booted = useAppStore((s) => s.booted)
  const splitRatio = useAppStore((s) => s.splitRatio)
  const setSplitRatio = useAppStore((s) => s.setSplitRatio)
  const chatPanelCollapsed = useAppStore((s) => s.chatPanelCollapsed)
  const isWide = useIsWide()
  const theme = useAppStore((s) => s.theme)
  const bodyRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)

  useKeyboardShortcuts()

  // 启动：读配置 → 恢复上次项目 → 恢复 keychain 状态
  useEffect(() => {
    void useAppStore.getState().boot()
  }, [])

  // 主题应用 + 桌宠状态上报 + 全局事件接线（与桌宠面板共用，见 useDesktopEvents）
  useThemeSync(theme)
  usePetChatStatus()
  // 弹窗打开时隐藏 WebContentsView（native overlay 遮不住 DOM 弹窗）
  const hasDialog = useAppStore((s) => !!s.dialog || s.settingsOpen || s.createProjectOpen || s.openSelectCount > 0)
  useEffect(() => {
    void previewSetVisible(!hasDialog)
  }, [hasDialog])
  useDesktopEvents({
    // 只处理当前工程的变更 + 400ms 节流合并（面板窗口直接刷新，见 panel-main.tsx）
    onFsChanged: (p) => { scheduleFsRefresh(p.projectRoot ?? useAppStore.getState().projectPath ?? '', p.paths) },
  })

  /** 主分割线拖拽：左工作区 ≥ 500px，右对话栏 ≥ 300px。
   *  坐标基准是「工作区左缘」而非 body 左缘——工作区左侧还有 MemorySidebar（40px 图标列
   *  + 可选 260px 面板），用 body 左缘算比率会让边线恒差一个侧边栏宽度（鼠标对不起边线）。 */
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const body = bodyRef.current
    const ws = workspaceRef.current
    if (!body || !ws) return
    const bodyRect = body.getBoundingClientRect()
    const wsLeft = ws.getBoundingClientRect().left
    const sidebarW = wsLeft - bodyRect.left
    const total = bodyRect.width
    const move = (clientX: number) => {
      // flexBasis 百分比以 body 全宽为基准：工作区宽 = clientX - 工作区左缘
      let r = (clientX - wsLeft) / total
      r = Math.max(500 / total, r)
      // 对话栏 ≥300px + 分割线 5px：工作区上限 = 1 - (侧边栏宽 + 分割线 + 300) / 全宽
      r = Math.min(1 - (sidebarW + 5 + 300) / total, r)
      setSplitRatio(r)
    }
    const onMove = (ev: PointerEvent) => move(ev.clientX)
    const onUp = () => {
      document.body.classList.remove('dragging-col')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    document.body.classList.add('dragging-col')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 窗口过小时全屏提示（<1024px 窄屏布局在当前尺寸下无法正确渲染）
  const [isTooSmall, setIsTooSmall] = useState(false)
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth
      setIsTooSmall(w < 1024)
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  return (
    <div className="app">
      {isTooSmall && (
        <div className="size-guard">
          <div className="size-guard__content">
            <span className="size-guard__icon">⊞</span>
            <p>窗口太小，请放大窗口以使用轻驭</p>
          </div>
        </div>
      )}

      {!isDesktop && (
        <div className="env-banner">
          <IconAlert size={14} />
          <span>
            当前在浏览器中预览 —— 文件系统、子进程、AI 代理等能力需在桌面应用内运行
            （npm run dev）。
          </span>
        </div>
      )}

      <div
        className={`app__body ${chatPanelCollapsed ? 'app__body--chat-collapsed' : ''}`}
        ref={bodyRef}
        data-ready={booted || undefined}
      >
        <MemorySidebar />
        <div
          ref={workspaceRef}
          className="app__workspace"
          style={isWide ? { flexBasis: `${splitRatio * 100}%` } : undefined}
        >
          <Workspace />
        </div>

        {isWide && (
          <div
            className="app__divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整工作区与对话栏比例"
            onPointerDown={onDividerDown}
          />
        )}

        <ChatPanel />

        {/* 对话栏折叠后的展开把手：贴右缘全高竖条，点击恢复（就地交互，不依赖快捷键/状态栏） */}
        {chatPanelCollapsed && (
          <button
            className="edge-grip edge-grip--chat"
            onClick={useAppStore.getState().toggleChatPanel}
            aria-label="展开对话栏"
            title="展开对话栏"
          >
            <IconChevron size={14} />
          </button>
        )}
      </div>

      <StatusBar />
      <SettingsDialog />
      <ClosePromptDialog />
      <Dialogs />
    </div>
  )
}

// ---------- watcher 事件节流合并 ----------

let fsTimer: number | null = null
let pendingPaths: string[] = []

function scheduleFsRefresh(projectRoot: string, paths: string[]) {
  // 只处理当前工程的变更
  if (projectRoot && projectRoot !== useAppStore.getState().projectPath) return
  pendingPaths.push(...paths.slice(0, 50))
  if (fsTimer !== null) return
  fsTimer = window.setTimeout(() => {
    const unique = [...new Set(pendingPaths)]
    pendingPaths = []
    fsTimer = null
    void useFileStore.getState().notifyExternalChange(unique)
  }, 400)
}
