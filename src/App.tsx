import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useBuildStore } from '@/store/useBuildStore'
import { useFileStore } from '@/store/useFileStore'
import { useChatStore } from '@/store/useChatStore'
import { onBuildOutput, onBuildExit, onAiDelta, onAiReasoning, onCliToolEvent, onCliToolResult, onCliAgentEvent, onFsChanged, onElementPicked, previewSetVisible, isDesktop } from '@/services/desktop'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useIsWide } from '@/hooks/useMediaQuery'
import { Workspace } from '@/components/workspace/Workspace'
import { MemorySidebar } from '@/components/shell/MemorySidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { StatusBar } from '@/components/shell/StatusBar'
import { SettingsDialog } from '@/components/shell/SettingsDialog'
import { Dialogs } from '@/components/common/Dialogs'
import { IconAlert } from '@/components/common/icons'
export default function App() {
  const booted = useAppStore((s) => s.booted)
  const splitRatio = useAppStore((s) => s.splitRatio)
  const setSplitRatio = useAppStore((s) => s.setSplitRatio)
  const isWide = useIsWide()
  const theme = useAppStore((s) => s.theme)
  const bodyRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)

  useKeyboardShortcuts()

  // 启动：读配置 → 恢复上次项目 → 恢复 keychain 状态
  useEffect(() => {
    void useAppStore.getState().boot()
  }, [])

  // 主题应用
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolved
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  // 弹窗打开时隐藏 WebContentsView（native overlay 遮不住 DOM 弹窗）
  const hasDialog = useAppStore((s) => !!s.dialog || s.settingsOpen || s.createProjectOpen || s.openSelectCount > 0)
  useEffect(() => {
    void previewSetVisible(!hasDialog)
  }, [hasDialog])

  // 会话持久化已改为 store 内稳定点 write-through（见 useChatStore），这里不再做全量覆写订阅

  // 全局事件接线：编译输出 / 退出码 / AI 增量 / 文件变更
  useEffect(() => {
    if (!isDesktop) return
    const offs = [
      onBuildOutput((p) => useBuildStore.getState().onOutput(p.projectRoot ?? useAppStore.getState().projectPath ?? '', p.name, p.stream, p.line)),
      onBuildExit((p) => useBuildStore.getState().onExit(p.projectRoot ?? useAppStore.getState().projectPath ?? '', p.name, p.code)),
      onAiDelta((p) => useChatStore.getState().appendDelta(p.requestId, p.delta)),
      onAiReasoning((p) => useChatStore.getState().appendReasoning(p.requestId, p.delta)),
      onCliToolEvent((p) => useChatStore.getState().handleCliToolEvent(p.requestId, p.id, p.name, p.phase, p.arguments)),
      onCliToolResult((p) => useChatStore.getState().handleCliToolResult(p.requestId, p.id, p.content, p.isError, p.tokens)),
      onCliAgentEvent((p) => useChatStore.getState().handleCliAgentEvent(p)),
      onFsChanged((p) => { scheduleFsRefresh(p.projectRoot ?? useAppStore.getState().projectPath ?? '', p.paths) }),
      onElementPicked((p) => useChatStore.getState().setPendingElement(p)),
    ]
    return () => { offs.forEach((f) => f()) }
  }, [])

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

      <div className="app__body" ref={bodyRef} data-ready={booted || undefined}>
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
      </div>

      <StatusBar />
      <SettingsDialog />
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
