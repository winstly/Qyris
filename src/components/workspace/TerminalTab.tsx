/**
 * 终端 tab：多终端条 + xterm.js 实例（node-pty 后端）。
 * 主题映射 theme-v2 实色分层：终端面 #0b0c10（代码面）、光标紫 accent、
 * ANSI 16 色对应 --syn- 族 / --amber / --green / --red 的 hex 值（[HEX] 锁口径）。
 * 多终端：chips 横向排布 + 新建/关闭。终端条常驻（有终端就在）——VSCode 的
 * hideCondition 只藏标签条，新建按钮在面板工具栏里是常驻的；本 pane 没有那层工具栏，
 * 条一藏就等于把「新建」入口一起藏了，默认 1 个终端时再也开不出第 2 个。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { isDesktop } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { EmptyState } from '@/components/common/EmptyState'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { IconClose, IconPlus, IconTerminal } from '@/components/common/icons'

/** theme-v2 映射（hex 字面量——[HEX] 锁口径，避免 withAlpha 静默吞 alpha） */
const XTERM_THEME = {
  background: '#0e0f13',
  foreground: '#e8e8ec',
  cursor: '#7c7aff',
  cursorAccent: '#0e0f13',
  selectionBackground: '#2a2b35',
  black: '#1b1c21',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#7fb0ae',
  white: '#e8e8ec',
  brightBlack: '#55555f',
  brightRed: '#f87171',
  brightGreen: '#34d399',
  brightYellow: '#fbbf24',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#7fb0ae',
  brightWhite: '#f5f5f8',
} as const

interface TermEntry {
  id: string
  label: string
}

export function TerminalTab() {
  const projectPath = useAppStore((s) => s.projectPath)
  const [terms, setTerms] = useState<TermEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const createTerm = useCallback(() => {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setTerms((ts) => [...ts, { id, label: `终端 ${ts.length + 1}` }])
    setActiveId(id)
  }, [])

  // 默认开且只开一个终端：StrictMode 双挂载守卫（dev 下 effect 跑两次会建成两个）
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    createTerm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const closeTerm = (id: string) => {
    void window.desktopAPI?.ptyKill(id)
    const next = terms.filter((t) => t.id !== id)
    setTerms(next)
    if (id === activeId) setActiveId(next[next.length - 1]?.id ?? null)
    // 不自动重建：新增走手动（用户语义「默认一个，可以手动新增」）
  }

  const closeOthers = (id: string) => {
    terms.filter((t) => t.id !== id).forEach((t) => void window.desktopAPI?.ptyKill(t.id))
    setTerms((ts) => ts.filter((t) => t.id === id))
    setActiveId(id)
  }
  const closeToLeft = (id: string) => {
    const idx = terms.findIndex((t) => t.id === id)
    if (idx <= 0) return
    terms.slice(0, idx).forEach((t) => void window.desktopAPI?.ptyKill(t.id))
    setTerms(terms.slice(idx))
    setActiveId(id)
  }
  const closeToRight = (id: string) => {
    const idx = terms.findIndex((t) => t.id === id)
    if (idx === -1) return
    terms.slice(idx + 1).forEach((t) => void window.desktopAPI?.ptyKill(t.id))
    setTerms(terms.slice(0, idx + 1))
    setActiveId(id)
  }
  const closeAll = () => {
    terms.forEach((t) => void window.desktopAPI?.ptyKill(t.id))
    setTerms([])
    setActiveId(null)
  }

  // 右键关闭列表：与编辑器页签同款（closeTab/closeOthers/closeToLeft/closeToRight/closeAll）
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const menuItems: ContextMenuItem[] = menu
    ? (() => {
        const idx = terms.findIndex((t) => t.id === menu.id)
        return [
          { label: '关闭', run: () => closeTerm(menu.id) },
          { label: '关闭其他', run: () => closeOthers(menu.id), disabled: terms.length <= 1 },
          { label: '关闭左侧', run: () => closeToLeft(menu.id), disabled: idx <= 0 },
          { label: '关闭右侧', run: () => closeToRight(menu.id), disabled: idx === -1 || idx >= terms.length - 1 },
          { label: '全部关闭', run: () => closeAll(), danger: true, disabled: terms.length === 0 },
        ]
      })()
    : []

  if (!isDesktop) {
    return <EmptyState icon={<IconTerminal size={22} />} title="桌面应用内可用" text="终端功能需在桌面应用内运行（npm run dev）。" />
  }

  return (
    <div className="termtab">
      {terms.length === 0 && (
        <div className="termtab__empty">
          <EmptyState
            icon={<IconTerminal size={22} />}
            title="没有打开的终端"
            text="点击「新建终端」打开一个命令行窗口。"
            action={<button className="btn btn--primary" onClick={createTerm}><IconPlus size={13} /> 新建终端</button>}
          />
        </div>
      )}
      {terms.length > 0 && (
        <div className="termtab__bar" role="tablist" aria-label="终端">
          {terms.map((t) => (
            <div
              key={t.id}
              className={`termtab__chip ${t.id === activeId ? 'termtab__chip--active' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id: t.id, x: e.clientX, y: e.clientY })
              }}
            >
              <button
                role="tab"
                aria-selected={t.id === activeId}
                className="termtab__chip-label"
                onClick={() => setActiveId(t.id)}
              >
                {t.label}
              </button>
              <button className="termtab__chip-close" onClick={() => closeTerm(t.id)} aria-label={`关闭 ${t.label}`}>
                <IconClose size={11} />
              </button>
            </div>
          ))}
          <button className="icon-btn" onClick={createTerm} title="新建终端" aria-label="新建终端">
            <IconPlus size={13} />
          </button>
        </div>
      )}
      {terms.map((t) => (
        <TerminalView key={t.id} termId={t.id} cwd={projectPath ?? undefined} active={t.id === activeId} />
      ))}
      {menu && <ContextMenu pos={{ x: menu.x, y: menu.y }} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** 单个 xterm 实例：挂载/fit/输入/退出清理 */
function TerminalView({ termId, cwd, active }: {
  termId: string
  cwd?: string
  active: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !window.desktopAPI) return
    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", Consolas, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 2000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // 创建 pty（尺寸与 xterm 同步）；失败必须可见——否则输入静默白写
    void window.desktopAPI
      .ptyCreate(termId, term.cols, term.rows, cwd)
      .then(() => { term.focus() })
      .catch((e: Error) => term.write(`
[终端启动失败：${e.message}]
`))
    term.onData((data) => { window.desktopAPI?.ptyInput(termId, data) })
    const offData = window.desktopAPI.onPtyData((p) => { if (p.termId === termId) term.write(p.data) })
    const offExit = window.desktopAPI.onPtyExit((p) => {
      if (p.termId === termId) term.write(`\r\n[进程退出，code=${p.code}]\r\n`)
    })

    // 尺寸变化（ResizeObserver 比 window resize 更贴容器）
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.desktopAPI?.ptyResize(termId, term.cols, term.rows)
      } catch { /* fit 竞态 */ }
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      window.desktopAPI?.ptyKill(termId)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  // 激活时 fit 一次（隐藏 pane 尺寸为 0，显示后需重算）
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          const t = termRef.current
          if (t) {
            window.desktopAPI?.ptyResize(termId, t.cols, t.rows)
            t.focus() // 切回终端立即可输入（否则焦点留在 tab 按钮上）
          }
        } catch { /* noop */ }
      })
    }
  }, [active, termId])

  return (
    <div
      ref={hostRef}
      className="termtab__view"
      style={{ display: active ? 'block' : 'none' }}
      role="application"
      aria-label="终端"
    />
  )
}
