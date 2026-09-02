import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

// main/preload 产物为 CJS（electron-vite 默认），依赖全部 bundle（dependencies 为空，
// chokidar 等由 rollup 打进产物，打包后无需 node_modules）。
// renderer root 遵循 electron-vite 约定（src/renderer/，index.html 已迁入），
// 业务源码仍在 src/ 顶层，不受影响。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/main/index.ts' },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/preload/index.ts' },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
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
    },
  },
})
