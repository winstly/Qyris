/**
 * 子任务 agent 执行器：主对话通过 dispatch_subtasks 派发子任务。
 * 每个子任务在独立上下文中运行（独立系统提示 + 消息历史，不污染主对话），
 * 按 tier 选择档位模型（未配置回退主模型），复用主对话的工具集（禁止嵌套派发）。
 * 取消联动：主对话「停止生成」后，子任务在轮次检查点退出。
 */
import { api } from './desktop'
import { executeTool } from './tools'
import { TOOL_DEFS } from './ai'
import { useAppStore } from '@/store/useAppStore'
import { useChatStore } from '@/store/useChatStore'
import { useAgentStore } from '@/store/useAgentStore'
import { uid, safeParseObject } from '@/utils/id'
import { estimateTokens } from '@/utils/tokens'
import type { AiCompletion, OAIMessage } from '@/types'

export type ModelTier = 'main' | 'thinking' | 'fast' | 'middle' | 'heavy'

export interface SubTask {
  title: string
  instruction: string
  tier?: ModelTier
}

const MAX_ROUNDS = 20

/** 在途子 agent 模型请求 id 注册表：「停止生成」需要连子 agent 的请求一起取消 */
const activeRequests = new Set<string>()

/** 硬取消全部在途子 agent 模型调用（useChatStore.cancel 调用） */
export function cancelActiveAgentRequests(): void {
  for (const requestId of activeRequests) {
    void api.aiCancel(requestId).catch(() => {})
  }
  activeRequests.clear()
}

/** 档位 → 模型名：未配置的档位回退主模型 */
export function modelForTier(tier?: string): string {
  const { settings } = useAppStore.getState()
  if (tier && tier !== 'main') {
    const t = settings.tiers
    const m =
      tier === 'thinking' ? t?.thinking
      : tier === 'fast' ? t?.fast
      : tier === 'middle' ? t?.middle
      : tier === 'heavy' ? t?.heavy
      : undefined
    if (m?.trim()) return m.trim()
  }
  return settings.model
}

function subagentSystemPrompt(): string {
  const { projectPath } = useAppStore.getState()
  const lines = [
    '你是轻驭工作台的子任务执行 agent，在独立上下文中完成主 agent 派发的单个任务。',
    '用简体中文；代码、命令、标识符保持原样；过程简洁直接，不写客套话。',
    '你拥有与主对话相同的项目工具（list_files / search_files / read_file / write_file / run_once / get_build_status 等）。修改文件前必须先 read_file 获取真实内容，禁止凭空臆造。',
    '不要派发子任务、不要向用户提问——无法完成时在最终回复中说明原因与已尝试的步骤。',
    projectPath
      ? `当前项目目录：${projectPath}。工具的 path/dir 参数传项目内相对路径。`
      : '当前未打开项目，仅能做与文件无关的分析。',
    '完成指令后，最终回复必须给出：做了什么、关键结果/文件路径、遗留风险。这段总结会回传给主 agent。',
  ]
  return lines.join('\n')
}

function toHistoryEntry(c: AiCompletion): OAIMessage {
  return {
    role: 'assistant',
    content: c.content ?? null,
    tool_calls: c.toolCalls.length
      ? c.toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.arguments },
        }))
      : undefined,
  }
}

/** 单次执行结果：kind 供重试策略判定（model-error 可重试；rounds 是确定性失败不重试） */
type RunOutcome = { text: string; kind: 'done' | 'cancelled' | 'model-error' | 'rounds' }

