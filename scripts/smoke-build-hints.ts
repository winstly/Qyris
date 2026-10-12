/**
 * 构建输出启发式冒烟（utils/buildHints 纯函数）：常见构建工具样本行 → 相位信号；
 * 未识别输出零误判（降级契约：行信号为空 → HTTP 探测 + 退出码兜底，不在本层猜相位）。
 * 运行：npm run smoke:build-hints
 */
import {
  extractCommandPort,
  extractLineUrl,
  extractLineUrlFromPort,
  isDeployLine,
  isFatalLine,
  isNoiseLine,
  isRunLine,
} from '../src/utils/buildHints'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

function main(): void {
  console.log('构建完成信号（vite / next / webpack / esbuild）：')
  assert(isDeployLine('✓ built in 342ms'), 'vite built in')
  assert(isDeployLine('webpack compiled successfully'), 'webpack compiled')
  assert(isDeployLine('Compiled successfully'), 'next/cra compiled')
  assert(isDeployLine('12 modules transformed.'), 'esbuild/rollup transformed')

  console.log('启动/监听信号（前端 dev server + 通用后端）：')
  assert(isRunLine('  VITE v6.0.0  ready in 412 ms'), 'vite ready in')
  assert(isRunLine('listening on port 3000'), 'express listening')
  assert(isRunLine('Started Application in 2.1 seconds (JVM running for 2.6)'), 'spring Started … in')
  assert(isRunLine('Server is running on http://0.0.0.0:8080'), 'server running')
  assert(isRunLine('accepting connections'), 'pg/redis accepting connections')
  assert(isRunLine('serving on port 8080'), 'serving on port')
  // python http.server 不进 RUN_HINTS：走端口短语合成 URL → running（两路径分工，见 buildHints 注释）
  assert(!isRunLine('Serving HTTP on 0.0.0.0 port 8000')
    && extractLineUrlFromPort('Serving HTTP on 0.0.0.0 port 8000') === 'http://localhost:8000',
    'python http.server 经端口合成进 running（非 RUN_HINTS）')

  console.log('致命信号（编译错误族）：')
  assert(isFatalLine('Failed to compile.'), 'failed to compile')
  assert(isFatalLine("error TS2345: Argument of type 'x'"), 'TS 诊断')
  assert(isFatalLine('Module not found: Error: Cannot resolve'), 'module not found')
  assert(isFatalLine('Cannot find module \'foo\''), 'cannot find module')
  assert(isFatalLine('Error: listen EADDRINUSE: address already in use :::3000'), 'EADDRINUSE')

  console.log('地址提取（完整 URL 归一）：')
  assert(extractLineUrl('  Local:   http://localhost:5173/') === 'http://localhost:5173', 'localhost URL')
  assert(extractLineUrl('  Network: http://0.0.0.0:8080/api') === 'http://localhost:8080/api', '0.0.0.0 归一到 localhost')
  assert(extractLineUrl('  Local: http://*:5173/') === 'http://localhost:5173', '* 主机回退 localhost')
  assert(extractLineUrl('see https://example.com:8080/docs') === null, '非本机主机不出地址')

  console.log('端口短语合成（无 URL 行兜底）：')
  assert(extractLineUrlFromPort('Serving HTTP on 0.0.0.0 port 8000') === 'http://localhost:8000', 'python 旧格式')
  assert(extractLineUrlFromPort('Server started on port 3000') === 'http://localhost:3000', 'started on port')
  assert(extractLineUrlFromPort('服务已在端口 8080 启动') === 'http://localhost:8080', '中文端口短语')
  assert(extractLineUrlFromPort('App running at 0.0.0.0:5173') === 'http://localhost:5173', '裸 host:port')
  assert(extractLineUrlFromPort('Error: listen EADDRINUSE: address already in use :::3000') === null, '占用/报错行不出地址')
  assert(isNoiseLine('failed to compile'), 'isNoiseLine 认报错行')

  console.log('命令端口兜底（--port / http.server / PORT= / -p）：')
  assert(extractCommandPort('npm run dev -- --port 5173') === 5173, '--port 形态')
  assert(extractCommandPort('python -m http.server 8000') === 8000, 'http.server 位置参数')
  assert(extractCommandPort('PORT=3000 node server.js') === 3000, 'PORT= 形态')
  assert(extractCommandPort('npx serve -p 8080') === 8080, '-p 形态')
  assert(extractCommandPort('npm start') === null, '无端口线索回 null')

  console.log('降级契约（未识别输出零误判——不猜相位，交给探测/退出码）：')
  const garbage = [
    'Building for production...',
    '[12:34:56] Starting task "default"',
    '⠋ compiling modules',
    'Progress: 42%',
  ]
  for (const g of garbage) {
    assert(!isRunLine(g) && !isDeployLine(g) && !isFatalLine(g) && !extractLineUrl(g) && !extractLineUrlFromPort(g),
      `零信号：「${g.slice(0, 24)}…」`)
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

main()
