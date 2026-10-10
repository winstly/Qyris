/**
 * runner 自持循环（executesOwnTools / MCP 模式）救援门控回归。
 *
 * 背景（2026-10-08 线上「构建部署双跑」）：自持路径的「只说不做」推进 nudge 与
 * 伪标签/围栏救援都是为「零执行的弱网关模型」设计的；模型真经 MCP 执行过工具后，
 * 正文里的计划文本是交付物、伪标签是已执行调用的复述——再救援/nudge 会把整条
 * 无状态 CLI 补全原样重跑（且 replay 无前轮工具结果），部署在服务端跑两遍。
 *
 * 断言：
 *   ① hadToolExec + 计划形态正文 → 不 nudge（provider.complete 只跑一轮）
 *   ② hadToolExec + 伪标签复述 → 不救援重执行（spy 工具零调用）
 *   ③ 零执行 + 计划形态 → nudge 照常触发（GLM 弱网关救援语义保留，跑两轮）
 *   ④ 零执行 + 围栏调用 → 照常救援执行（spy 工具调用一次）
 * 运行：npm run smoke:runner-mcp
 */
import { runAgent } from '../electron/lib/model/runner'
import { ConversationStore } from '../electron/lib/model/store'
import type { CompletionEvent, Message, ModelProvider, Tool, ToolCtx, ToolResult } from '../electron/lib/model/types'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

const msg = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })

function scriptedProvider(passes: CompletionEvent[][]): { provider: ModelProvider; passCount: () => number } {
  let pass = 0
  const provider: ModelProvider = {
    id: 'fake-mcp',
    capabilities: { executesOwnTools: true },
    async *complete(): AsyncGenerator<CompletionEvent> {
      const events = passes[Math.min(pass, passes.length - 1)]
      pass++
      yield* events
    },
  }
  return { provider, passCount: () => pass }
}

function spyTool(calls: unknown[]): Tool {
  return {
    name: 'run_command',
    description: 'spy',
    inputSchema: { type: 'object' },
    permission: 'exec',
    async execute(input: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      calls.push(input)
      return { content: '[spy] ran' }
    },
  }
}

async function runOnce(provider: ModelProvider, tools: Tool[]): Promise<{ events: string[]; finalText: string }> {
  const store = new ConversationStore({ provider: provider.id })
  const events: string[] = []
  const finalMsg = await runAgent('部署探针', {
    provider,
    store,
    tools,
    permission: 'exec',
    maxTurns: 6,
    onEvent: (e) => events.push(e.type),
  })
  return { events, finalText: finalMsg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('') }
}

async function main(): Promise<void> {
  const PLANISH = '部署已完成。后续步骤：1) 清理临时目录 2) 校验服务标签。'
  const NARRATION = '我已调用 <qyris-cmd>run_command {"command":"echo again"}</qyris-cmd> 完成部署。'
  const FENCE = '执行如下：\n```qyris-tool\n{"tool":"run_command","command":"echo hi"}\n```'

  console.log('① hadToolExec + 计划形态正文 → 不 nudge：')
  {
    const { provider, passCount } = scriptedProvider([
      [{ type: 'tool-executed', id: 't1', name: 'run_command', input: { command: 'echo deploy' }, result: { content: 'ok' } }, { type: 'done', message: msg(PLANISH) }],
    ])
    const { events } = await runOnce(provider, [spyTool([])])
    assert(passCount() === 1, `complete 只跑一轮（实际 ${passCount()}）`)
    assert(events.filter((e) => e === 'tool-start').length === 0, '无伪调用重执行（零 tool-start）')
  }

  console.log('② hadToolExec + 伪标签复述 → 不救援重执行：')
  {
    const calls: unknown[] = []
    const { provider, passCount } = scriptedProvider([
      [{ type: 'tool-executed', id: 't1', name: 'run_command', input: { command: 'echo deploy' }, result: { content: 'ok' } }, { type: 'text-delta', text: NARRATION }, { type: 'done', message: msg(NARRATION) }],
    ])
    const { events } = await runOnce(provider, [spyTool(calls)])
    assert(calls.length === 0, `spy 工具零调用（实际 ${calls.length}）`)
    assert(passCount() === 1, `complete 只跑一轮（实际 ${passCount()}）`)
    assert(events.filter((e) => e === 'tool-start').length === 0, '零 tool-start')
  }

  console.log('③ 零执行 + 计划形态 → nudge 照常（弱网关救援保留）：')
  {
    const { provider, passCount } = scriptedProvider([
      [{ type: 'done', message: msg('我的计划：首先查看目录，然后初始化配置。') }],
      [{ type: 'done', message: msg('已完成。') }],
    ])
    await runOnce(provider, [spyTool([])])
    assert(passCount() === 2, `nudge 触发第二轮（实际 ${passCount()}）`)
  }

  console.log('④ 零执行 + 围栏调用 → 照常救援执行：')
  {
    const calls: unknown[] = []
    const { provider } = scriptedProvider([
      // 救援扫描的是流文本（visible+suppressed），围栏必须走 text-delta 才忠实于真实流形态
      [{ type: 'text-delta', text: FENCE }, { type: 'done', message: msg(FENCE) }],
      [{ type: 'done', message: msg('完成。') }],
    ])
    const { events } = await runOnce(provider, [spyTool(calls)])
    assert(calls.length === 1, `救援执行一次（实际 ${calls.length}）`)
    assert(events.includes('tool-end'), 'tool-end 事件回填')
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

void main().catch((e) => {
  console.error('smoke 崩溃：', e)
  process.exit(1)
})
