/**
 * codex app-server 协议探针（一次性工具，不进 npm scripts）：
 * spawn → initialize → initialized → thread/start（参数二分）→ turn/start → 收集通知流 60s。
 * 全部响应/通知 dump 到 stdout，供 codex.ts（app-server 形态）与 smoke 回放样本取材。
 * 运行：node scripts/probe-app-server.mjs [workdir]
 */
import { spawn } from 'node:child_process'

const cwd = process.argv[2] ?? process.cwd()
const child = spawn('codex', ['app-server'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true })
let buf = ''
const pending = new Map()
const notifications = []
let threadId = null

const send = (obj) => {
  const line = JSON.stringify(obj)
  console.log(`>> ${line}`)
  child.stdin.write(line + '\n')
}

const rpc = (id, method, params) =>
  new Promise((resolve) => {
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })

child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      console.log(`<< RAW ${line.slice(0, 200)}`)
      continue
    }
    if (obj.id !== undefined && pending.has(obj.id)) {
      console.log(`<< RESP ${JSON.stringify(obj).slice(0, 600)}`)
      const resolve = pending.get(obj.id)
      pending.delete(obj.id)
      resolve(obj)
    } else {
      // 通知流：全量取证（事件名 + 载荷）
      const t = obj.params?.type ?? obj.method ?? '?'
      if (!notifications.some((n) => n.tag === t)) console.log(`<< NEW EVENT ${t}`)
      notifications.push({ tag: t, line: JSON.stringify(obj).slice(0, 500) })
    }
  }
})
child.stderr.on('data', (d) => console.log(`ERR ${d}`.slice(0, 300)))
child.on('exit', (c) => console.log(`EXIT ${c}`))

await rpc(1, 'initialize', { clientInfo: { name: 'qyris', version: '0.1.0' } })
send({ jsonrpc: '2.0', method: 'initialized' })

// thread/start 参数二分：空参起步（此前 cwd/sandbox 字符串形态静默失败）
let r = await rpc(2, 'thread/start', {})
console.log(`== thread/start {} -> ${JSON.stringify(r).slice(0, 300)}`)
if (r.error || !r.result) {
  r = await rpc(3, 'thread/start', { cwd, skipGitRepoCheck: true })
  console.log(`== thread/start cwd -> ${JSON.stringify(r).slice(0, 300)}`)
}
threadId = r.result?.thread?.id ?? r.result?.threadId ?? r.result?.conversationId ?? null
console.log(`== threadId=${threadId}`)
if (!threadId) {
  console.log('== 无法建线程，dump 已有通知后退出')
  child.kill()
  process.exit(1)
}

// 发一轮最小对话（消耗少量额度，换取事件流全景）
await rpc(4, 'turn/start', { threadId, input: [{ type: 'text', text: '只回答数字：1+1=?' }] })

// 收流 60s 或收到 task/turn 完成后 5s 收尾
const start = Date.now()
const timer = setInterval(() => {
  const last = notifications[notifications.length - 1]
  const doneish = notifications.some((n) => /task_complete|task_failed|turn\.(completed|failed)|task_complete/i.test(n.tag) || /"type":"task_complete/.test(n.line))
  if ((doneish && Date.now() - start > 5000) || Date.now() - start > 60_000) {
    clearInterval(timer)
    console.log(`== 收流结束（${notifications.length} 条通知）`)
    for (const n of notifications) console.log(`EVT ${n.tag} :: ${n.line}`)
    child.kill()
    process.exit(0)
  }
}, 1000)
