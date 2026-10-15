import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { RollupLog } from 'rollup'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

// zod v4 源码内嵌 esbuild 朝向的 @__PURE__ 注释，Rollup 因注释位置无法识别——仅从产物删除
// 注释，零功能影响（tree-shake 提示在 rollup 语境本就不生效）。第三方源码不可修（改了下次
// npm install 就被覆盖），node_modules 内的同款警告一律静默防刷屏；自有代码的注解警告照常上报。
// main / preload / renderer 三段统一挂载——哪段未来引了含此类注释的包都无需再改这里。
// RollupLog 是 import type（零运行时；vite 不 re-export 该类型，rollup 随 vite 必装）。
function onRollupWarn(warning: RollupLog, warn: (w: RollupLog) => void): void {
  if (warning.code === 'INVALID_ANNOTATION' && warning.message.includes('node_modules')) return
  warn(warning)
}

// main/preload 产物为 CJS（electron-vite 默认），依赖全部 bundle（dependencies 为空，
// chokidar 等由 rollup 打进产物，打包后无需 node_modules）。
// renderer root 遵循 electron-vite 约定（src/renderer/，index.html 已迁入），
// 业务源码仍在 src/ 顶层，不受影响。
export default defineConfig({
  main: {
    // externalizeDepsPlugin 默认把 package.json dependencies 全部 external（运行时 require），
    // 只有 exclude 名单才编译期 bundle。这份名单是「mcp-server 外部进程能活着」的生死线：
    // mcp-server 由 claude CLI 以 ELECTRON_RUN_AS_NODE 在 asar 之外 spawn，读不到 asar 里的
    // node_modules——凡共享 chunk（runner-*.js）顶层可达的纯 JS 依赖必须 bundle 进产物：
    //   · @modelcontextprotocol/sdk —— MCP 客户端（rollup 直吃 dist/esm，绕开运行时 exports map）
    //   · ssh2 —— SSH 互联（打包实测：external 时 ssh2 落在 asar.unpacked 而其传递依赖 asn1 不随包，
    //     mcp-server 加载即 MODULE_NOT_FOUND，claude --strict-mcp-config 静默放弃 MCP → 模型零工具）
    //   · ajv / ajv-formats —— MCP SDK 校验代码的运行时 require，同样不随包
    // native 三件套（better-sqlite3 / node-pty / sqlite-vec）照旧 external，由 electron-builder
    // files + asarUnpack 收集；electron / transformers / onnxruntime-web 为懒加载守卫依赖，不在此列。
    plugins: [externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk', 'ssh2', 'ajv', 'ajv-formats'] })],
    build: {
      lib: {
        // 双入口：index = 主进程；mcp-server = MCP stdio server 独立可执行（由 claude CLI 按
        // mcp-config spawn，providers/claude-cli.ts 装配）。mcp-server 与 index 共享 chunk——
        // 因此 electron-builder.yml 必须把 out/main/*.js 整体 asarUnpack（spawn 出去的进程
        // 读不到 asar 里的共享 chunk，缺一块就 MODULE_NOT_FOUND）。
        entry: {
          index: 'electron/main/index.ts',
          'mcp-server': 'electron/mcp-server.ts',
        },
      },
      rollupOptions: {
        onwarn: onRollupWarn,
        // cpu-features（ssh2 的可选原生依赖）与 onnxruntime-node（@huggingface/transformers
        // 的原生后端）一律 external：原生 .node 进不了 rollup 产物，须留 require 字面量到运行期。
        // onnxruntime-web 是 wasm 后端，embed.ts 靠 require.resolve 定位其 dist 目录，同样不许进包。
        // 运行时 ssh2 自带 try/catch 降级、embed.ts 自带 module._load 劫持（onnxruntime-node 走 wasm）。
        external: ['cpu-features', 'onnxruntime-node', 'onnxruntime-web'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/preload/index.ts' },
      rollupOptions: {
        onwarn: onRollupWarn,
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // electron-vite renderer root 默认 src/renderer/，publicDir 需指向项目根 public/
    publicDir: path.resolve(__dirname, 'public'),
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@base': fileURLToPath(new URL('./shared/base', import.meta.url)),
      },
    },
    clearScreen: false,
    server: {
      // 5173 是 Vite 生态默认端口，极易与别的 Vite 项目撞车；避开并允许被占时自动 +1
      // （electron-vite 会把实际地址写入 ELECTRON_RENDERER_URL，主进程加载不受影响）
      port: 5188,
      strictPort: false,
      watch: {
        // 避免监听构建产物与主进程代码造成的无意义重载
        ignored: ['**/out/**', '**/electron/**'],
      },
    },
    build: {
      // 显式锚定项目根，避免相对 renderer root 解析
      outDir: path.resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      target: 'es2021',
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'src/renderer/index.html'),
          pet: path.resolve(__dirname, 'src/renderer/pet/index.html'),
          panel: path.resolve(__dirname, 'src/renderer/pet/panel.html'),
        },
        onwarn: onRollupWarn,
        // 不配 manualChunks：Rollup 多入口本来就自动把共享模块提为公共 chunk。
        // 若手动把 node_modules 归并成单一 vendor chunk，桌宠入口（只用 react）
        // 也得整包加载全部依赖（~5MB），64px 动画窗口的开销反而爆炸。
      },
    },
  },
})
