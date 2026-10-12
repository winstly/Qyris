import React from 'react'
import ReactDOM from 'react-dom/client'

// 字体：theme-v2-chat 系统栈（-apple-system/Segoe UI + SF Mono/ui-monospace），
// @fontsource 本地打包退役 —— 见 styles/tokens.css 字体段。
// RemixIcon 图标字体（npm 官方包，全量 woff2 打进 bundle）。
import 'remixicon/fonts/remixicon.css'

// 代码高亮配色由 components.css 的 .hljs-* 重映射到 --syn-* 提供（与 Monaco 同源），
// 不再导入 vendor 的 github-dark.css —— 它会在亮色主题留下深底并污染未映射类。

// token 层在前（CSS 变量先于一切消费者）；app.css 是 Tailwind v4 入口
// （含 components.css 复用类层）。
import '@/styles/tokens.css'
import '@/styles/material.css'
import '@/styles/app.css'

import App from '@/App'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

// 启动过场收尾：React 挂载后淡出并移除 splash（splash 是 index.html 内联的纯 HTML/CSS，
// bundle 解析期间就已可见——首屏不再是黑屏/空底色）
requestAnimationFrame(() => {
  const splash = document.getElementById('boot-splash')
  if (!splash) return
  splash.classList.add('boot-splash--hide')
  window.setTimeout(() => splash.remove(), 350)
})
