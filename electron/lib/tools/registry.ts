/**
 * ToolRegistry 核心 —— 查询 / 过滤 / 执行 / 截断（tools/ 的叶子模块，不依赖任何工具实现，
 * skill/subagent 与装配点都静态引用本模块，无循环依赖）。
 *
 * 工具面构成：内置静态面（index.ts 经 adoptTools() 在模块加载期注入，数组序即注册序）
 *           + 外部 MCP 动态面（../mcp/external，连接成功的 server 才在列）。
 * 消费契约：查表前必须已加载 tools/index（装配点）——直接引本模块/子工具模块的消费方
 *           （含测试）不加载装配点就会查到空表。
 * 契约来源：../model/types.ts（不在此层改语义，只做编排）。
 */
import type { Tool, ToolCtx, ToolPermission, ToolResult } from '../model/types'
import { errorMessage } from '../util'
import { externalTools } from '../mcp/external'

/** 权限档高低序：高档包含低档 */
const PERM_RANK: Record<ToolPermission, number> = { readonly: 0, write: 1, exec: 2 }

/** 档位查询 fail-closed：未知档位按最低档处理 */
function rankOf(perm: ToolPermission): number {
  return PERM_RANK[perm] ?? 0
}

let staticTools: readonly Tool[] = []
let byName: ReadonlyMap<string, Tool> = new Map()

/** 注入内置工具面（tools/index.ts 模块加载期调用一次；数组序 = 注册序） */
export function adoptTools(tools: readonly Tool[]): void {
  staticTools = tools
  byName = new Map(tools.map((t) => [t.name, t]))
}

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

/** 全部工具（注册顺序）：内置静态序在前 + 该工程域的外部 MCP 动态（仅连接成功的 server，见 mcp/external） */
export function allTools(projectRoot?: string | null): Tool[] {
  return [...staticTools, ...externalTools(projectRoot)]
}

/** 按权限档过滤：返回该档可用的全部工具（含低档工具） */
export function toolsForPermission(perm: ToolPermission, projectRoot?: string | null): Tool[] {
  const max = rankOf(perm)
  return allTools(projectRoot).filter((t) => rankOf(t.permission) <= max)
}

export function getTool(name: string, projectRoot?: string | null): Tool | undefined {
  // 外部 MCP 工具（mcp__<server>__<tool>）动态注册，内置表不含
  return byName.get(name) ?? externalTools(projectRoot).find((t) => t.name === name)
}

/** 执行工具：未知工具 / 权限不足 / 抛错 都收敛为 isError 结果，不让异常漏到 runner */
export async function executeTool(name: string, input: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const tool = getTool(name, ctx.projectRoot)
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
