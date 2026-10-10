/**
 * ToolRegistry —— 模型生态统一的工具注册表（tools/ 唯一对外出口）。
 *
 * 职责：
 *   1. 注册全部自有工具（fs / git / shell / project / skill / ask / subagent / remote / memory / preview），暴露 ToolSchema[] 给 provider；
 *   2. 按权限档过滤：readonly ⊂ write ⊂ exec，高档包含低档；
 *   3. executeTool 是唯一执行入口：查表 → 权限复核（fail-closed）→ 执行 → 结果统一截断；
 *   4. isDeferredTool 标记交互型工具（askUserQuestion）：runner 延迟整轮给调用方，不在主进程执行。
 *
 * 契约来源：../model/types.ts（不在此层改语义，只做编排）。
 */
import type { Tool, ToolCtx, ToolPermission, ToolResult, ToolSchema } from '../model/types'
import { errorMessage } from '../util'
import { fsTools } from './fs'
import { gitTools } from './git'
import { shellTools } from './shell'
import { projectTools } from './project'
import { skillTools } from './skill'
import { askTools } from './ask'
import { subagentTools } from './subagent'
import { remoteTools } from './remote'
import { memoryTools } from './memory'
import { previewTools } from './preview'

/** 权限档高低序：高档包含低档 */
const PERM_RANK: Record<ToolPermission, number> = { readonly: 0, write: 1, exec: 2 }

/** 档位查询 fail-closed：未知档位按最低档处理 */
function rankOf(perm: ToolPermission): number {
  return PERM_RANK[perm] ?? 0
}

/** 注册表（模块加载期构建一次，顺序稳定：fs → git → shell → project → skill → ask → subagent → remote → memory → preview） */
const TOOLS: readonly Tool[] = [
  ...fsTools,
  ...gitTools,
  ...shellTools,
  ...projectTools,
  ...skillTools,
  ...askTools,
  ...subagentTools,
  ...remoteTools,
  ...memoryTools,
  ...previewTools,
]
const BY_NAME: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * 交互型工具名单：不在主进程执行，本轮 toolUse 原样交回调用方（见 tools/ask.ts 的选边说明）。
 * runner 遇到名单内工具即「延迟整轮」：不执行、不发 tool-start/tool-end、结束 run。
 */
export function isDeferredTool(name: string): boolean {
  return name === 'askUserQuestion'
}

/** 单条工具结果的统一截断上限（字符）：大输出标注截断，避免吃爆上下文 */
const MAX_RESULT_CHARS = 60_000
const TRUNCATION_MARK = '\n…（结果过长，已截断）'

/** 全部工具（注册顺序） */
export function allTools(): Tool[] {
  return [...TOOLS]
}

/** 供 provider 下发的工具清单（缺省 = 全部） */
export function toolSchemas(tools: readonly Tool[] = TOOLS): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

/** 按权限档过滤：返回该档可用的全部工具（含低档工具） */
export function toolsForPermission(perm: ToolPermission): Tool[] {
  const max = rankOf(perm)
  return TOOLS.filter((t) => rankOf(t.permission) <= max)
}

export function getTool(name: string): Tool | undefined {
  return BY_NAME.get(name)
}

/** 执行工具：未知工具 / 权限不足 / 抛错 都收敛为 isError 结果，不让异常漏到 runner */
export async function executeTool(name: string, input: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const tool = BY_NAME.get(name)
  if (!tool) return { content: `未知工具：${name}`, isError: true }
  if (rankOf(tool.permission) > rankOf(ctx.permission)) {
    return {
      content: `权限不足：${name} 需要「${tool.permission}」档，当前「${ctx.permission}」档`,
      isError: true,
    }
  }
  try {
    const result = await tool.execute(input, ctx)
    return clampToolResult(result)
  } catch (e) {
    return { content: `工具执行失败：${errorMessage(e)}`, isError: true }
  }
}

/**
 * 结果统一截断（工具自截之外的兜底）。
 * **必须导出并由所有执行路径共用**——runner 为依赖注入走 `tool.execute` 直调，
 * 不经 executeTool；若不同口径，超长输出会绕过这道兜底吃爆上下文。
 */
export function clampToolResult(result: ToolResult): ToolResult {
  const content = typeof result.content === 'string' ? result.content : String(result.content)
  const clipped =
    content.length > MAX_RESULT_CHARS ? content.slice(0, MAX_RESULT_CHARS) + TRUNCATION_MARK : content
  return result.isError ? { content: clipped, isError: true } : { content: clipped }
}
