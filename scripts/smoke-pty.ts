/** node-pty 冒烟：spawn → 输出到达 → write 回显 → 退出。全链通才算过 */
import * as pty from 'node-pty'

const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
const term = pty.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> })

let gotData = false
let gotEcho = false
const timer = setTimeout(() => {
  console.error(`[smoke-pty] FAIL: 超时无数据（gotData=${gotData} gotEcho=${gotEcho}）`)
  term.kill()
  process.exit(1)
}, 8000)

term.onData((d) => {
  if (!gotData) {
    gotData = true
    console.log(`[smoke-pty] 首批数据到达（${d.length} 字节）`)
  }
  if (d.includes('pty-smoke-ok')) {
    gotEcho = true
    console.log('[smoke-pty] 回显命中 pty-smoke-ok ✓')
    clearTimeout(timer)
    term.kill()
    setTimeout(() => process.exit(0), 300)
  }
})
term.onExit(({ exitCode }) => {
  // kill 后的退出是正常收尾；只有「没收到任何数据就退出」才是失败
  if (!gotData) {
    clearTimeout(timer)
    console.error(`[smoke-pty] FAIL: 无数据退出（code=${exitCode}）`)
    process.exit(1)
  }
})

console.log(`[smoke-pty] spawned ${shell} pid=${term.pid}`)
setTimeout(() => term.write('echo pty-smoke-ok\r\n'), 1500)
