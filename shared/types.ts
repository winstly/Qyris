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
