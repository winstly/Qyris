/**
 * 外部 MCP 客户端冒烟：假 server（自写 stdio JSON-RPC，应答故意带 \r\n 专测 CRLF 容忍）
 * 走全链路 —— 握手 / tools/list / tools/call / 动态注册 / 权限档 / 描述截断 / 取消 / 收割。
 * 运行：npm run smoke:mcp-client
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTool, toolsForPermission } from '../electron/lib/tools'
import { activeMcpServers, sanitizeMcpServers } from '../electron/lib/config'
import { connectMcpServer } from '../electron/lib/mcp/client'
import {
  closeExternalTools,
  ensureExternalTools,
  externalTools,
  isExternalToolName,
  normalizeMcpName,
} from '../electron/lib/mcp/external'
import { getTestStates, runMcpTest } from '../electron/lib/mcp/test-state'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

/** 假 MCP server 源码（无反引号/无模板插值——作为模板字面量嵌入）。应答一律 \r\n 结尾 */
const FIXTURE = `
let buf = ''
process.stdin.setEncoding('utf8')
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\r\\n') }
process.stdin.on('data', function (d) {
  buf += d
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).replace(/\\r$/, '')
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) { continue }
    const id = msg.id
    if (id === undefined) continue
    const method = msg.method
    const params = msg.params || {}
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id: id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } } })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id: id, result: { tools: [
        { name: 'echo', description: '回显入参', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'longdesc', description: new Array(3001).join('x'), inputSchema: { type: 'object', properties: {} } },
        { name: 'boom', description: '恒失败（isError 业务结果）', inputSchema: { type: 'object', properties: {} } },
        { name: 'slow', description: '慢调用（取消测试用）', inputSchema: { type: 'object', properties: {} } }
      ] } })
    } else if (method === 'tools/call') {
      const name = params.name
      if (name === 'echo') {
        send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(params.arguments || {}) }] } })
      } else if (name === 'boom') {
        send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: '炸了' }], isError: true } })
      } else if (name === 'slow') {
        setTimeout(function () { send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: '慢完了' }] } }) }, 400)
      } else {
        send({ jsonrpc: '2.0', id: id, error: { code: -32602, message: '未知工具 ' + name } })
      }
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id: id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found' } })
    }
  }
})
process.stdin.on('end', function () { process.exit(0) })
`

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'qyris-mcp-'))
  const fixturePath = join(dir, 'fake-mcp-server.cjs')
  writeFileSync(fixturePath, FIXTURE, 'utf8')

  console.log('连接与动态注册（含失败/禁用 server 容错）：')
  await ensureExternalTools(null, {
    fake: { command: process.execPath, args: [fixturePath], permission: 'readonly' },
    execy: { command: process.execPath, args: [fixturePath] }, // 缺省权限档 = exec
    off: { command: process.execPath, args: [fixturePath], enabled: false },
    bad: { command: '__qyris_no_such_command__' },
  })

  const names = externalTools().map((t) => t.name)
  assert(names.length === 8, `两个 enabled server × 4 工具 = 8 个动态工具（实得 ${names.length}）`)
  assert(names.includes('mcp__fake__echo'), '命名空间 mcp__fake__echo')
  assert(names.includes('mcp__execy__slow'), '命名空间 mcp__execy__slow')
  assert(
    names.every((n) => !n.startsWith('mcp__off__') && !n.startsWith('mcp__bad__')),
    '禁用/连接失败的 server 不贡献工具',
  )

  console.log('注册表合并（内置不受影响、无裸名泄漏）：')
  assert(getTool('mcp__fake__echo') !== undefined, 'getTool 命中外部工具')
  assert(getTool('echo') === undefined, '外部工具不以裸名泄漏')
  assert(getTool('web_search') !== undefined, '内置 web_search 不受影响')
  assert(isExternalToolName('mcp__a__b') && !isExternalToolName('web_search'), '外部工具判别')
  assert(normalizeMcpName('a b.c') === 'a_b_c', '名字归一化（API 名字面约束）')

  console.log('权限档映射（缺省 exec fail-safe）：')
  const readonly = new Set(toolsForPermission('readonly').map((t) => t.name))
  assert(readonly.has('mcp__fake__echo'), '声明 readonly 的 server 进最低档暴露面')
  assert(!readonly.has('mcp__execy__echo'), '缺省 exec 的 server 不进 readonly 档')
  assert(toolsForPermission('exec').some((t) => t.name === 'mcp__execy__echo'), 'exec 档可见')
  assert(getTool('mcp__execy__echo')?.permission === 'exec', '缺省权限档 = exec')

  console.log('描述截断（2048 上限）：')
  const long = getTool('mcp__fake__longdesc')
  assert(!!long && long.description.length < 3000, '巨型描述被截断')
  assert(!!long && long.description.includes('（描述过长已截断）'), '截断标注可见')

  console.log('tools/call 往返（CRLF 容忍隐含在全程解析中）：')
  const ctx = { projectRoot: null, permission: 'readonly' as const }
  const echo = await getTool('mcp__fake__echo')!.execute({ text: '你好' }, ctx)
  assert(echo.isError !== true && echo.content.includes('echo:') && echo.content.includes('你好'), 'echo 往返')
  const boom = await getTool('mcp__fake__boom')!.execute({}, ctx)
  assert(boom.isError === true, '工具业务失败 → isError（不是协议错误）')

  console.log('取消（notifications/cancelled 路径）：')
  const ac = new AbortController()
  const slowP = getTool('mcp__execy__slow')!.execute({}, { projectRoot: null, permission: 'exec', signal: ac.signal })
  setTimeout(() => ac.abort(), 50)
  const slow = await slowP
  assert(slow.isError === true, '中止后调用收敛 isError')
  const preAborted = await getTool('mcp__execy__slow')!.execute({}, {
    projectRoot: null,
    permission: 'exec',
    signal: AbortSignal.abort(),
  })
  assert(preAborted.isError === true, '预中止信号立即收敛')

  console.log('热重载（数据源变化就地重建；同源复用不重建）：')
  {
    // 热重载语义：ensure 比对数据源（配置源=server 表指纹 / 注入源=引用），变了就地收割重建
    const mapA = { fake: { command: process.execPath, args: [fixturePath], permission: 'readonly' as const } }
    await ensureExternalTools(null, mapA)
    assert(externalTools().some((t) => t.name === 'mcp__fake__echo'), '源 A 建连出工具')
    const kept = externalTools().map((t) => t.name).join(',')
    await ensureExternalTools(null, mapA)
    assert(externalTools().map((t) => t.name).join(',') === kept, '同源再 ensure 复用现池（不重建）')
    const mapB = { echo2: { command: process.execPath, args: [fixturePath], permission: 'readonly' as const } }
    await ensureExternalTools(null, mapB)
    assert(
      externalTools().some((t) => t.name === 'mcp__echo2__echo') && !externalTools().some((t) => t.name === 'mcp__fake__echo'),
      '数据源变更就地重建（旧池收割、新表生效，无需重启）',
    )
    closeExternalTools()
  }

  console.log('测试状态记账（进程级：组件卸载不丢的底座）：')
  {
    const st = await runMcpTest('global', 'fake', { command: process.execPath, args: [fixturePath], permission: 'readonly' })
    assert(st.ok && st.tools.length === 4, 'runMcpTest 记录结果（4 工具）')
    const snap = getTestStates()
    assert(snap['global::fake']?.ok === true && (snap['global::fake']?.testedAt ?? 0) > 0, '进程级快照含该结果（键=scope::name）')
    const bad = await runMcpTest('global', 'bad', { command: '__qyris_no_such_command__' })
    assert(bad.ok === false && !!bad.error, '连接失败记为 ok=false + error')
    closeExternalTools()
  }

  console.log('收割（close 后调用失败收敛，进程由 killTree 收）：')
  closeExternalTools()
  assert(externalTools().length === 0, '收割后动态工具清空')
  const afterClose = await getTool('mcp__fake__echo')?.execute({ text: 'x' }, ctx)
  assert(afterClose === undefined, '收割后 getTool 不再命中')

  console.log('Streamable HTTP 传输（JSON/SSE 双应答 + 会话头 + ${uuid} 插值）：')
  {
    const seen: { method: string; headers: Record<string, string | string[] | undefined>; body: { id?: unknown; method?: string } }[] = []
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } = {}
        try { body = JSON.parse(raw) } catch { /* 空体（DELETE） */ }
        seen.push({ method: req.method ?? '', headers: req.headers, body })
        if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
        if (body.id === undefined) { res.writeHead(202); res.end(); return } // 通知：无应答体
        res.setHeader('mcp-session-id', 'sess-abc')
        if (body.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1' } } }))
        } else if (body.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', description: 'HTTP 回显', inputSchema: { type: 'object', properties: {} } }] } }))
        } else if (body.method === 'tools/call') {
          // SSE 应答（另一半应答形态）：坏帧混入也应被跳过
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: not-json\n\n')
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(body.params?.arguments ?? {}) }] } })}\n\n`)
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }))
        }
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    const conn = await connectMcpServer('fake-http', {
      type: 'streamableHttp',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { 'X-Request-ID': '${uuid}' },
    })
    const tools = await conn.listTools()
    assert(tools.length === 1 && tools[0].name === 'echo', 'HTTP tools/list（JSON 应答）')
    const echo = await conn.callTool('echo', { t: 1 })
    assert(echo.isError !== true && echo.content.includes('echo:'), 'HTTP tools/call（SSE 应答 + 坏帧跳过）')
    const posts = seen.filter((s) => s.method === 'POST')
    assert(
      posts.filter((s) => s.body.method !== 'initialize').every((s) => s.headers['mcp-session-id'] === 'sess-abc'),
      '会话头随请求携带（initialize 之后）',
    )
    assert(
      posts.every((s) => /^[0-9a-f-]{36}$/i.test(String(s.headers['x-request-id'] ?? ''))),
      '${uuid} 请求头插值为真实 UUID',
    )
    conn.close()
    await new Promise((r) => setTimeout(r, 80))
    assert(seen.some((s) => s.method === 'DELETE'), 'close() 发会话收尾 DELETE')
    srv.close()
  }

  console.log('导入 schema 归一（双型 + 未知字段保留）：')
  {
    const sample = {
      'local-stdio-mcp': {
        type: 'stdio',
        command: 'python3',
        args: ['/opt/mcp-servers/local-tools/main.py', '--stdio-mode'],
        description: '本地 stdio 模式 MCP 服务',
        disabled: false,
        autoApprove: ['call_tool', 'resources/list'],
        options: { captureStderr: true, restartOnCrash: true, maxRestartAttempts: 3, messageDelimiter: '\n' },
        env: { API_KEY: 'k', PYTHONUNBUFFERED: '1' },
        cwd: '/opt/mcp-servers/workspace',
        transport: { strictStdioMode: true, blockStdoutDebugOutput: true },
      },
      'production-streamable-mcp': {
        type: 'streamableHttp',
        url: 'https://your-mcp-service.example.com/mcp',
        description: '生产级 Streamable HTTP MCP 服务',
        autoApprove: ['call_tool'],
        headers: { Authorization: 'Bearer t', 'MCP-Protocol-Version': '2026-07-28', 'X-Request-ID': '${uuid}' },
        options: { sessionMode: 'stateless', timeoutMs: 30000, retryOnDisconnect: true },
        transport: { streamingMode: 'auto' },
      },
    }
    const norm = sanitizeMcpServers(sample)
    assert(norm?.['local-stdio-mcp']?.command === 'python3', 'stdio 型 command 归一')
    assert((norm?.['local-stdio-mcp']?.options as { restartOnCrash?: boolean } | undefined)?.restartOnCrash === true, 'options 保留（restartOnCrash 等）')
    assert(Array.isArray(norm?.['local-stdio-mcp']?.autoApprove), 'autoApprove 保留')
    assert((norm?.['local-stdio-mcp']?.transport as { strictStdioMode?: boolean } | undefined)?.strictStdioMode === true, 'transport 保留')
    assert(norm?.['local-stdio-mcp']?.cwd === '/opt/mcp-servers/workspace', 'cwd 保留')
    assert(norm?.['production-streamable-mcp']?.url === 'https://your-mcp-service.example.com/mcp', 'HTTP 型 url 归一')
    assert((norm?.['production-streamable-mcp']?.headers ?? {})['X-Request-ID'] === '${uuid}', 'headers 保留（${uuid} 原文待连接时插值）')
    assert((norm?.['production-streamable-mcp']?.options as { sessionMode?: string } | undefined)?.sessionMode === 'stateless', 'sessionMode 保留')
    assert(sanitizeMcpServers({ bad: { description: '无 command/url' } }) === undefined, '无 command/url 的条目丢弃')
    // 启停单开关契约：enabled 是导入面兼容口径（外部 .mcp.json 可带），读入即归一到 disabled
    const folded = sanitizeMcpServers({ off: { command: 'c', enabled: false }, on: { command: 'c', enabled: true }, legacy: { command: 'c', disabled: true } })
    assert(folded?.off?.disabled === true && folded?.off?.enabled === undefined, 'enabled:false 归一为 disabled（写侧单开关）')
    assert(folded?.on?.disabled === undefined && folded?.on?.enabled === undefined, 'enabled:true 归一为启用（不再落 enabled）')
    assert(folded?.legacy?.disabled === true, 'disabled 口径原样保留')
  }

  console.log('两域合并口径（全局 ∪ 项目；同名项目覆盖；项目间互不串）：')
  {
    const scopes = {
      mcpServers: { g: { command: 'g-cmd' } },
      mcpServersMap: {
        '/p': { g: { command: 'p-override' }, pOnly: { command: 'p-cmd' } },
        '/q': { qOnly: { command: 'q-cmd' } },
      },
    }
    const forP = activeMcpServers(scopes, '/p')
    assert(forP.g?.command === 'p-override', '同名：项目域覆盖全局域')
    assert(forP.pOnly?.command === 'p-cmd', '项目域并入可见面')
    const forQ = activeMcpServers(scopes, '/q')
    assert(forQ.qOnly?.command === 'q-cmd' && forQ.pOnly === undefined, '项目间互不串（无跨项目回退）')
    const noProj = activeMcpServers(scopes, null)
    assert(noProj.g?.command === 'g-cmd' && noProj.pOnly === undefined, '无项目只取全局域')
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

void main()
