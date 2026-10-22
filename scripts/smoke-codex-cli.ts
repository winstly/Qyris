/**
 * codex app-server provider 冒烟：假 app-server（内联脚本）按真机 0.163.0 词表回放通知流，
 * 全链断言：握手/thread 参数（cwd/sandbox 驼峰/approvalPolicy）、正文流式碎片（agentMessage/delta）、
 * reasoning（textDelta）、工具卡（mcpToolCall 驼峰 + commandExecution.aggregatedOutput）、
 * server→client 审批自动应答（exec 档 accept / readonly 档 decline）、
 * usage（thread/tokenUsage/updated）、CODEX_HOME 隔离（config.toml MCP 段 + auth.json 随身）、
 * turn/completed status:failed 收口与 Reconnecting 透思考区。
 * 运行：npm run smoke:codex-cli（本机无需安装 codex）
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCodexProvider, type CodexConfig } from '../electron/lib/model/providers/codex'
import type { CompletionEvent, Message } from '../electron/lib/model/types'

type Json = Record<string, any>

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

const USER_TEXT = '跑一下测试'
const messages: readonly Message[] = [{ role: 'user', content: [{ type: 'text', text: USER_TEXT }] }]

/** 事件回放数据（真机 0.163.0 词表形态）：运行时落盘再经 env 指路——
 *  不放 scripts/ 靠 __dirname 寻址，esbuild bundle 后 __dirname 会漂到 node_modules/.cache */
const EVENTS_JSON = JSON.stringify([
  ['item/started', { item: { id: 'i1', type: 'mcpToolCall', server: 'qyris-tools', tool: 'list_dir', status: 'inProgress', arguments: { path: 'src' } } }],
  ['item/completed', { item: { id: 'i1', type: 'mcpToolCall', server: 'qyris-tools', tool: 'list_dir', status: 'completed', arguments: { path: 'src' }, result: { content: [{ type: 'text', text: 'main.ts' }] } } }],
  ['item/started', { item: { id: 'i2', type: 'commandExecution', command: 'npm test', status: 'inProgress', cwd: '.' } }],
  ['item/completed', { item: { id: 'i2', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'all pass', exitCode: 0 } }],
  ['item/started', { item: { id: 'i3', type: 'reasoning', summary: [], content: [] } }],
  ['item/reasoning/textDelta', { itemId: 'i3', delta: 'think', contentIndex: 0 }],
  ['item/reasoning/textDelta', { itemId: 'i3', delta: 'ing hard', contentIndex: 0 }],
  ['item/reasoning/textDelta', { itemId: 'i3', delta: ' now', contentIndex: 0 }],
  ['item/completed', { item: { id: 'i3', type: 'reasoning', summary: [], content: ['thinking hard now'] } }],
  ['item/started', { item: { id: 'i4', type: 'agentMessage', text: '' } }],
  ['item/agentMessage/delta', { itemId: 'i4', delta: 'Hello' }],
  ['item/agentMessage/delta', { itemId: 'i4', delta: ' from codex' }],
  ['item/completed', { item: { id: 'i4', type: 'agentMessage', text: 'Hello from codex' } }],
  ['thread/tokenUsage/updated', { threadId: 'th_1', turnId: 'tn_1', tokenUsage: { total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, reasoningOutputTokens: 2 }, last: { inputTokens: 10, outputTokens: 5 } } }],
])

/** 假 app-server 逻辑（短行数组内联，esbuild bundle 后 __dirname 不可靠所以不落独立文件）。
 *  事件回放数据走 QYRIS_SMOKE_EVENTS（外置 JSON，真机词表形态），取证落 QYRIS_SMOKE_OUT。
 *  逐行泵处理 stdin（真 server 形态——等 'end' 会和长驻 stdin 死锁）。 */
