/**
 * SSH 真环境诊断器：在 Electron 进程内用真实 safeStorage 解密凭据（内容永不打印），
 * 对 config.json 里的 deployServers 逐台发起全量 trace 连接——拿到服务端 DISCONNECT 的
 * reason/desc 原文，定位「统一 Connection closed」类线上报障。
 * 运行：npm run ssh:diagnose
 */
import { app, safeStorage } from 'electron'
import { Client, type ClientChannel } from 'ssh2'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 阶段 2：把解密后的凭据经 QYRIS_SSH_CRED_* env 注入 mcp-server（真实链路：主进程 →
 *  mcp-config env → claude spawn），走 MCP stdio 调 remote_exec——修复后的端到端验收 */
function mcpRemoteExecProbe(serverId: string, serverName: string, secret: string): Promise<void> {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', '..', 'out', 'main', 'mcp-server.js')
    const child: ChildProcess = spawn(process.execPath, [script, '--permission', 'exec', '--project-root', ''], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', [`QYRIS_SSH_CRED_${serverId}`]: secret },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buf = ''
    const timer = setTimeout(() => { console.log('!! mcp E2E 30s 超时'); child.kill(); resolve() }, 30_000)
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } }
          if (msg.id === 2) {
            clearTimeout(timer)
            console.log('mcp E2E tools/call 响应:', JSON.stringify(msg.result?.content?.map((c) => c.text) ?? msg.result).slice(0, 600))
            child.kill()
            resolve()
          }
        } catch { /* 逐行 JSON，忽略噪声 */ }
      }
    })
    child.stderr?.on('data', (d: Buffer) => console.log('mcp stderr:', d.toString('utf8').trim().slice(0, 400)))
    child.on('exit', (code, sig) => {
      if (sig !== 'SIGTERM') { clearTimeout(timer); console.log(`mcp-server 异常退出 code=${code}`); resolve() }
    })
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'diag', version: '0' } } }) + '\n')
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    setTimeout(() => {
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remote_exec', arguments: { command: 'echo ok', serverName } } }) + '\n')
    }, 800)
  })
}

// safeStorage 的 os_crypt 密钥绑定 userData（Local State 的 encrypted_key）。
// 独立跑诊断器时 app name 是「Electron」，userData 指错目录 → 解密必败（实测）。
// 必须在 anyReady 前指回应用真实 userData
const APP_USER_DATA = path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'qyris')
app.setPath('userData', APP_USER_DATA)
console.log('userData =', APP_USER_DATA, existsSync(path.join(APP_USER_DATA, 'Local State')) ? '（Local State ✓）' : '（⚠️ 无 Local State）')

interface ProbeServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key'
  privateKeyPath?: string
}

function probe(server: ProbeServer, password: string | null): Promise<void> {
  return new Promise((resolve) => {
    const conn = new Client()
    const t0 = Date.now()
    const t = (): string => `+${Date.now() - t0}ms`
    conn.on('connect', () => console.log(`[${t()}] socket connect`))
    conn.on('banner', (b: string) => console.log(`[${t()}] banner: ${JSON.stringify(b)}`))
    conn.on('greeting', (g: string) => console.log(`[${t()}] greeting: ${JSON.stringify(g)}`))
    conn.on('ready', () => {
      console.log(`[${t()}] ready ✓ 认证通过`)
      conn.exec('echo ok', (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          console.log(`[${t()}] exec err: ${err.message}`)
          conn.end()
          resolve()
          return
        }
        let out = ''
        let errOut = ''
        stream.on('data', (d: Buffer) => { out += d.toString('utf8') })
        stream.on('stderr', (d: Buffer) => { errOut += d.toString('utf8') })
        stream.on('close', (code: number | null) => {
          console.log(`[${t()}] stream close code=${code} stdout=${JSON.stringify(out)} stderr=${JSON.stringify(errOut)}`)
          conn.end()
          resolve()
        })
      })
    })
    conn.on('error', (e: Error & { code?: number; level?: string }) => {
      console.log(`[${t()}] error: ${JSON.stringify({ message: e.message, code: e.code, level: e.level })}`)
    })
    conn.on('end', () => console.log(`[${t()}] end`))
    conn.on('close', () => { console.log(`[${t()}] close`); resolve() })
    conn.connect({
      host: server.host,
      port: server.port || 22,
      username: server.username,
      ...(server.auth === 'password' && password ? { password } : {}),
      ...(server.auth === 'key' && server.privateKeyPath ? { privateKey: readFileSync(server.privateKeyPath) } : {}),
      readyTimeout: 15_000,
      keepaliveInterval: 30_000,
      // 全量协议 trace：握手/算法协商/认证尝试/DISCONNECT 逐行可见
      debug: (line: string) => console.log(`[ssh2] ${line}`),
    })
  })
}

void app.whenReady().then(async () => {
  try {
    console.log('safeStorage.isEncryptionAvailable =', safeStorage.isEncryptionAvailable())
    const cfg = JSON.parse(readFileSync(path.join(homedir(), '.qyris', 'config.json'), 'utf8')) as { deployServers?: ProbeServer[] }
    const secrets = JSON.parse(readFileSync(path.join(homedir(), '.qyris', 'secrets.json'), 'utf8')) as Record<string, string>
    for (const s of cfg.deployServers ?? []) {
      console.log(`\n===== ${s.name} → ${s.username}@${s.host}:${s.port} auth=${s.auth} =====`)
      const enc = secrets[`ssh:${s.id}`]
      let password: string | null = null
      if (enc) {
        console.log(`凭据密文: 前缀=${enc.slice(0, 6)}… 长度=${enc.length}`)
        password = safeStorage.decryptString(Buffer.from(enc, 'base64'))
        console.log(`凭据解密成功（明文长度=${password.length}，内容不打印）`)
      } else {
        console.log('⚠️ 无保存凭据')
      }
      await probe(s, password)
      if (password) {
        console.log('\n----- 阶段 2：mcp-server 子进程凭据注入 E2E（remote_exec echo ok）-----')
        await mcpRemoteExecProbe(s.id, s.name, password)
      }
    }
  } catch (e) {
    console.error('diagnose 失败:', e)
  }
  process.exit(0)
})
