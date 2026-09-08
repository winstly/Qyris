/**
 * 左侧折叠面板：项目列表 + 用户记忆（跨工程全局记忆）。
 * 折叠态：只显示两列图标（📂 项目 / 🧠 记忆），点击展开对应区域。
 * 展开态：固定宽度 260px，上方项目列表（原 ProjectsTab 逻辑），下方用户记忆。
 */
import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { ProjectsTab } from '@/components/workspace/ProjectsTab'
import { UserMemorySection } from '@/components/memory/UserMemorySection'
import { IconFolder, IconLayers } from '@/components/common/icons'

type SidebarSection = 'projects' | 'memory'

export function MemorySidebar() {
  const open = useAppStore((s) => s.memorySidebarOpen)
  const toggle = useAppStore((s) => s.toggleMemorySidebar)
  /** 展开时默认选中的区域 */
  const [section, setSection] = useState<SidebarSection>('projects')

  const handleIconClick = (s: SidebarSection) => {
    if (open && section === s) {
      // 点击已选中的图标 → 收起
      toggle()
    } else if (open) {
      // 已展开，切换区域
      setSection(s)
    } else {
      // 收起态 → 展开并选中
      setSection(s)
      toggle()
    }
  }

  return (
    <div className={`sidebar ${open ? 'sidebar--open' : ''}`}>
      {/* 图标列：始终可见 */}
      <div className="sidebar__icons">
        <button
          className={`sidebar__icon-btn ${open && section === 'projects' ? 'sidebar__icon-btn--active' : ''}`}
          onClick={() => handleIconClick('projects')}
          title="项目列表"
          aria-label="项目列表"
        >
          <IconFolder size={16} />
        </button>
        <button
          className={`sidebar__icon-btn ${open && section === 'memory' ? 'sidebar__icon-btn--active' : ''}`}
          onClick={() => handleIconClick('memory')}
          title="用户记忆"
          aria-label="用户记忆"
        >
          <IconLayers size={16} />
        </button>
      </div>

      {/* 展开面板 */}
      {open && (
        <div className="sidebar__panel">
          <div className="sidebar__panel-head">
            <span className="sidebar__panel-title">
              {section === 'projects' ? '项目' : '用户记忆'}
            </span>
            <button className="icon-btn" onClick={toggle} aria-label="收起面板" title="收起">
              ‹
            </button>
          </div>
          <div className="sidebar__panel-body">
            {section === 'projects' ? <ProjectsTab /> : <UserMemorySection />}
          </div>
        </div>
      )}
    </div>
  )
}
