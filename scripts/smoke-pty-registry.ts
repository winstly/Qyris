/**
 * PTY 登记表回归：kill + 同 id 立刻重建（StrictMode 双挂载 / 终端重开）后，
 * 旧进程的 onExit 会晚到——不能把新终端的登记抹掉。
 * 抹掉的后果：inputPty 静默白写（终端不能操作），且旧进程退出码被当成新终端的退出报出来。
 * 运行：npm run smoke:pty-registry
 */
import { createPty, inputPty, killPty, listPtys } from '../electron/lib/pty'
import { registerWindow } from '../electron/lib/emitter'

const TERM_ID = 'smoke-rebind'
const WIN_ID = 1

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

// emitter 按 winId 定向发事件；桩窗口负责把事件接到测试侧
const sent: Array<{ event: string; payload: { termId?: string; code?: number; data?: string } }> = []
const fakeWin = {
  id: WIN_ID,
  on: () => fakeWin,
  isDestroyed: () => false,
  webContents: {
    send: (event: string, payload: { termId?: string; code?: number; data?: string }) => {
      sent.push({ event, payload })
    },
  },
}
registerWindow(fakeWin as unknown as Parameters<typeof registerWindow>[0])

const spawnOpts = { cols: 80, rows: 24, cwd: process.cwd() }

// 1) 建 A → 2) 立刻 kill（StrictMode 清理）→ 3) 同 id 立刻重建 B（StrictMode 二次挂载）
createPty(TERM_ID, WIN_ID, spawnOpts)
killPty(TERM_ID)
const created = createPty(TERM_ID, WIN_ID, spawnOpts)
assert(created.ok, '同 id 重建成功')
assert(listPtys().includes(TERM_ID), '重建后登记在表')

// 4) 等 A 的 onExit 晚到（ConPTY 收尾有延迟），看它会不会把 B 的登记抹掉
const timer = setTimeout(() => {
  console.error('[smoke-pty-registry] FAIL: 超时')
  killPty(TERM_ID)
  process.exit(1)
}, 8000)

setTimeout(() => {
  assert(listPtys().includes(TERM_ID), '旧进程 onExit 晚到后新登记仍在')
  const exits = sent.filter((s) => s.event === 'pty:exit')
  assert(exits.length === 0, `不把旧进程退出当成新终端退出（实际 ${exits.length} 条）`)

  // 5) 输入仍能到达新进程（登记被抹掉时这里是静默白写）
  inputPty(TERM_ID, 'echo smoke-rebind-ok\r\n')
  const started = Date.now()
  const poll = setInterval(() => {
    const hit = sent.some((s) => s.event === 'pty:data' && (s.payload.data ?? '').includes('smoke-rebind-ok'))
    if (hit) {
      clearInterval(poll)
      clearTimeout(timer)
      assert(true, '输入回显到达新进程')
      killPty(TERM_ID)
      console.log(failures ? `[smoke-pty-registry] FAIL: ${failures} 项未过` : '[smoke-pty-registry] PASS')
      setTimeout(() => process.exit(failures ? 1 : 0), 300)
    } else if (Date.now() - started > 4000) {
      clearInterval(poll)
      clearTimeout(timer)
      assert(false, '输入回显到达新进程')
      killPty(TERM_ID)
      console.log(`[smoke-pty-registry] FAIL: ${failures} 项未过`)
      setTimeout(() => process.exit(1), 300)
    }
  }, 50)
}, 1000)