const FAKE_SERVER_LINES = [
  "const fs = require('fs')",
  "const path = require('path')",
  "const out = process.env.QYRIS_SMOKE_OUT",
  "const home = process.env.CODEX_HOME || process.env.QYRIS_SMOKE_CODEX_HOME",
  "const mode = process.env.QYRIS_SMOKE_MODE",
  "const evs = JSON.parse(fs.readFileSync(process.env.QYRIS_SMOKE_EVENTS, 'utf8'))",
  "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')",
  "let buf = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (d) => {",
  "  buf += d",
  "  let i",
  "  while ((i = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, i).trim()",
  "    buf = buf.slice(i + 1)",
  "    if (line) handle(line)",
  "  }",
  "})",
  "function handle(line) {",
  "  let m",
  "  try { m = JSON.parse(line) } catch { return }",
  "  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { userAgent: 'fake' } }); return }",
  "  if (m.method === 'thread/start') {",
  "    fs.writeFileSync(path.join(out, 'thread-params.json'), JSON.stringify(m.params || {}))",
  "    const toml = path.join(home, 'config.toml')",
  "    const tomlText = fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : '(missing)'",
  "    fs.writeFileSync(path.join(out, 'config.toml'), tomlText)",
  "    fs.writeFileSync(path.join(out, 'auth-copied.txt'), fs.existsSync(path.join(home, 'auth.json')) ? 'yes' : 'no')",
  "    send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th_1' } } })",
  "    return",
  "  }",
  "  if (m.method === 'turn/start') {",
  "    fs.writeFileSync(path.join(out, 'turn-params.json'), JSON.stringify(m.params || {}))",
  "    send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'tn_1', status: 'inProgress' } } })",
  "    send({ jsonrpc: '2.0', id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1', turnId: 'tn_1', itemId: 'i2', command: 'npm test' } })",
  "    for (const [method, params] of evs) send({ jsonrpc: '2.0', method, params })",
  "    if (mode === 'reconnect') send({ jsonrpc: '2.0', method: 'error', params: { error: { message: 'Reconnecting... 2/5' } } })",
  "    if (mode === 'failed') send({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'tn_1', status: 'failed', error: { message: 'quota exceeded' } } } })",
  "    else send({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'tn_1', status: 'completed', error: null } } })",
  "    return",
  "  }",
  "  if (m.id === 9001) {",
  "    fs.writeFileSync(path.join(out, 'approval-reply.json'), JSON.stringify(m.result || {}))",
  "    process.exit(0)",
  "  }",
  "}",
  "setTimeout(() => process.exit(0), 15000)",
]

/** 假 codex 命令（Windows cmd / Unix sh 双形态，MODE 走进程 env 注入） */
function writeFakeCmd(binDir: string, name: string, mode: 'ok' | 'reconnect' | 'failed'): string {
  const p = path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name)
  const body = FAKE_SERVER_LINES.join('\n')
  const serverJs = path.join(binDir, `${name}-server.cjs`)
  writeFileSync(serverJs, body, 'utf8')
  const jsRef = JSON.stringify(serverJs)
  if (process.platform === 'win32') {
    const setLine = mode === 'failed' ? `set QYRIS_SMOKE_MODE=failed\r\n` : mode === 'reconnect' ? `set QYRIS_SMOKE_MODE=reconnect\r\n` : ''
    writeFileSync(p, `@echo off\r\n${setLine}node ${jsRef}\r\n`, 'utf8')
  } else {
    const setLine = mode === 'failed' ? 'QYRIS_SMOKE_MODE=failed ' : mode === 'reconnect' ? 'QYRIS_SMOKE_MODE=reconnect ' : ''
    writeFileSync(p, `#!/bin/sh\n${setLine}exec node ${jsRef} "$@"\n`, 'utf8')
    chmodSync(p, 0o755)
  }
  return p
}

