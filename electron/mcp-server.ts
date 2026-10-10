/**
 * MCP server 可执行入口 —— 编译产物 out/main/mcp-server.js，由 claude CLI 按 mcp-config spawn
 * （配置装配见 providers/claude-cli.ts 的 buildMcpServerConfig）。
 *
 * 加载顺序是契约，两层缺一不可：
 *   1. node-bootstrap 是**唯一静态 import**（只依赖 node:module，不带任何业务模块）：
 *      其模块体在入口加载期同步执行，把 require('electron') 补成降级桩；
 *   2. server 模块（→ tools/* → proc/secrets/emitter，内含 electron import）必须**动态 import**：
 *      若走静态 import，rollup 的 CJS 输出会把共享 chunk 的 require 提到入口顶层——
 *      chunk 顶层的 require('electron') 会在 bootstrap 装桩之前执行，打包态（无
 *      node_modules/electron）直接 MODULE_NOT_FOUND，整个 server 加载即崩。
 *      动态 import 让 chunk 在装桩之后才加载，桩接管一切 electron 取用（降级口径见
 *      node-bootstrap.ts 文件头）。
 */
import './lib/mcp/node-bootstrap'

async function main(): Promise<void> {
  const { parseServerArgv, startMcpStdioServer } = await import('./lib/mcp/server')
  startMcpStdioServer(parseServerArgv(process.argv.slice(2)))
}

void main()
