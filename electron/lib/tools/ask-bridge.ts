/**
 * CLI 档 askUserQuestion 回填桥：主进程代行 executor 挂起，等渲染层 AskUserCard 的回答。
 *
 * 与 API 档的差异（见 tools/ask.ts 的延迟语义）：API 档答案只活在渲染层 store 与下一轮消息
 * 历史里，主进程无可等通道；CLI 档的工具循环住在 claude-cli 子进程里，MCP 往返必须由主进程
 * 应答——本桥就是那条回填通道：emit cli-ask → 渲染层 pendingAsk 挂起 → cli_ask_answer IPC →
 * executor 以 ToolResult 收口，claude-cli 拿着答案续跑。
 *
 * 收口三通道（任一先到即定局，Map 删除保证只 settle 一次）：
 *   · 用户回答 → answerCliAsk(askId, answer) → 正常结果；
 *   · 用户取消挂起（停止生成 / 清空对话）→ answerCliAsk(askId, '') → isError 结果；
 *   · run 中止/结束 → AbortSignal 监听（ai.ts 绑定）与 cancelAsksOf(requestId) 兜底清账。
 */
import type { ToolResult } from '../model/types'

interface PendingCliAsk {
  requestId: string
  resolve: (r: ToolResult) => void
}

const pending = new Map<string, PendingCliAsk>()

/** 登记一次挂起；返回注销函数（abort 监听等提前收口方调用，幂等） */
export function registerCliAsk(askId: string, requestId: string, resolve: (r: ToolResult) => void): () => void {
  const entry: PendingCliAsk = { requestId, resolve }
  pending.set(askId, entry)
  return () => {
    if (pending.get(askId) === entry) pending.delete(askId)
  }
}

/** 渲染层回填：answer 非空 = 正常回答；空串 = 用户取消挂起（isError，模型拿到失败可自纠）。
 *  返回 false = askId 已收口/不存在（重复回填静默忽略） */
export function answerCliAsk(askId: string, answer: string): boolean {
  const p = pending.get(askId)
  if (!p) return false
  pending.delete(askId)
  const text = answer.trim()
  p.resolve(text ? { content: `用户回答：${text}` } : { content: '用户取消了本次提问', isError: true })
  return true
}

/** run 收尾清账：该 requestId 下仍未收口的挂起全部按取消结案（防渲染层已关闭时的永久悬挂） */
export function cancelAsksOf(requestId: string): void {
  for (const [askId, p] of pending) {
    if (p.requestId !== requestId) continue
    pending.delete(askId)
    p.resolve({ content: '用户取消了本次提问', isError: true })
  }
}
