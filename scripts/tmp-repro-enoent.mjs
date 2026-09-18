/** 临时复现实验：模拟 ai-cli.ts:362 的 spawn 形态，定位 spawn xxxx ENOENT 的触发条件（用后即删） */
import { spawn } from 'node:child_process'

const cases = [
  ['A-missing-name', 'cmd.exe', ['/C', 'definitely-missing-xyz-12345', '--version'], {}],
  ['B-missing-path-spaces', 'cmd.exe', ['/C', 'D:\\Program Files\\definitely-missing\\claude.cmd', '-p'], {}],
  ['C-quoted-path', 'cmd.exe', ['/C', '"D:\\Program Files\\definitely-missing\\claude.cmd"', '-p'], {}],
  ['D-nonexistent-cwd', 'cmd.exe', ['/C', 'echo', 'hi'], { cwd: 'D:\\definitely\\nonexistent\\dir\\qyris' }],
  ['E-real-cmd-missing-cwd', 'cmd.exe', ['/C', 'where.exe', 'node'], { cwd: 'D:\\definitely\\nonexistent\\dir\\qyris' }],
  ['F-forward-slash-path', 'cmd.exe', ['/C', 'C:/Users/Winston/AppData/Roaming/npm/definitely-missing.cmd', '-p'], {}],
]

function run(name, file, args, extra) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...extra })
    let out = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { out += d })
    child.on('error', (e) => resolve(`[${name}] error-event: ${e.message}`))
    child.on('close', (code) => {
      const tail = out.trim().split('\n')[0]?.slice(0, 100) ?? ''
      resolve(`[${name}] close code=${code} first-line="${tail}"`)
    })
    setTimeout(() => { try { child.kill() } catch {} resolve(`[${name}] TIMEOUT`) }, 8000)
  })
}

for (const [name, file, args, extra] of cases) {
  console.log(await run(name, file, args, extra))
}