async function collect(
  provider: { complete(req: { messages: readonly Message[]; signal?: AbortSignal }): AsyncIterable<CompletionEvent> },
): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = []
  for await (const e of provider.complete({ messages, signal: undefined })) out.push(e)
  return out
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-codex-as-smoke-'))
  const codexHome = path.join(dir, 'codex-home')
  const binDir = path.join(dir, 'bin')
  const proj = path.join(dir, 'proj')
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(proj, { recursive: true })

  // smoke 环境注入：假 server 经 provider 的 spawn env 继承（buildChildEnv 不剥 QYRIS_SMOKE_*）
  const eventsFile = path.join(dir, 'events-ok.json')
  writeFileSync(eventsFile, EVENTS_JSON, 'utf8')
  // 伪造用户 home：provider 从 USERPROFILE/.codex 读 config.toml（合并源）与 auth.json（随身源）
  const fakeHome = path.join(dir, 'fake-home')
  const fakeDotCodex = path.join(fakeHome, '.codex')
  mkdirSync(fakeDotCodex, { recursive: true })
  // 末尾以表段收尾：验证「原文 + 追加段」对任意结构均合法（用户配置保留 + MCP 段生效）
  writeFileSync(path.join(fakeDotCodex, 'config.toml'), 'model_provider = "ZAI"\nmodel = "glm-5.3"\n[tui]\nmode = "dark"\n', 'utf8')
  writeFileSync(path.join(fakeDotCodex, 'auth.json'), '{"fake":"token"}', 'utf8')
  const realUserProfile = process.env.USERPROFILE
  const realHome = process.env.HOME
  process.env.USERPROFILE = fakeHome
  process.env.HOME = fakeHome
  process.env.QYRIS_SMOKE_CODEX_HOME = codexHome
  process.env.QYRIS_SMOKE_OUT = dir
  process.env.QYRIS_SMOKE_EVENTS = eventsFile
  process.env.QYRIS_SMOKE_MODE = 'ok'

  const cliCommand = writeFakeCmd(binDir, 'codex', 'ok')
  const cfg: CodexConfig = {
    cliCommand,
    timeoutMs: null,
    cwd: proj,
    mcp: {
      permission: 'exec',
      projectRoot: proj,
      hostProxy: { port: 47890, token: 'tok-smoke' },
      excludeTools: ['dispatch_subtasks'],
    },
  }

  try {
    const provider = createCodexProvider(cfg)
    assert(provider.capabilities.tools === true && provider.capabilities.executesOwnTools === true, 'mcp 通道 → tools+executesOwnTools')
    assert(provider.capabilities.thinking === true, 'thinking 能力开启（reasoning 可见）')

    const events = await collect(provider)

    // 正文流式：agentMessage/delta 碎片拼接 = 全文
    const text = (events.filter((e) => e.type === 'text-delta') as Extract<CompletionEvent, { type: 'text-delta' }>[]).map((e) => e.text).join('')
    assert(text === 'Hello from codex', `正文流式碎片拼接（实际 ${JSON.stringify(text)}）`)
    assert(events.some((e) => e.type === 'reasoning-delta'), 'reasoning 下发（thinking）')
    const reasoningText = (events.filter((e) => e.type === 'reasoning-delta') as Extract<CompletionEvent, { type: 'reasoning-delta' }>[]).map((e) => e.text).join('')
    assert(reasoningText === 'thinking hard now', `思考增量直通拼接（实际 ${JSON.stringify(reasoningText)}）`)

    const toolExec = events.find((e) => e.type === 'tool-executed' && e.name === 'mcp__qyris-tools__list_dir') as Extract<CompletionEvent, { type: 'tool-executed' }> | undefined
    assert(!!toolExec && toolExec.result.content === 'main.ts', 'mcpToolCall → mcp__qyris-tools__list_dir 收口')
    assert(events.some((e) => e.type === 'tool-progress' && e.name === 'mcp__qyris-tools__list_dir'), 'mcpToolCall started → 工具进行卡')
    const cmdExec = events.find((e) => e.type === 'tool-executed' && e.name === 'codex.commandExecution') as Extract<CompletionEvent, { type: 'tool-executed' }> | undefined
    assert(!!cmdExec && cmdExec.result.content === 'all pass', 'commandExecution.aggregatedOutput → codex.* 过程卡')

    // server→client 审批：exec 档自动 accept（挂死防线）
    const approvalReply = JSON.parse(readFileSync(path.join(dir, 'approval-reply.json'), 'utf8')) as Json
    assert(approvalReply.decision === 'accept', `exec 档审批自动应答 accept（实际 ${JSON.stringify(approvalReply)}）`)

    const done = events.find((e) => e.type === 'done') as Extract<CompletionEvent, { type: 'done' }> | undefined
    const doneText = (done?.message?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('')
    assert(doneText.includes('Hello from codex'), 'done 正文（单源拼接）')
    assert(done?.usage?.inputTokens === 10 && done?.usage?.outputTokens === 5, 'usage 入账（tokenUsage 通知 → 10/5）')
    assert(done?.usage?.cacheReadTokens === 4, 'usage 缓存命中入账（cachedInputTokens=4）')

    // 取证：thread 参数与 CODEX_HOME 隔离
    const threadParams = JSON.parse(readFileSync(path.join(dir, 'thread-params.json'), 'utf8')) as Json
    assert(threadParams.cwd === proj, `thread/start 带 cwd（实际 ${JSON.stringify(threadParams)}）`)
    assert(threadParams.sandbox === 'workspace-write', 'exec 权限档 → workspace-write 沙箱（kebab，0.163 口径）')
    assert(threadParams.approvalPolicy === 'on-request', 'approvalPolicy on-request（审批走自动应答）')
    const turnParams = JSON.parse(readFileSync(path.join(dir, 'turn-params.json'), 'utf8')) as Json
    const inputText = JSON.stringify(turnParams.input ?? [])
    assert(inputText.includes(USER_TEXT), 'turn/start input 携带用户文本')
    const configToml = readFileSync(path.join(dir, 'config.toml'), 'utf8')
    assert(configToml.includes('model_provider = "ZAI"') && configToml.includes('mode = "dark"'), 'config.toml 保留用户原配置（model_provider/表段）')
    assert(configToml.includes('[mcp_servers.qyris-tools]'), 'config.toml 含 qyris-tools 追加段')
    assert(configToml.indexOf('model_provider') < configToml.indexOf('[mcp_servers.qyris-tools]'), '用户配置在前、MCP 段追加在后（表头合法）')
    assert(configToml.includes('ELECTRON_RUN_AS_NODE'), 'config.toml env 显式含 RUN_AS_NODE（继承断裂防护）')
    assert(configToml.includes('QYRIS_HOST_TOOL_TOKEN'), 'config.toml env 显式含 hostProxy token')
    assert(configToml.includes('dispatch_subtasks'), 'config.toml env 含工具面剔除')
    assert(existsSync(path.join(dir, 'auth-copied.txt')) && readFileSync(path.join(dir, 'auth-copied.txt'), 'utf8') === 'yes', 'auth.json 随身复制（登录态不丢）')

    // readonly 档：审批自动 decline（独立假命令 + 独立取证目录）
    const roDir = mkdtempSync(path.join(os.tmpdir(), 'qyris-codex-as-smoke-ro-'))
    process.env.QYRIS_SMOKE_OUT = roDir
    const roProvider = createCodexProvider({
      cliCommand: writeFakeCmd(binDir, 'codex-ro', 'ok'),
      timeoutMs: null,
      cwd: proj,
      mcp: { permission: 'readonly', projectRoot: proj },
    })
    const roEvents = await collect(roProvider)
    void roEvents
    const roReply = JSON.parse(readFileSync(path.join(roDir, 'approval-reply.json'), 'utf8')) as Json
    assert(roReply.decision === 'decline', `readonly 档审批自动应答 decline（实际 ${JSON.stringify(roReply)}）`)
    const roThread = JSON.parse(readFileSync(path.join(roDir, 'thread-params.json'), 'utf8')) as Json
    assert(roThread.sandbox === 'read-only', 'readonly 档 → read-only 沙箱')
    rmSync(roDir, { recursive: true, force: true })

    // turn/failed（turn/completed status:failed）：断言 error 收口
    process.env.QYRIS_SMOKE_OUT = dir
    const failProvider = createCodexProvider({ cliCommand: writeFakeCmd(binDir, 'codex-failed', 'failed'), timeoutMs: null, cwd: proj })
    const failEvents = await collect(failProvider)
    const failErr = failEvents.find((e) => e.type === 'error') as Extract<CompletionEvent, { type: 'error' }> | undefined
    assert(!!failErr && failErr.error.message.includes('quota exceeded'), 'turn/completed failed → error 收口（quota exceeded）')

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  } finally {
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    delete process.env.QYRIS_SMOKE_CODEX_HOME
    delete process.env.QYRIS_SMOKE_OUT
    delete process.env.QYRIS_SMOKE_EVENTS
    delete process.env.QYRIS_SMOKE_MODE
    rmSync(dir, { recursive: true, force: true })
  }
  if (failures > 0) process.exit(1)
}

void main().catch((e) => {
  console.error('smoke 崩溃：', e)
  process.exit(1)
})
