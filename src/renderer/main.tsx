// 入口垫片：electron-vite 约定 renderer root = src/renderer/，
// html 只能引用 root 内模块；业务入口保持在 src/main.tsx 不动，由此转引。
import '../main.tsx'
