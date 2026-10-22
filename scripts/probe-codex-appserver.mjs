/**
 * codex app-server 真机探针（round 3）：exec/MCP 端到端取证。
 * 已证（round 1/2）：thread/start 参数宽容（未知键忽略）；真机事件为 item/agentMessage/delta、
 * item/reasoning/textDelta 增量式；usage 在 thread/tokenUsage/updated；审批为 server→client
 * request（带 id 需应答），默认 on-request 策略下不应答即挂死。
 * 本轮验证：approvalPolicy:"never" + workspace-write 下 shell 执行不挂；MCP 工具调用
 * （真实挂载 mini MCP server）的事件形态与审批行为。
 * 运行：node scripts/probe-codex-appserver.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = mkdtempSync(path.join(os.tmpdir(), 'qyris-probe3-'))
const T0 = Date.now()
const log = (...a) => console.log(`[${String((Date.now() - T0) / 1000).padStart(5)}s]`, ...a)

// ---------------- mini MCP server（stdio ndjson JSON-RPC，暴露 ping 工具） ----------------

function writeMiniMcp(binDir) {
  const p = path.join(binDir, 'qyris-mini-mcp.mjs')
  writeFileSync(
    p,
    [
      "import { createInterface } from 'node:readline'",
      "const rl = createInterface({ input: process.stdin })",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return",
      "  let m; try { m = JSON.parse(line) } catch { return }",
      "  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'qyris-mini', version: '0.0.1' } } }); return }",
      "  if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'returns pong', inputSchema: { type: 'object', properties: {} } }] } }); return }",
      "  if (m.method === 'tools/call') { send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } }); return }",
      "  if (m.id != null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } })",
      "})",
    ].join('\n'),
    'utf8',
  )
  return p
}

// ---------------- CODEX_HOME scratch：用户 config.toml + 追加 mini MCP 段 ----------------

function buildCodexHome(dir, miniScript) {
  const home = path.join(dir, 'codex-home')
  mkdirSync(home, { recursive: true })
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userToml = path.join(userHome, '.codex', 'config.toml')
  const extra = [
    '',
    `[mcp_servers.qyris-mini]`,
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(miniScript)}]`,
    '',
  ].join('\n')
  writeFileSync(path.join(home, 'config.toml'), (existsSync(userToml) ? readFileSync(userToml, 'utf8') : '') + extra, 'utf8')
  const auth = path.join(userHome, '.codex', 'auth.json')
  if (existsSync(auth)) copyFileSync(auth, path.join(home, 'auth.json'))
  return home
}

// ---------------- JSON-RPC 泵（server→client request 自动 approved 应答） ----------------

let proc = null
let buf = ''
const waiters = []
let notifSink = (m, p) => log('  <notif', m, JSON.stringify(p).slice(0, 250))

function startServer(codexHome) {
  proc = spawn('codex app-server', {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: codexHome },
  })
  buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.id != null && typeof o.method === 'string') {
        // server→client request：按 0.163 schema 应答（命令/文件审批 {decision:accept}，elicitation {action:accept}）
        log(`  <SVREQ ${o.method} ${JSON.stringify(o.params ?? {}).slice(0, 300)}`)
        const result = o.method.includes('elicitation') ? { action: 'accept', content: null } : { decision: 'accept' }
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: o.id, result }) + '\n')
      } else if (o.id != null) {
        const w = waiters.find((x) => x.id === o.id)
        if (w) {
          clearTimeout(w.timer)
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(o)
        }
      } else if (typeof o.method === 'string') {
        notifSink(o.method, o.params ?? {})
      }
    }
  })
  proc.stderr.on('data', () => {})
  proc.on('exit', (c) => log('server exit', c))
}

let nextId = 1
function request(method, params, timeoutMs = 10000) {
  const id = nextId++
  return new Promise((resolve) => {
    const w = { id, resolve }
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
      resolve(null)
    }, timeoutMs)
    waiters.push(w)
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

function verdict(r, label) {
  if (r === null) { log(`✗ SILENT  ${label}`); return null }
  if (r.error) { log(`✗ error   ${label} →`, JSON.stringify(r.error).slice(0, 300)); return null }
  log(`✓ OK      ${label} →`, JSON.stringify(r.result).slice(0, 260))
  return r.result
}

async function main() {
  const binDir = path.join(TMP, 'bin')
  mkdirSync(binDir, { recursive: true })
  const miniScript = writeMiniMcp(binDir)
  const codexHome = buildCodexHome(TMP, miniScript)
  log('CODEX_HOME =', codexHome)

  startServer(codexHome)
  await new Promise((r) => setTimeout(r, 1500))

  const init = await request('initialize', { clientInfo: { name: 'qyris-probe', version: '0.0.1' } }, 15000)
  verdict(init, 'initialize')
  notify('initialized')

  log('--- thread/start：provider 现役形状（cwd + on-request + workspaceWrite 驼峰） ---')
  const started = await request('thread/start', { cwd: TMP, approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const res = verdict(started, 'thread/start{cwd,approvalPolicy,sandbox}')
  if (!res) { proc.kill(); return }
  log('  approvalPolicy =', JSON.stringify(res.approvalPolicy), ' sandbox =', JSON.stringify(res.sandbox))
  const threadId = res?.thread?.id
  if (!threadId) { log('!!! 无 thread id'); proc.kill(); return }

  log('--- turn A：shell 执行（验证 never 下不挂） ---')
  notifSink = (m, p) => {
    const s = JSON.stringify(p)
    log(`  <notif ${m} ${s.length > 320 ? s.slice(0, 320) + '…' : s}`)
  }
  const r1 = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Run in shell: echo probe-a. Then reply done.' }] })
  verdict(r1, 'turn/start shell')
  const doneA = await waitTurnDone(90_000)
  log('--- turn A 收口：', doneA, '---')

  log('--- turn B：MCP 工具调用（qyris-mini ping） ---')
  const r2 = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Call the qyris-mini ping tool, then reply done.' }] })
  verdict(r2, 'turn/start mcp')
  const doneB = await waitTurnDone(90_000)
  log('--- turn B 收口：', doneB, '---')

  try { notify('turn/interrupt', { threadId, turnId: null }) } catch {}
  proc.kill()
}

function waitTurnDone(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    notifSink = (m, p) => {
      if (m === 'turn/completed' || m === 'turn/failed') {
        log(`  <notif ${m} ${JSON.stringify(p).slice(0, 700)}`)
        clearTimeout(timer)
        resolve(m)
        return
      }
      const s = JSON.stringify(p)
      log(`  <notif ${m} ${s.length > 320 ? s.slice(0, 320) + '…' : s}`)
    }
  })
}

main().catch((e) => {
  console.error('probe 崩溃：', e)
  proc?.kill()
  process.exit(1)
})
