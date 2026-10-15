import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { previewSetVisible, isDesktop } from '@/services/desktop'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useIsWide } from '@/hooks/useMediaQuery'
import { useDesktopEvents, useThemeSync, usePetChatStatus } from '@/hooks/useDesktopEvents'
import { Workspace } from '@/components/workspace/Workspace'
import { MemorySidebar } from '@/components/shell/MemorySidebar'
import { AppTopbar } from '@/components/shell/AppTopbar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { StatusBar } from '@/components/shell/StatusBar'
import { SettingsDialog } from '@/components/shell/SettingsDialog'
import { ClosePromptDialog } from '@/components/shell/ClosePromptDialog'
import { Dialogs } from '@/components/common/Dialogs'
import { ToastHost } from '@/components/common/Toast'
import { IconAlert } from '@/components/common/icons'

/** 分割比例钳制：工作区 ≥500px、对话栏 ≥300px（分割线 5px 计入对话侧）。
 *  两头冲突（窗口太小放不下 500+300）时对话侧赢——工作区工具栏被压烂比对话窄更伤，
 *  但对话栏自身还有 CSS min-width:300 地板兜底，不会撑爆 body。total≤0（未布局/隐藏）原样返回。 */
function clampSplitRatio(r: number, total: number, sidebarW: number): number {
  if (total <= 0) return r
  const next = Math.max(500 / total, r)
  return Math.min(1 - (sidebarW + 5 + 300) / total, next)
}

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
      const r = (clientX - wsLeft) / total
      setSplitRatio(clampSplitRatio(r, total, sidebarW))
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

  /** 分割线键盘替代：←/→ 以 2% 步进调整（WAI-ARIA separator 模式），
   *  与 onDividerDown 同一套钳制逻辑（工作区 ≥500px、对话栏 ≥300px） */
  const onDividerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const step = e.key === 'ArrowRight' ? 0.02 : -0.02
    const body = bodyRef.current
    const ws = workspaceRef.current
    if (!body || !ws) return
    const bodyRect = body.getBoundingClientRect()
    const wsLeft = ws.getBoundingClientRect().left
    const sidebarW = wsLeft - bodyRect.left
    setSplitRatio(clampSplitRatio(splitRatio + step, bodyRect.width, sidebarW))
    e.preventDefault()
  }

  // 窗口缩放 / 侧栏开合后重钳比例：拖拽期的 min 只管当下，之后 body 宽度一变
  // （缩窗口、开侧栏），存的百分比会把工作区压到工具栏按钮被裁掉——边界事件
  // 都按最新几何重新钳一遍（工作区 ≥500px、对话栏 ≥300px，两头冲突时对话栏赢）
  const memorySidebarOpen = useAppStore((s) => s.memorySidebarOpen)
  useEffect(() => {
    const reclamp = () => {
      const body = bodyRef.current
      const ws = workspaceRef.current
      if (!body || !ws) return
      const bodyRect = body.getBoundingClientRect()
      const wsLeft = ws.getBoundingClientRect().left
      const sidebarW = wsLeft - bodyRect.left
      const cur = useAppStore.getState().splitRatio
      const next = clampSplitRatio(cur, bodyRect.width, sidebarW)
      if (Math.abs(next - cur) > 0.0005) setSplitRatio(next)
    }
    reclamp()
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [memorySidebarOpen, setSplitRatio])

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

      {/* 全局顶栏：品牌门面 + 主题切换 + 对话栏折叠（theme-v2-chat app__topbar） */}
      <AppTopbar />

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
            aria-label="调整工作区与对话栏比例（左右方向键调整）"
            tabIndex={0}
            aria-valuenow={Math.round(splitRatio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            onPointerDown={onDividerDown}
            onKeyDown={onDividerKeyDown}
          />
        )}

        <ChatPanel />
      </div>

      <StatusBar />
      <SettingsDialog />
      <ClosePromptDialog />
      <Dialogs />
      <ToastHost />
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
