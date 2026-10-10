/**
 * 主进程代行通道（mcp/proxy.ts）+ MCP 暴露面门控回归。
 *
 * 背景（2026-10-09 线上「load_skill 误调 dispatch_subtasks、多 agent 不行」）：
 * CLI 通道的工具面只能经 MCP 暴露，而编排工具（dispatch_subtasks）在 mcp-server 子进程里
 * 执行会丢卡片/转录（AgentRunContext 事件出口只挂在主进程 run）。曾经的处置是把它从 MCP
 * 面剔除——提示词却仍在宣称可用，模型找不到就退化成 load_skill('dispatch_subtasks')。
 * 修法：代行通道把编排调用送回主进程执行；提示词工具面与通道可达面同源。
 *
 * 断言：
 *   ① callHostTool 往返：content/isError 原样回传
 *   ② 令牌不匹配 → isError 拒绝（通道不是无门 RCE）
 *   ③ 非白名单工具名 → isError 拒绝
 *   ④ 执行回调抛错 → 收敛 isError，不漏异常
 *   ⑤ parseServerArgv：env 注入解析；缺 token → null（fail-safe）
 *   ⑥ MCP 暴露面：无通道 → 无 dispatch_subtasks；有通道 → 有
 *   ⑦ MCP tools/call dispatch_subtasks → 经代行到主进程执行回调
 * 运行：npm run smoke:host-proxy
 */
import { createMcpCore, parseServerArgv } from '../electron/lib/mcp/server'
import {
  callHostTool,
  HOST_ONLY_TOOLS,
  HOST_TOOL_ENV_PORT,
  HOST_TOOL_ENV_TOKEN,
  hostProxyFromEnv,
  openHostToolProxy,
  type HostToolExecutor,
} from '../electron/lib/mcp/proxy'
import type { ToolResult } from '../electron/lib/model/types'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

/** 收集 MCP core 的出站协议帧 */
function collector(): { send: (line: string) => void; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  return {
    send: (line: string) => {
      sent.push(JSON.parse(line) as Record<string, unknown>)
    },
    sent,
  }
}

async function main(): Promise<void> {
  const calls: Array<{ name: string; input: unknown }> = []
  const executor: HostToolExecutor = async (name, input) => {
    calls.push({ name, input })
    return { content: `echo:${JSON.stringify(input)}`, isError: false } as ToolResult
  }
  const endpoint = await openHostToolProxy(executor)

  console.log('① callHostTool 往返：')
  {
    const r = await callHostTool(endpoint, 'dispatch_subtasks', { tasks: [{ title: 't1', instruction: 'i1' }] })
    assert(r.isError !== true, '正常调用不置 isError')
    assert(r.content.startsWith('echo:'), `结果原样回传（${r.content.slice(0, 30)}…）`)
  }

  console.log('② 令牌不匹配拒绝：')
  {
    const r = await callHostTool({ port: endpoint.port, token: 'wrong-token' }, 'dispatch_subtasks', {})
    assert(r.isError === true, '错误令牌 → isError')
    assert(r.content.includes('令牌'), `错误文案指明令牌（${r.content}）`)
    assert(calls.length === 1, '执行回调未被触发')
  }

  console.log('③ 非白名单工具名拒绝：')
  {
    const r = await callHostTool(endpoint, 'run_command', { command: 'echo pwn' })
    assert(r.isError === true, '表外工具 → isError')
    assert(r.content.includes('不允许'), `错误文案指明白名单（${r.content}）`)
    assert(calls.length === 1, '执行回调未被触发')
    assert(HOST_ONLY_TOOLS.includes('dispatch_subtasks'), 'dispatch_subtasks 在白名单内')
  }

  console.log('④ 执行回调抛错收敛 isError：')
  {
    const boom = await openHostToolProxy(async () => {
      throw new Error('执行体爆炸')
    })
    const r = await callHostTool(boom, 'dispatch_subtasks', {})
    assert(r.isError === true, '抛错 → isError')
    assert(r.content.includes('执行体爆炸'), `错误原文保留（${r.content}）`)
    boom.close()
  }

  console.log('⑤ parseServerArgv / hostProxyFromEnv：')
  {
    const env = { [HOST_TOOL_ENV_PORT]: String(endpoint.port), [HOST_TOOL_ENV_TOKEN]: endpoint.token }
    const cfg = parseServerArgv(['--permission', 'exec', '--project-root', ''], env)
    assert(cfg.hostProxy?.port === endpoint.port && cfg.hostProxy?.token === endpoint.token, 'env 注入解析出通道')
    assert(hostProxyFromEnv({ [HOST_TOOL_ENV_PORT]: '0', [HOST_TOOL_ENV_TOKEN]: 'x' }) === null, '端口非法 → null')
    assert(hostProxyFromEnv({ [HOST_TOOL_ENV_PORT]: '1234' }) === null, '缺 token → null')
    assert(parseServerArgv(['--permission', 'exec'], {}).hostProxy === null, '无 env → 通道 null')
  }

  console.log('⑥ MCP 暴露面门控：')
  {
    const io = collector()
    const noProxy = createMcpCore({ permission: 'exec', projectRoot: null, hostProxy: null }, io)
    noProxy.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const list1 = (io.sent[0]?.result as { tools: Array<{ name: string }> })?.tools ?? []
    assert(!list1.some((t) => t.name === 'dispatch_subtasks'), '无通道 → 暴露面不含 dispatch_subtasks')

    const io2 = collector()
    const withProxy = createMcpCore(
      { permission: 'exec', projectRoot: null, hostProxy: { port: endpoint.port, token: endpoint.token } },
      io2,
    )
    withProxy.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const list2 = (io2.sent[0]?.result as { tools: Array<{ name: string }> })?.tools ?? []
    assert(list2.some((t) => t.name === 'dispatch_subtasks'), '有通道 → 暴露面含 dispatch_subtasks')
    assert(!list2.some((t) => t.name === 'askUserQuestion'), '交互型工具仍不暴露')
  }

  console.log('⑦ MCP tools/call 走代行：')
  {
    const before = calls.length
    const io = collector()
    const core = createMcpCore(
      { permission: 'exec', projectRoot: null, hostProxy: { port: endpoint.port, token: endpoint.token } },
      io,
    )
    core.line(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'dispatch_subtasks', arguments: { tasks: [{ title: 'x', instruction: 'y' }] } },
    }))
    await new Promise((r) => setTimeout(r, 200))
    const resp = io.sent.find((m) => m.id === 2)
    assert(resp?.result != null, `收到 tools/call 应答（${JSON.stringify(resp).slice(0, 60)}…）`)
    assert(calls.length === before + 1, '主进程执行回调被调用一次')
    assert(calls[calls.length - 1]?.name === 'dispatch_subtasks', '调用名正确')
  }

  endpoint.close()
  if (failures > 0) {
    console.error(`\nsmoke-host-proxy：${failures} 项失败`)
    process.exit(1)
  }
  console.log('\nsmoke-host-proxy：全部通过')
}

void main()
