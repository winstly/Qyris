/**
 * SSH 链路本地靶场：用 ssh2.Server 在 127.0.0.1 起四个场景的假服务端，
 * 让 electron/lib/ssh.ts 的真实代码（testConnection / execCommand）打进来，
 * 指纹化每个场景下客户端侧的报错串——用于定位「统一 Connection closed」类线上报障。
 * 运行：npm run ssh:probe
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server, type Connection } from 'ssh2'
import { testConnection, execCommand, type ExecHandle } from '../electron/lib/ssh'
import type { DeployServer } from '../electron/lib/config'

const LOG: string[] = []
function log(s: string): void {
  const line = `[${(Date.now() % 100000).toString().padStart(5, '0')}] ${s}`
  LOG.push(line)
  console.log(line)
}

/** 建一个场景化假服务端：mode 控制认证/会话行为 */
function startServer(mode: 'healthy' | 'auth-reject' | 'end-on-ready', hostKey: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
      log(`[server:${mode}] connection 收到（${client.constructor.name}）`)
      client.on('authentication', (ctx) => {
        log(`[server:${mode}] authentication method=${ctx.method} user=${ctx.username}`)
        if (mode === 'auth-reject') {
          ctx.reject()
          return
        }
        ctx.accept()
      })
      client.on('ready', () => {
        log(`[server:${mode}] ready（认证通过）`)
        if (mode === 'end-on-ready') {
          log(`[server:${mode}] 主动 end() 连接（模拟受限 shell/ForceCommand 类服务端行为）`)
          client.end()
          return
        }
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptExec, _rejectExec, info) => {
            log(`[server:${mode}] exec: ${JSON.stringify(info.command)}`)
            const stream = acceptExec()
            // 顺序契约：exit 必须先于 end——end 先发 EOF 再补 exit-status 会被客户端丢事件，
            // channel 永不 close（首轮实测 testConnection 因此永久挂起）
            stream.write('ok\n')
            stream.exit(0)
            stream.end()
          })
        })
      })
      client.on('error', (e) => log(`[server:${mode}] error: ${e.message}`))
      client.on('close', () => log(`[server:${mode}] close`))
    })
    srv.on('error', (e) => reject(e))
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      log(`[server:${mode}] 监听 127.0.0.1:${port}`)
      resolve(port)
    })
  })
}

/** testConnection 无内建超时（服务端失联时永久挂起——靶场需自带看门狗） */
function withWatchdog<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => { log(`!! ${label} ${ms}ms 无响应（永久挂起实锤）`); resolve(null) }, ms)
    }),
  ])
}

function serverFor(port: number, keyPath: string): DeployServer {
  return { id: `probe-${port}`, name: 'probe', host: '127.0.0.1', port, username: 'probe', auth: 'key', privateKeyPath: keyPath }
}

function execOnce(server: DeployServer, command: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let handle: ExecHandle | null = null
    let out = ''
    const timer = setTimeout(() => {
      log(`[probe] execCommand 10s 超时兜底（onExit 未回调）`)
      handle?.cancel()
      resolve({ code: null, out: out + '\n<<TIMEOUT>>' })
    }, 10_000)
    handle = execCommand(server, command, {
      runId: 'probe',
      onLine: (stream, line) => { out += `${stream}: ${line}\n` },
      onExit: (code) => {
        clearTimeout(timer)
        resolve({ code, out })
      },
    })
  })
}

async function main(): Promise<void> {
  // ssh2 的 key 解析器不支持 PKCS8 ed25519（实测 Unsupported key format）——用传统 RSA PKCS1 PEM
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qyris-ssh-probe-'))
  const clientKeyPath = path.join(tmp, 'client.pem')
  writeFileSync(clientKeyPath, privateKey, 'utf8')

  // 场景 A：健康服务端（认证通过 + exec 正常回显）
  const portA = await startServer('healthy', privateKey)
  const srvA = serverFor(portA, clientKeyPath)
  log(`=== A. testConnection（echo ok 探针）对健康服务端`)
  console.log('   →', JSON.stringify(await withWatchdog(testConnection(srvA), 15_000, 'A testConnection')))
  log(`=== A. execCommand（真实命令）`)
  const rA = await execOnce(srvA, 'echo hello && uname -a')
  console.log(`   → exit=${rA.code}\n${rA.out.split('\n').map((l) => `     ${l}`).join('\n')}`)

  // 场景 B：认证全拒（密码/公钥都不对）
  const portB = await startServer('auth-reject', privateKey)
  log(`=== B. testConnection 对认证拒绝服务端`)
  console.log('   →', JSON.stringify(await withWatchdog(testConnection(serverFor(portB, clientKeyPath)), 15_000, 'B testConnection')))

  // 场景 C：认证通过后服务端立刻断连（受限 shell / ForceCommand / 面板类伪 SSH）
  const portC = await startServer('end-on-ready', privateKey)
  log(`=== C. testConnection 对「认证后即断连」服务端`)
  console.log('   →', JSON.stringify(await withWatchdog(testConnection(serverFor(portC, clientKeyPath)), 15_000, 'C testConnection')))

  console.log('\n=== 指纹汇总（客户端侧实测报错串）===')
  console.log('A 健康路径 / B 认证拒绝 / C 认证后断连 —— 见上方 → 行')
  // 服务端句柄与 keepalive 会挂住事件循环：结果已出，显式收口
  process.exit(0)
}

void main().catch((e) => {
  console.error('probe 崩溃：', e)
  process.exit(1)
})
