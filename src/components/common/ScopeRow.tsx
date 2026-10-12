/**
 * 左栏选择行（目录 / 配置域通用）：技能面板的 Skill 目录行与 MCP 面板的配置域行共用。
 * 徽章与可移除策略来自行元数据；不提供移除回调时行内不出移除按钮（调用方不传假 props）。
 */
import { IconClose, IconFolder } from './icons'

/** 行元数据：全局/项目差异只收敛在徽章与可移除策略 */
export interface ScopeRowEntry {
  dir: string
  kind: 'global' | 'project'
  badge?: string | null
  removable?: boolean
  removeTitle?: string
}

/** 目录显示名：截取最后两级路径（行内徽章与外部标题共用） */
export function dirLabel(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.length >= 2 ? parts.slice(-2).join('/') : dir
}

export function ScopeRow({ row, active, onSelect, onRemove, extraClass }: {
  row: ScopeRowEntry
  active: boolean
  onSelect: () => void
  /** 缺省 = 不可移除（不渲染移除按钮） */
  onRemove?: () => void
  /** 行级附加类（如 MCP 配置域的禁用态 mcp-panel__scope--off） */
  extraClass?: string
}) {
  return (
    <div
      className={`skills-panel__dir ${active ? 'skills-panel__dir--active' : ''}${extraClass ? ` ${extraClass}` : ''}`}
      onClick={onSelect}
      title={row.dir}
    >
      <IconFolder size={13} />
      <span className="skills-panel__dir-name">{dirLabel(row.dir)}</span>
      {row.badge && <span className="skills-panel__dir-badge">{row.badge}</span>}
      {row.removable && onRemove && (
        <button
          className="icon-btn skills-panel__dir-remove"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          title={row.removeTitle || '移除'}
          aria-label={row.removeTitle || '移除'}
        >
          <IconClose size={11} />
        </button>
      )}
    </div>
  )
}
