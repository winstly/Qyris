import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import { IconCopy, IconCheck } from '@/components/common/icons'

/** AI 回复的 Markdown 渲染：GFM + 代码块语法高亮 + 一键复制。 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => {
            const first = (Array.isArray(children) ? children[0] : children) as
              | { props?: { className?: string; children?: ReactNode } }
              | undefined
            const className = first?.props?.className ?? ''
            const lang = /language-([\w-]+)/.exec(className)?.[1]
            const raw = extractText(first?.props?.children).replace(/\n$/, '')
            return <CodeBlock code={raw} lang={lang} />
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)

  let html = ''
  try {
    if (code.length > 20_000) {
      html = escapeHtml(code)
    } else if (lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } else {
      html = hljs.highlightAuto(code).value
    }
  } catch {
    html = escapeHtml(code)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* 剪贴板不可用时静默 */ }
  }

  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span className="codeblock__lang">{lang ?? 'text'}</span>
        <button className="codeblock__copy" onClick={() => void copy()}>
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

function extractText(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  const withProps = node as { props?: { children?: unknown } }
  if (withProps.props?.children !== undefined) return extractText(withProps.props.children)
  return ''
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
