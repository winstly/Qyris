/**
 * 跨进程共享类型（渲染层与主进程 tsconfig 均包含 shared/，作为 IPC 载荷契约的单一出处）。
 * 注意：本文件不得 import node/electron 任何模块。
 */

/** 文件快照版本（快照 v2：null = 会话基线快照，否则为版本 key） */
export interface SnapshotVersion {
  ts: number
  versionKey: string | null
  sessionId: string
}

/** 对话镜像 relay 载荷（桌宠面板 ↔ 主窗口同一场对话）。
 *  user-message=对方刚发出的用户消息；finalized=某条 assistant 消息稳定点最新态；
 *  cleared=对方清空对话（开新会话）。message/msg 结构与渲染层 ChatMessage 一致
 *  （跨 tsconfig 隔离，此处内联透传 unknown，渲染层自行收窄）。 */
export interface ChatMirrorPayload {
  kind: 'user-message' | 'finalized' | 'cleared'
  projectRoot: string
  message?: unknown
  msg?: unknown
}
