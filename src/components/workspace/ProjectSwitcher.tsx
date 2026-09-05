import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store/useAppStore'
import { IconChevron, IconClock, IconClose, IconFolder, IconPlus } from '@/components/common/icons'
import { basename } from '@/utils/path'

const MENU_WIDTH = 220

/** 常驻顶栏项目切换器：显示当前项目名，点开下拉——已打开项目可切换/关闭，另有创建/打开/查看全部。
 *  激活项用 --row-active 高亮，与「当前项目」列表风格一致。 */
export function ProjectSwitcher() {
  const projectPath = useAppStore((s) => s.projectPath)
  const openProjects = useAppStore((s) => s.openProjects)
  const openProject = useAppStore((s) => s.openProjectWithChoice)
  const openProjectDialog = useAppStore((s) => s.openProjectDialog)
  const closeProject = useAppStore((s) => s.closeProject)
  const setCreateProjectOpen = useAppStore((s) => s.setCreateProjectOpen)
  const setTab = useAppStore((s) => s.setTab)

  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const toggle = () => {
    if (menu) { setMenu(null); return }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) {
      const x = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
      setMenu({ x, y: rect.bottom + 4 })
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        className="projswitcher"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
        title={projectPath ?? '未打开项目'}
      >
        <span className="projswitcher__label">项目</span>
        <span className="projswitcher__name">{projectPath ? basename(projectPath) : '未打开'}</span>
        <IconChevron size={11} />
      </button>

      {menu && createPortal(
        <div ref={menuRef} className="projswitcher-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          {openProjects.length === 0 && <div className="projswitcher-menu__empty">无打开项目</div>}
          {openProjects.map((p) => {
            const isActive = p === projectPath
            return (
              <div key={p} className={`projswitcher-item ${isActive ? 'projswitcher-item--active' : ''}`}>
                <button
                  className="projswitcher-item__main"
                  onClick={() => { setMenu(null); if (!isActive) void openProject(p) }}
                  title={p}
                >
                  <IconFolder size={13} />
                  <span className="projswitcher-item__name">{basename(p)}</span>
                </button>
                <button
                  className="projswitcher-item__close"
                  onClick={() => { setMenu(null); void closeProject(p) }}
                  title="关闭项目（取消对话、停止服务）"
                  aria-label={`关闭 ${basename(p)}`}
                >
                  <IconClose size={11} />
                </button>
              </div>
            )
          })}
          <div className="projswitcher-divider" />
          <button className="projswitcher-action" onClick={() => { setMenu(null); setCreateProjectOpen(true) }}>
            <IconPlus size={13} /> 创建项目
          </button>
          <button className="projswitcher-action" onClick={() => { setMenu(null); void openProjectDialog() }}>
            <IconFolder size={13} /> 打开项目
          </button>
          <button className="projswitcher-action" onClick={() => { setMenu(null); setTab('projects') }}>
            <IconClock size={13} /> 查看全部项目
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
