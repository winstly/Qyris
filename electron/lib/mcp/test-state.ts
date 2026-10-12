/**
 * MCP 测试结果的进程级状态（主进程持有，UI 组件只读展示）：
 * 结果/工具列表不随面板卸载丢失（组件态易失是「切回来变未测试」的根因）。
 * 软件启动 / 切换工程 / 配置表变化时自动测一轮（runAutoTest），结果经 mcp-test-state 广播。
 * 自动测同时预热连接池（ensureExternalTools）——聊天首轮即可见 mcp__ 工具，消掉冷启动盲窗。
 */
import type { McpServerEntry } from '../../../shared/mcp'
import type { McpTestResult } from '../../../shared/ipc-types'
import { projectConfigKey } from '../../../shared/project-key'
import { activeMcpServers, getConfig, isMcpEnabled } from '../config'
import { emitToAllWindows } from '../emitter'
import { ensureExternalTools, testExternalServer } from './external'

/** 结果键：`${scope}::${name}`，scope = 'global' | projectConfigKey(projectRoot) */
function resultKey(scope: string, name: string): string {
  return `${scope}::${name}`
}

export function scopeOf(projectRoot: string | null | undefined): string {
  return projectRoot ? projectConfigKey(projectRoot) : 'global'
}

const states = new Map<string, McpTestResult>()

function broadcast(): void {
  emitToAllWindows('mcp-test-state', getTestStates())
}

/** 全量快照（渲染层挂载时拉一次 + 事件增量刷新） */
export function getTestStates(): Record<string, McpTestResult> {
  return Object.fromEntries(states)
}

/** 单个测试（面板「测试」按钮与自动测共用）：结果进进程级状态并广播 */
export async function runMcpTest(
  scope: string,
  name: string,
  entry: McpServerEntry,
): Promise<McpTestResult> {
  states.set(resultKey(scope, name), { ok: false, tools: [], testing: true })
  broadcast()
  const r = await testExternalServer(name, entry)
  const out: McpTestResult = { ...r, testedAt: Date.now() }
  states.set(resultKey(scope, name), out)
  broadcast()
  return out
}

/**
 * 自动测一轮：全局域 + 指定工程域的全部启用 server（并发上限 3，失败不阻断其余）。
 * 同时预热工程连接池（fire-and-forget）：聊天首轮起工具面即为可达面。
 */
export async function runAutoTest(projectRoot: string | null): Promise<void> {
  const cfg = await getConfig()
  const global = activeMcpServers(cfg, null)
  const project = projectRoot ? activeMcpServers(cfg, projectRoot) : {}
  const entries: [string, string, McpServerEntry][] = []
  const usable = (e: McpServerEntry): boolean => isMcpEnabled(e) && !!(e.command?.trim() || e.url?.trim())
  for (const [name, entry] of Object.entries(global)) if (usable(entry)) entries.push(['global', name, entry])
  if (projectRoot) {
    for (const [name, entry] of Object.entries(project)) if (usable(entry)) entries.push([scopeOf(projectRoot), name, entry])
  }
  // 并发 3 一批（npx 冷启动重，串行太慢、全并行打爆）；单测失败不阻断其余
  for (let i = 0; i < entries.length; i += 3) {
    await Promise.allSettled(
      entries.slice(i, i + 3).map(([scope, name, entry]) => runMcpTest(scope, name, entry)),
    )
  }
  // 连接池预热：测试是独立建连（不进池），池的就绪才是聊天首轮可见的前提
  void ensureExternalTools(projectRoot).catch(() => { /* 失败只丢外部工具，不阻断 */ })
}
