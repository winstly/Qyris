/**
 * 主窗口 / 桌宠面板两个渲染入口共用的运行时接线：
 *  - useDesktopEvents：全局编译/AI/镜像事件订阅 + AI 增量微任务批合。
 *    两入口只有 fs 变更与元素拾取的处理不同（参数化注入），其余必须严格一致——
 *    面板与主窗口渲染同一场对话，事件处理代码分成两份必然漂移。
 *  - useThemeSync：主题解析与应用（含跟随系统）。
 *  - usePetChatStatus：本窗口对话状态上报主进程，聚合驱动桌宠动画。
 */
import { useEffect } from 'react'
import { useAppStore, checkpointFileStore, type Theme } from '@/store/useAppStore'
import { useBuildStore } from '@/store/useBuildStore'
import { useChatStore } from '@/store/useChatStore'
import { useFileStore } from '@/store/useFileStore'
import { useAgentStore } from '@/store/useAgentStore'
import { useStartupStore } from '@/store/useStartupStore'
import { basename } from '@/utils/path'
import {
  api,
  onBuildOutput, onBuildExit, onAiDelta, onAiReasoning,
  onCliToolEvent, onCliToolResult, onCliAgentEvent,
  onChatMirror, onChatRequestDone,
  onFsChanged as subscribeFsChanged,
  onElementPicked,
  onConfigChanged, onProjectChanged, isDesktop, setPetChatState,
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
      onConfigChanged(() => {
        const app = useAppStore.getState()
        void app.refreshRemoteConfig()
        // 密钥增删（main 在 set/delete_secret 后补发本事件）也在此刷新——
        // 面板无 SettingsDialog，不补这条则 hasApiKey 直到重启都不会更新
        void app.refreshHasApiKey()
      }),
      // 跨窗口项目同步：另一窗口切换项目后，本窗口静默切换（不广播，不触发远端 openProject）
      onProjectChanged((p) => {
        const app = useAppStore.getState()
        // 关闭项目：只清理本窗口该工程的 store，不触碰其余工程
        if (p.closedProject) {
          useBuildStore.getState().closeProject(p.closedProject)
          useChatStore.getState().closeProject(p.closedProject)
          useAgentStore.getState().closeProject(p.closedProject)
          if (app.projectPath === p.closedProject) {
            useFileStore.getState().reset()
            // 置空 projectPath：否则重开同一项目时 p.projectPath === app.projectPath，
            // 重载分支被跳过 → 端侧躺在已删除的 store 上什么也不加载
            app.setProjectPath(null)
            api.setWindowTitle('轻驭').catch(() => {})
          }
        }
        // 同步 openProjects 列表：双窗口取并集（再剔除被关闭项）——任一窗口广播的都只是
        // 全局打开集的子集，直接覆盖会把对方打开的项目从 ProjectSwitcher/ProjectsTab 挤掉
        app.setOpenProjects(
          [...new Set([...p.openProjects, ...useAppStore.getState().openProjects])].filter((x) => x !== p.closedProject),
        )
        // 切换项目：静默版——不调 openProject（避免重入广播），直接更新所有 store
        if (p.projectPath && p.projectPath !== app.projectPath) {
          // 切走前快照当前工程文件态（与 openProject 一致；漏掉则切回时恢复旧快照，未保存编辑丢失）
          if (app.projectPath) checkpointFileStore(app.projectPath)
          // setProjectPath 同步刷新项目级镜像（startupCommands / projectSkillsDirs / projectSkillMetas）
          app.setProjectPath(p.projectPath)
          // 补齐 openProject 会做的 store 同步（轻量版，不触发广播）
          useBuildStore.getState().ensureProject(p.projectPath)
          useBuildStore.getState().setCurrent(p.projectPath)
          useAgentStore.getState().ensureProject(p.projectPath)
          useAgentStore.getState().setCurrent(p.projectPath)
          useStartupStore.getState().setCurrentProject(p.projectPath)
          useFileStore.getState().openProject(p.projectPath).catch(() => {})
          // 订阅该工程文件变更（openProject 同款）——否则本窗口不在 watcher 名单，文件树不自动刷新
          void api.startWatching(p.projectPath).catch(() => {})
          // 标题跟随当前工程（openProject 的 setWindowTitle 只作用于发送方窗口）
          api.setWindowTitle(`${basename(p.projectPath)} — 轻驭`).catch(() => {})
          void useChatStore.getState().ensureProjectFromDb(p.projectPath)
          // 项目级 Skill（fire-and-forget，与 openProject 一致）
          void app.loadProjectSkills()
        }
      }),
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
