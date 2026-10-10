/**
 * 会话级运行上下文旁挂 —— ToolCtx 的补充通道。
 *
 * 为什么旁挂而不是扩 ToolCtx：model/types.ts 是冻结契约（ToolCtx 只有 projectRoot/signal/permission），
 * 但交互型工具（dispatch_subtasks）要发 cli-agent-event / cli-tool-event，载荷必须带 requestId、
 * 且要走发起窗口的事件出口（emitToWindow + 其余窗口镜像）——这些是「本次 run」的元数据，
 * 语义上属于会话，不属于工具。用 AbortSignal 做键：每个 aiChatStream 一个 AbortController，
 * signal 在整条 run 链（provider + 每个工具 ctx）里是同一个对象，天然唯一、run 结束可被 GC。
 *
 * 只服务「工具要知道自己属于哪次请求」这一件事；模型/补全能力仍然走 ModelProvider 契约。
 */
import type { ToolCtx } from './types'
import type { HostToolProxyTarget } from '../mcp/proxy'

export interface AgentRunContext {
  /** 本次 aiChatStream 的 requestId（事件载荷的路由键） */
  requestId: string
  /** 事件出口（ai.ts 的 emit 闭包：发起窗口定向 + 其余窗口镜像，载荷自动带 projectRoot） */
  emit: (event: string, payload: Record<string, unknown>) => void
  /** 本次 run 的主进程代行通道（子 agent 挂 MCP 时复用，见 tools/subagent.ts）；null = 未开 */
  hostProxy: HostToolProxyTarget | null
}

const contexts = new WeakMap<object, AgentRunContext>()

/** 注册（由 aiChatStream 在 runAgent 前调用一次） */
export function setAgentRunContext(signal: AbortSignal | undefined, ctx: AgentRunContext): void {
  if (signal) contexts.set(signal, ctx)
}

/** 查询（工具侧按 ctx.signal 取自己的 run 元数据） */
export function getAgentRunContext(ctx: Pick<ToolCtx, 'signal'>): AgentRunContext | null {
  return (ctx.signal ? contexts.get(ctx.signal) : null) ?? null
}
