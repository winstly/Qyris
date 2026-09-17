/**
 * 主窗口 / 桌宠面板两个渲染入口共用的运行时接线：
 *  - useDesktopEvents：全局编译/AI/镜像事件订阅 + AI 增量微任务批合。
 *    两入口只有 fs 变更与元素拾取的处理不同（参数化注入），其余必须严格一致——
 *    面板与主窗口渲染同一场对话，事件处理代码分成两份必然漂移。
 *  - useThemeSync：主题解析与应用（含跟随系统）。
 *  - usePetChatStatus：本窗口对话状态上报主进程，聚合驱动桌宠动画。
 */
import { useEffect } from 'react'
import { useAppStore, type Theme } from '@/store/useAppStore'
import { useBuildStore } from '@/store/useBuildStore'
import { useChatStore } from '@/store/useChatStore'
import {
  onBuildOutput, onBuildExit, onAiDelta, onAiReasoning,
  onCliToolEvent, onCliToolResult, onCliAgentEvent,
  onChatMirror, onChatRequestDone,
  onFsChanged as subscribeFsChanged,
  onElementPicked,
  onConfigChanged, isDesktop, setPetChatState,
} from '@/services/desktop'

export interface DesktopEventHooks {
  /** 文件变更原始载荷（主窗口做当前工程过滤+节流合并，面板直接刷新） */
  onFsChanged?: (p: { paths: string[]; projectRoot?: string }) => void
}

export function useDesktopEvents(hooks: DesktopEventHooks = {}): void {
  const { onFsChanged } = hooks
  useEffect(() => {
    if (!isDesktop) return
    // AI 增量微任务批合：同一微任务内到达的 N 个 delta 合并为每 requestId 一次 store 更新
    //（流式每 token 触发全列表渲染是长会话卡顿主因；配合 MessageBubble 的 memo 生效）
    const deltaBuf = new Map<string, { text: string; projectRoot?: string }>()
    const reasoningBuf = new Map<string, { text: string; projectRoot?: string }>()
    let deltasScheduled = false
    const flushDeltas = () => {
      deltasScheduled = false
      if (deltaBuf.size === 0 && reasoningBuf.size === 0) return
      const ds = [...deltaBuf.entries()]
      const rs = [...reasoningBuf.entries()]
      deltaBuf.clear()
      reasoningBuf.clear()
      const chat = useChatStore.getState()
      for (const [rid, b] of ds) chat.appendDelta(rid, b.text, b.projectRoot)
      for (const [rid, b] of rs) chat.appendReasoning(rid, b.text, b.projectRoot)
    }
    const bufferChunk = (buf: Map<string, { text: string; projectRoot?: string }>, requestId: string, text: string, projectRoot?: string) => {
      const prev = buf.get(requestId)
      buf.set(requestId, { text: (prev?.text ?? '') + text, projectRoot: projectRoot ?? prev?.projectRoot })
      if (!deltasScheduled) {
        deltasScheduled = true
        queueMicrotask(flushDeltas)
      }
    }
    const mirrorDispatch = (p: { kind: 'user-message' | 'finalized' | 'cleared'; projectRoot: string; message?: unknown; msg?: unknown }) => {
      const chat = useChatStore.getState()
      if (p.kind === 'user-message') chat.receiveMirroredUserMessage(p.projectRoot, p.message as import('@/types').ChatMessage)
      else if (p.kind === 'finalized') chat.receiveMirroredFinalized(p.projectRoot, p.msg as import('@/types').ChatMessage)
      else chat.resyncMirror(p.projectRoot)
    }
    const offs = [
      onBuildOutput((p) => useBuildStore.getState().onOutput(p.projectRoot ?? useAppStore.getState().projectPath ?? '', p.name, p.stream, p.line)),
      onBuildExit((p) => useBuildStore.getState().onExit(p.projectRoot ?? useAppStore.getState().projectPath ?? '', p.name, p.code)),
      onAiDelta((p) => bufferChunk(deltaBuf, p.requestId, p.delta, p.projectRoot)),
      onAiReasoning((p) => bufferChunk(reasoningBuf, p.requestId, p.delta, p.projectRoot)),
      onCliToolEvent((p) => useChatStore.getState().handleCliToolEvent(p.requestId, p.id, p.name, p.phase, p.arguments, p.projectRoot)),
      onCliToolResult((p) => useChatStore.getState().handleCliToolResult(p.requestId, p.id, p.content, p.isError, p.tokens, p.projectRoot)),
      onCliAgentEvent((p) => useChatStore.getState().handleCliAgentEvent(p)),
      // 镜像管道：另一窗口（桌宠面板 ↔ 主窗口）的对话稳定点推送与本端请求收场广播
      onChatMirror(mirrorDispatch),
      onChatRequestDone((p) => useChatStore.getState().finishMirroredRequest(p.requestId, p.projectRoot, p.hasError)),
      ...(onFsChanged ? [subscribeFsChanged((p) => onFsChanged(p))] : []),
      onElementPicked((p) => useChatStore.getState().setPendingElement(p)),
      // 多窗口配置同步：任一窗口/主进程改配置后，本窗口按变化键刷新镜像
      onConfigChanged(() => { void useAppStore.getState().refreshRemoteConfig() }),
    ]
    return () => { offs.forEach((f) => f()) }
  }, [])
}

/** 主题应用：解析 system/light/dark 并写到 documentElement（主窗口与面板共用） */
export function useThemeSync(theme: Theme): void {
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
}

/** 桌宠动画跟随本窗口对话状态：生成中→working、等你回答→waiting（主进程跨窗口聚合，任一窗口忙即忙） */
export function usePetChatStatus(): void {
  const chatStatus = useChatStore((s) => (s.current ? s.byProject[s.current] : undefined)?.status ?? 'idle')
  useEffect(() => {
    setPetChatState(chatStatus)
  }, [chatStatus])
}