async function runOne(task: SubTask, threadId: string): Promise<RunOutcome> {
  const { settings, projectPath } = useAppStore.getState()
  const agents = useAgentStore.getState()
  agents.beginThread(threadId)
  const model = modelForTier(task.tier)
  const messages: OAIMessage[] = [
    { role: 'system', content: subagentSystemPrompt() },
    { role: 'user', content: task.instruction },
  ]
  // 本子 agent 独立记账：各轮 input（上下文）与 output（生成）累计
  const used = { input: 0, output: 0 }

  const finish = (kind: RunOutcome['kind'], result: string): RunOutcome => {
    const status = kind === 'done' ? 'done' : kind === 'cancelled' ? 'cancelled' : 'error'
    useAgentStore.getState().finishThread(threadId, status, result, { ...used })
    return { text: result, kind }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (useChatStore.getState().cancelled) return finish('cancelled', '（主对话已取消，子任务中止）')
    let completion: AiCompletion
    const requestId = uid()
    activeRequests.add(requestId)
    try {
      completion = await api.aiChatStream(requestId, settings.provider, settings.baseUrl, model, messages, TOOL_DEFS, settings.dispatchMode, projectPath)
    } catch (e) {
      // 取消引发的请求中止按取消收尾，不算错误
      if (useChatStore.getState().cancelled) return finish('cancelled', '（已取消）')
      return finish('model-error', `子任务执行失败（模型调用出错）：${String(e)}`)
    } finally {
      activeRequests.delete(requestId)
    }
    // 记账：input=本轮完整上下文，output=本轮生成（含思考）
    let inputTok = 0
    for (const m of messages) {
      if (typeof m.content === 'string') inputTok += estimateTokens(m.content)
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) inputTok += estimateTokens(tc.function.arguments ?? '')
      }
    }
    used.input += inputTok
    used.output += estimateTokens((completion.content ?? '') + (completion.reasoning ?? ''))
    if (completion.content?.trim()) {
      useAgentStore.getState().appendText(threadId, completion.content.trim())
    }
    messages.push(toHistoryEntry(completion))
    if (completion.toolCalls.length === 0) {
      return finish('done', completion.content?.trim() || '（子任务完成，无文本返回）')
    }
    for (const tc of completion.toolCalls) {
      if (useChatStore.getState().cancelled) return finish('cancelled', '（已取消）')
      const args = safeParseObject(tc.arguments)
      useAgentStore.getState().appendTool(threadId, {
        id: tc.id, name: tc.name,
        summary: tc.name === 'dispatch_subtasks' ? '禁止嵌套派发' : '执行中…',
        status: 'running',
      })
      const out = tc.name === 'dispatch_subtasks'
        ? { result: '错误：子任务内不能再派发子任务（禁止嵌套），请自行完成该工作。', summary: '禁止嵌套派发' }
        : await executeTool(tc.name, args)
      const ok = !out.result.startsWith('错误') && !out.result.startsWith('工具执行失败')
      useAgentStore.getState().patchTool(threadId, tc.id, {
        status: ok ? 'done' : 'error',
        summary: out.summary,
      })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.result })
    }
  }
  return finish('rounds', '（达到轮数上限，子任务未完成）')
}

/** 带自动重试的执行：模型调用类失败重试一次（转录保留失败痕迹）；取消/轮数上限不重试 */
async function runOneWithRetry(task: SubTask, threadId: string): Promise<RunOutcome> {
  const first = await runOne(task, threadId)
  if (first.kind !== 'model-error') return first
  useAgentStore.getState().appendText(threadId, '—— 执行失败，自动重试 ——')
  return runOne(task, threadId)
}

export interface SubtaskRunSummary {
  title: string
  status: string
  model: string
  text: string
}

export interface SubtaskRunOutcome {
  results: SubtaskRunSummary[]
  /** 本批次全部子 agent 的 token 总消耗（汇总进主对话展示） */
  total: { input: number; output: number }
}

/** 并行执行子任务清单（threadIds 由 dispatch 工具预先创建），返回各任务摘要结果 + token 总账 */
export async function runSubtasks(tasks: SubTask[], threadIds: string[]): Promise<SubtaskRunOutcome> {
  const outcomes = await Promise.all(
    tasks.map(async (t, i) => {
      const threadId = threadIds[i]
      if (useChatStore.getState().cancelled) {
        if (threadId) useAgentStore.getState().finishThread(threadId, 'cancelled', '（主对话已取消，未执行）')
        return { text: '（主对话已取消，未执行）', kind: 'cancelled' as const }
      }
      return runOneWithRetry(t, threadId)
    }),
  )

  // 汇总本批次 token 总账（从各线程读回，与面板展示同源）
  const store = useAgentStore.getState()
  const total = threadIds.reduce(
    (acc, id) => {
      const tk = store.threads[id]?.tokens
      if (tk) {
        acc.input += tk.input
        acc.output += tk.output
      }
      return acc
    },
    { input: 0, output: 0 },
  )

  const results: SubtaskRunSummary[] = tasks.map((t, i) => ({
    title: t.title,
    status: store.threads[threadIds[i]]?.status ?? 'done',
    model: modelForTier(t.tier),
    text: outcomes[i].text,
  }))
  return { results, total }
}
