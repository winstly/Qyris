/**
 * 项目技能管理面板（工作区「扩展 → 技能」）。
 * 左侧：Skill 目录列表——全局组（skillsDirs，带「全局」标签，skill 级只读）+ 项目组（.qyris/skills 默认 + 可追加，均可导入/删除）
 * 右侧：选中目录下的 Skill 列表（全局目录只读 + 打开目录；项目目录可导入/删除）
 */
import { useEffect, useState } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { api } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { EmptyState } from '@/components/common/EmptyState'
import { Pager, usePaged, PAGE_SIZE } from '@/components/common/Pager'
import { ScopeRow, dirLabel, type ScopeRowEntry } from '@/components/common/ScopeRow'
import { toast } from '@/components/common/Toast'
import { IconClose, IconPlus, IconSearch, IconTerminal, IconTrash } from '@/components/common/icons'
import type { SkillMeta } from '@/types'

/** 技能卡四色池：紫/蓝/绿/橙轮换（色值走 --tool-* token 族；无图标，标题色是唯一色调信号） */
const SKILL_CARD_TONES = ['purple', 'blue', 'green', 'orange'] as const

export function ProjectSkillsPanel() {
  const projectPath = useAppStore((s) => s.projectPath)
  const projectSkillsDirs = useAppStore((s) => s.projectSkillsDirs)
  /** 全局 Skills 目录（设置迁来；带「全局」标签，skill 级只读） */
  const skillsDirs = useAppStore((s) => s.skillsDirs)
  const setSkillsDirs = useAppStore((s) => s.setSkillsDirs)
  const addProjectSkillsDir = useAppStore((s) => s.addProjectSkillsDir)
  const removeProjectSkillsDir = useAppStore((s) => s.removeProjectSkillsDir)
  const loadProjectSkills = useAppStore((s) => s.loadProjectSkills)
  const showConfirm = useAppStore((s) => s.showConfirm)

  /** 当前选中的目录（默认第一个）+ 所属分组：可管理性按分组判定，不按路径是否出现在全局表里判定
   *  （同一路径可能同时出现在全局/项目两个列表里，此时应跟分组走） */
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<'global' | 'project'>('global')
  /** 选中目录下的 Skill 列表（单独扫描，不走全局 merged） */
  const [dirSkills, setDirSkills] = useState<SkillMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState('')
  /** 详情弹窗（点卡查看 Skill 内容） */
  const [detail, setDetail] = useState<SkillMeta | null>(null)

  // 选中目录变化 → 扫描该目录下的 Skill
  useEffect(() => {
    if (!selectedDir) { setDirSkills([]); return }
    let cancelled = false
    setLoading(true)
    api.scanSkills([selectedDir])
      .then((metas) => { if (!cancelled) setDirSkills(metas) })
      .catch(() => { if (!cancelled) setDirSkills([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedDir])

  // 目录列表变化时：若当前选中被移除，回退到第一个（全局组在前，项目组在后）
  const allDirs = [...skillsDirs, ...projectSkillsDirs]
  useEffect(() => {
    if (!selectedDir || !allDirs.includes(selectedDir)) {
      setSelectedDir(allDirs[0] ?? null)
      setSelectedKind(skillsDirs.length > 0 ? 'global' : 'project')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsDirs, projectSkillsDirs])

  /** 当前选中是否为全局目录（全局 skill 级只读）——按选中分组判定 */
  const isGlobalDir = selectedKind === 'global'

  /** 可管理（导入/删除）判据唯一口径：项目分组全部可管理，全局分组只读——
   *  全局/项目是同一套 Skill 系统，边界只在「谁能改」，不在样式与渲染 */
  const canManage = selectedDir != null && selectedKind === 'project'

  // 切到扩展 Tab 自动刷新
  const activeTab = useAppStore((s) => s.activeTab)
  useEffect(() => {
    if (activeTab === 'extensions' && projectPath) {
      void loadProjectSkills()
    }
  }, [activeTab, projectPath, loadProjectSkills])

  /** 从 ZIP 导入 Skill 到当前选中目录 */
  const onImportZip = async () => {
    if (!selectedDir || importing) return
    const zipPath = await api.projectSkillPickZip()
    if (!zipPath) return
    setImporting(true)
    try {
      const r = await api.projectSkillImportZip(selectedDir, zipPath)
      if (r.ok) {
        // 批量包（多个子目录各含 SKILL.md）报总数，与目录导入同口径
        const msg = r.count && r.count > 1 ? `已导入 ${r.count} 个 Skill` : `已导入 Skill「${r.name}」`
        toast.ok('导入完成', msg)
        await refreshDir()
      } else {
        toast.err('导入失败', r.error || '导入失败')
      }
    } catch (e) {
      toast.err('导入失败', String(e))
    } finally {
      setImporting(false)
    }
  }

  /** 从本地目录导入 Skill 到当前选中目录 */
  const onImportDir = async () => {
    if (!selectedDir || importing) return
    const srcDir = await api.projectSkillPickDir()
    if (!srcDir) return
    setImporting(true)
    try {
      const r = await api.projectSkillImportDir(selectedDir, srcDir)
      if (r.ok) {
        const msg = r.count && r.count > 1 ? `已导入 ${r.count} 个 Skill` : `已导入 Skill「${r.name}」`
        toast.ok('导入完成', msg)
        await refreshDir()
      } else {
        toast.err('导入失败', r.error || '导入失败')
      }
    } catch (e) {
      toast.err('导入失败', String(e))
    } finally {
      setImporting(false)
    }
  }

  /** 删除 Skill */
  const onDelete = async (id: string, name: string) => {
    if (!selectedDir) return
    const ok = await showConfirm('删除 Skill', `确定删除「${name}」？将删除整个 Skill 目录，不可恢复。`)
    if (ok !== true) return
    try {
      const r = await api.projectSkillDelete(selectedDir, id)
      if (r.ok) {
        toast.ok('已删除 Skill', `「${name}」已删除。`)
        await refreshDir()
      } else {
        toast.err('删除失败', r.error || '删除失败')
      }
    } catch (e) {
      toast.err('删除失败', String(e))
    }
  }

  /** 刷新当前选中目录的 Skill 列表 + 全局 merged 列表（供 / 菜单用） */
  const refreshDir = async () => {
    if (selectedDir) {
      try {
        const metas = await api.scanSkills([selectedDir])
        setDirSkills(metas)
      } catch { /* ignore */ }
    }
    await loadProjectSkills()
  }

  /** 添加外部目录 */
  const onAddDir = async () => {
    const dir = await api.pickSkillsDir()
    if (!dir) return
    addProjectSkillsDir(dir)
    setSelectedDir(dir)
  }

  /** 添加全局目录（跨项目共享；skill 级只读，目录条目可增删） */
  const onAddGlobalDir = async () => {
    const dir = await api.pickSkillsDir()
    if (!dir || skillsDirs.includes(dir)) return
    setSkillsDirs([...skillsDirs, dir])
    setSelectedDir(dir)
  }

  /** 移除全局目录（不删磁盘文件；影响所有项目，故有确认） */
  const onRemoveGlobalDir = async (dir: string) => {
    const ok = await showConfirm('移除全局目录', `确定移除全局 Skill 目录「${dir}」？所有项目不再加载它，不会删除磁盘文件。`)
    if (ok !== true) return
    setSkillsDirs(skillsDirs.filter((d) => d !== dir))
  }

  /** 移除外部目录 */
  const onRemoveDir = async (dir: string) => {
    const ok = await showConfirm('移除目录', `确定移除 Skill 目录「${dir}」？不会删除磁盘文件。`)
    if (ok !== true) return
    removeProjectSkillsDir(dir)
  }

  // 过滤
  const filtered = search.trim()
    ? dirSkills.filter((s) => {
        const q = search.trim().toLowerCase()
        return s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      })
    : dirSkills
  // 卡片分页：切目录/换搜索词回第一页
  const paged = usePaged(filtered, PAGE_SIZE, `${selectedDir ?? ''}|${search}`)

  // 目录组（全局在前、项目在后）：同一套行渲染与交互，差异全部收敛为行元数据
  const dirGroups: { label: string; rows: ScopeRowEntry[]; onAdd: () => void; addTitle: string; empty: string }[] = [
    {
      label: '全局',
      rows: skillsDirs.map((dir) => ({
        dir, kind: 'global' as const, badge: '全局', removable: true,
        removeTitle: '移除全局目录（不影响磁盘文件）',
      })),
      onAdd: () => void onAddGlobalDir(),
      addTitle: '添加全局目录',
      empty: '暂无全局目录',
    },
    ...(projectPath
      ? [{
          label: '项目',
          rows: projectSkillsDirs.map((dir, i) => ({
            dir, kind: 'project' as const, badge: i === 0 ? '默认' : null,
            removable: i > 0, removeTitle: '移除目录',
          })),
          onAdd: () => void onAddDir(),
          addTitle: '添加项目目录',
          empty: '暂无项目目录',
        }]
      : []),
  ]

  // 全局目录无项目也可浏览（skill 级只读）；项目组要项目
  // 不整屏早退：无项目也要能加全局目录（全局组自带添加入口，项目组在 dirGroups 里按 projectPath 裁剪）
  return (
    <div className="skills-panel">
      {/* ── 左侧：目录列表（全局组在前，项目组在后）——同一套行渲染，差异收敛为行元数据 ── */}
      <div className="skills-panel__dirs">
        <div className="skills-panel__dirs-head">
          <span>目录</span>
        </div>
        {dirGroups.map((g) => (
          <div key={g.label} className="skills-panel__dir-group">
            <div className="skills-panel__dir-group-head">
              <span>{g.label}</span>
              <button className="icon-btn" onClick={g.onAdd} title={g.addTitle} aria-label={g.addTitle}>
                <IconPlus size={12} />
              </button>
            </div>
            <div className="skills-panel__dirs-list">
              {g.rows.length === 0 && <div className="skills-panel__dir-group-empty">{g.empty}</div>}
              {g.rows.map((row) => (
                <ScopeRow
                  key={row.dir}
                  row={row}
                  active={row.dir === selectedDir}
                  onSelect={() => { setSelectedDir(row.dir); setSelectedKind(row.kind) }}
                  onRemove={() => (row.kind === 'global' ? void onRemoveGlobalDir(row.dir) : void onRemoveDir(row.dir))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── 右侧：Skill 列表 ── */}
      <div className="skills-panel__skills">
        <div className="skills-panel__skills-bar">
          <div className="skills-panel__search">
            <IconSearch size={12} />
            <input
              className="skills-panel__search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索…"
              aria-label="搜索 Skill"
            />
            {search && (
              <button className="skills-panel__search-clear" onClick={() => setSearch('')}>
                <IconClose size={11} />
              </button>
            )}
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => void refreshDir()} title="刷新">刷新</button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => { if (selectedDir) void api.openInExplorer(selectedDir) }}
            title="在文件管理器打开该目录"
            disabled={!selectedDir}
          >
            打开目录
          </button>
          <div className="skills-panel__spacer" />
          {canManage && (
            <>
              <button className="btn btn--ghost btn--sm" disabled={importing} onClick={() => void onImportZip()}>
                导入 ZIP
              </button>
              <button className="btn btn--ghost btn--sm" disabled={importing} onClick={() => void onImportDir()}>
                导入目录
              </button>
            </>
          )}
        </div>

        <div className="skills-panel__list" role="list" aria-label="Skill 列表">
          {loading ? (
            <div className="skills-panel__loading">加载中…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<IconTerminal size={22} />}
              title={search ? '无匹配' : '暂无 Skill'}
              text={search ? '没有匹配的 Skill'
                : canManage ? '点击「导入 ZIP」或「导入目录」添加 Skill'
                : '此目录下暂无 Skill（全局目录只读）'}
            />
          ) : (
            paged.slice.map((skill, i) => {
              /* 四色卡：按绝对序轮换（紫/蓝/绿/橙），翻页不重置花色节奏 */
              const tone = SKILL_CARD_TONES[(paged.start + i) % SKILL_CARD_TONES.length]
              return (
                <div
                  key={skill.id}
                  className={`card skill-card skill-card--${tone}`}
                  role="listitem"
                  tabIndex={0}
                  onClick={() => setDetail(skill)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(skill) } }}
                  aria-label={`查看 ${skill.name} 详情`}
                >
                  <div className="skill-card__head">
                    <span className="skill-card__name">{skill.name}</span>
                    {canManage && (
                      <div className="skill-card__actions">
                        <button
                          className="icon-btn"
                          onClick={(e) => { e.stopPropagation(); void onDelete(skill.id, skill.name) }}
                          title="删除"
                          aria-label={`删除 ${skill.name}`}
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="skill-card__id mono">{skill.id}</div>
                  <div className="skill-card__desc">{skill.description || '（无描述）'}</div>
                  {skill.triggers.length > 0 && (
                    <div className="skill-card__tags">
                      {skill.triggers.slice(0, 4).map((t) => <span key={t} className="skill-card__tag">{t}</span>)}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <Pager page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />

        {detail && (
          <SkillDetailDialog skill={detail} dir={selectedDir} onClose={() => setDetail(null)} />
        )}

        <div className="skills-panel__status">
          {selectedDir ? (
            <>
              <span title={selectedDir}>{dirLabel(selectedDir)}</span>
              <span>·</span>
              <span>{dirSkills.length} 个 Skill</span>
              <span>·</span>
              {/* 策略提示放底栏：塞工具栏会让两态工具栏高度不一致（项目态换行 → 卡片区整体下移） */}
              <span>{isGlobalDir ? '全局 · 只读' : '项目 · 可管理'}</span>
            </>
          ) : (
            <span>未选择目录</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Skill 详情弹窗：点卡片查看目录内容（readSkill 全文） */
function SkillDetailDialog({ skill, dir, onClose }: {
  skill: SkillMeta
  dir: string | null
  onClose: () => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(false)
    if (!dir) { setError(true); return }
    api.readSkill([dir], skill.id)
      .then((text) => { if (!cancelled) setContent(text ?? '') })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [dir, skill.id])

  return (
    <div ref={trapRef} className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={`${skill.name} 详情`}>
        <div className="modal__head">
          <span>{skill.name}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </div>
        {skill.description && <p className="modal__msg">{skill.description}</p>}
        {skill.triggers.length > 0 && (
          <div className="skill-detail__meta">
            {skill.triggers.map((t) => <span key={t} className="skill-card__tag">{t}</span>)}
          </div>
        )}
        <div className="modal__body">
          <span className="skill-detail__label">SKILL 内容</span>
          {error ? (
            <div className="skill-detail__error">读取 Skill 内容失败（目录可能已移动或无读取权限）</div>
          ) : content === null ? (
            <div className="skill-detail__loading">加载中…</div>
          ) : (
            <pre className="skill-detail__body">{content || '（内容为空）'}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
