import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useBuildStore } from '@/store/useBuildStore'
import { useFileStore } from '@/store/useFileStore'
import { useChatStore } from '@/store/useChatStore'
import { onBuildOutput, onBuildExit, onAiDelta, onAiReasoning, onCliToolEvent, onFsChanged, isDesktop, api } from '@/services/desktop'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useIsWide } from '@/hooks/useMediaQuery'
import { Workspace } from '@/components/workspace/Workspace'
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

  useKeyboardShortcuts()

  // 启动：读配置 → 恢复上次项目 → 恢复 keychain 状态
  useEffect(() => {
    void useAppStore.getState().boot()
  }, [])

  // 主题应用：偏好 system/light/dark → 实际 data-theme；system 态跟随系统配色（白天浅、晚上深）
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

  // 预览 iframe 选取的元素 → 带入聊天下轮上下文
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; payload?: { selector: string; tag: string; id: string; text: string } }
      if (d?.type === 'workbench-element-picked' && d.payload?.selector) {
        useChatStore.getState().setPendingElement(d.payload)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // 会话历史持久化：messages 变化时（防抖 400ms）写入 ~/.qyris/sessions/
  useEffect(() => {
    if (!isDesktop) return
    let timer: number | null = null
    const unsub = useChatStore.subscribe((state, prev) => {
      if (state.messages === prev.messages) return
      const { projectPath } = useAppStore.getState()
      if (!projectPath) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const toSave = state.messages.map((m) =>
          m.pending ? { ...m, pending: false, content: m.content || '' } : m,
        )
        void api.saveSession(projectPath, toSave).catch(() => {})
      }, 400)
    })
    return () => {
      unsub()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  // 全局事件接线：编译输出 / 退出码 / AI 增量 / 文件变更
  useEffect(() => {
    if (!isDesktop) return
    const offs = [
      onBuildOutput((p) => useBuildStore.getState().onOutput(p.name, p.stream, p.line)),
      onBuildExit((p) => useBuildStore.getState().onExit(p.name, p.code)),
      onAiDelta((p) => useChatStore.getState().appendDelta(p.requestId, p.delta)),
      onAiReasoning((p) => useChatStore.getState().appendReasoning(p.requestId, p.delta)),
      onCliToolEvent((p) => useChatStore.getState().handleCliToolEvent(p.requestId, p.id, p.name, p.phase, p.arguments)),
      onFsChanged((p) => { scheduleFsRefresh(p.paths) }),
    ]
    return () => { offs.forEach((f) => f()) }
  }, [])

  /** 主分割线拖拽：左工作区 ≥ 500px，右对话栏 ≥ 300px */
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const rect = body.getBoundingClientRect()
    const move = (clientX: number) => {
      const total = rect.width
      let r = (clientX - rect.left) / total
      r = Math.max(500 / total, r)
      r = Math.min(1 - 300 / total, r)
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

  return (
    <div className="app">
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
        <div
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

function scheduleFsRefresh(paths: string[]) {
  pendingPaths.push(...paths.slice(0, 50))
  if (fsTimer !== null) return
  fsTimer = window.setTimeout(() => {
    const unique = [...new Set(pendingPaths)]
    pendingPaths = []
    fsTimer = null
    void useFileStore.getState().notifyExternalChange(unique)
  }, 400)
}
