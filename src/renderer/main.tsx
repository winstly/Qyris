import React from 'react'
import ReactDOM from 'react-dom/client'

// 字体本地打包（离线可用，不依赖 CDN）：标题 Instrument Serif / 正文 Outfit（中文回退系统字体），代码 JetBrains Mono
import '@fontsource/instrument-serif/400.css'
import '@fontsource/outfit/400.css'
import '@fontsource/outfit/500.css'
import '@fontsource/outfit/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
// 代码高亮主题（chat 代码块）
import 'highlight.js/styles/github-dark.css'

import '@/styles/tokens.css'
import '@/styles/shell.css'
import '@/styles/panels.css'
import '@/styles/chat.css'

import App from '@/App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
