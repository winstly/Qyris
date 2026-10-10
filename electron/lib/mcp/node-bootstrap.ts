/**
 * MCP server 进程的 Node 引导 —— 必须是入口的**第一个 import**（见 electron/mcp-server.ts）。
 *
 * 为什么存在：server 以 ELECTRON_RUN_AS_NODE=1 跑（providers/claude-cli.ts 写进 mcp-config 的 env），
 * 此时进程是纯 Node：打包态根本装不上 node_modules/electron，require('electron') 直接 MODULE_NOT_FOUND
 * ——tools/index 的静态依赖图里只要有一个 electron import（proc.ts / secrets.ts），整个 server 加载即崩。
 * dev 态勉强能 require 到 npm 包，但拿到的是「Electron 可执行文件路径字符串」，调用 app/net/safeStorage
 * 会变成一句没人看得懂的 "x is not a function"。
 *
 * 处理：给 CJS 加载器挂一层 _load 补丁（Node 私有但十五年未变的稳定面，ts-node 同款做法），
 * 把 'electron' 换成「任意属性读取/调用都抛说明性错误」的递归代理——依赖它的调用点
 * （proc.checkUrlHealthy 已有 try/catch、secrets 走 .catch 降级）按各自路径响亮降级，加载期则完全无感。
 *
 * 真 Electron 进程（process.type 有值）不打补丁：该文件只该被 mcp-server 入口引到，这是纵深防御。
 */
import Module from 'node:module'

/** 真 Electron 环境（主/渲染进程）不补丁：electron 本身可用 */
const inRealElectron = Boolean((process as { type?: string }).type)

/**
 * 递归桩：`stub.any.prop(...)` 无论取多少层、最终是调用还是取值，都抛带完整路径的说明性错误。
 * 降级要响亮可诊断，不要 undefined 在十层之外硬炸。
 */
function makeStub(api: string): Record<string, unknown> {
  const fn = function throwingStub(): never {
    throw new Error(
      `electron API「${api}」在 MCP server 进程不可用（ELECTRON_RUN_AS_NODE 纯 Node 形态）。` +
        '调用点应按降级处理；如非预期，请检查 tools 层对该 API 的容错。',
    )
  }
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive) return undefined // Promise/原始值互操作防误伤
      return makeStub(`${api}.${String(prop)}`)
    },
  }) as unknown as Record<string, unknown>
}

if (!inRealElectron) {
  const mod = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const origLoad = mod._load
  mod._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') return makeStub('electron')
    return origLoad.call(this, request, parent, isMain)
  }
}
