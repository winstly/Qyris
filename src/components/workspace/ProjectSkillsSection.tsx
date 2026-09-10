/**
 * 项目技能管理面板（工作区「技能」Tab）。
 * 左侧：Skill 目录列表（.qyris/skills 默认 + 可追加外部目录）
 * 右侧：选中目录下的 Skill 列表（导入 ZIP / 导入目录 / 删除）
 */
import { useEffect, useState } from 'react'
import { api } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { EmptyState } from '@/components/common/EmptyState'
import { IconAlert, IconCheck, IconClose, IconFolder, IconPlus, IconSearch, IconTerminal, IconTrash } from '@/components/common/icons'
import type { SkillMeta } from '@/types'

export function ProjectSkillsPanel() {
  const projectPath = useAppStore((s) => s.projectPath)
  const projectSkillsDirs = useAppStore((s) => s.projectSkillsDirs)
  const addProjectSkillsDir = useAppStore((s) => s.addProjectSkillsDir)
  const removeProjectSkillsDir = useAppStore((s) => s.removeProjectSkillsDir)
  const loadProjectSkills = useAppStore((s) => s.loadProjectSkills)
  const showConfirm = useAppStore((s) => s.showConfirm)

  /** 当前选中的目录（默认第一个） */
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  /** 选中目录下的 Skill 列表（单独扫描，不走全局 merged） */
  const [dirSkills, setDirSkills] = useState<SkillMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [search, setSearch] = useState('')

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

  // 目录列表变化时：若当前选中被移除，回退到第一个
  useEffect(() => {
    if (!selectedDir || !projectSkillsDirs.includes(selectedDir)) {
      setSelectedDir(projectSkillsDirs[0] ?? null)
    }
  }, [projectSkillsDirs, selectedDir])

  /** 是否为内置 .qyris/skills 目录（第一个 = 默认，不可移除） */
  const isBuiltinDir = selectedDir === projectSkillsDirs[0]

  // 切到技能 Tab 自动刷新
  const activeTab = useAppStore((s) => s.activeTab)
  useEffect(() => {
    if (activeTab === 'skills' && projectPath) {
      void loadProjectSkills()
    }
  }, [activeTab, projectPath, loadProjectSkills])

  // notice 自动消失
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [notice])

  const showNotice = (n: { kind: 'ok' | 'err'; text: string }) => setNotice(n)

  /** 从 ZIP 导入 Skill 到当前选中目录 */
  const onImportZip = async () => {
    if (!selectedDir || importing) return
    const zipPath = await api.projectSkillPickZip()
    if (!zipPath) return
    setImporting(true)
    try {
      const r = await api.projectSkillImportZip(selectedDir, zipPath)
      if (r.ok) {
        showNotice({ kind: 'ok', text: `已导入 Skill「${r.name}」` })
        await refreshDir()
      } else {
        showNotice({ kind: 'err', text: r.error || '导入失败' })
      }
    } catch (e) {
      showNotice({ kind: 'err', text: String(e) })
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
        showNotice({ kind: 'ok', text: msg })
        await refreshDir()
      } else {
        showNotice({ kind: 'err', text: r.error || '导入失败' })
      }
    } catch (e) {
      showNotice({ kind: 'err', text: String(e) })
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
        showNotice({ kind: 'ok', text: `已删除 Skill「${name}」` })
        await refreshDir()
      } else {
        showNotice({ kind: 'err', text: r.error || '删除失败' })
      }
    } catch (e) {
      showNotice({ kind: 'err', text: String(e) })
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

  // 目录显示名：截取最后两级路径
  const dirLabel = (dir: string) => {
    const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts.length >= 2 ? parts.slice(-2).join('/') : dir
  }

  if (!projectPath) {
    return (
      <div className="skills-panel">
        <EmptyState icon={<IconTerminal size={22} />} title="未打开项目" text="打开项目后可管理项目级 Skill" />
      </div>
    )
  }

  return (
    <div className="skills-panel">
      {/* ── 左侧：目录列表 ── */}
      <div className="skills-panel__dirs">
        <div className="skills-panel__dirs-head">
          <span>目录</span>
          <button className="icon-btn" onClick={() => void onAddDir()} title="添加目录" aria-label="添加目录">
            <IconPlus size={13} />
          </button>
        </div>
        <div className="skills-panel__dirs-list">
          {projectSkillsDirs.map((dir, i) => {
            const isDefault = i === 0
            const isActive = dir === selectedDir
            return (
              <div
                key={dir}
                className={`skills-panel__dir ${isActive ? 'skills-panel__dir--active' : ''}`}
                onClick={() => setSelectedDir(dir)}
                title={dir}
              >
                <IconFolder size={13} />
                <span className="skills-panel__dir-name">{dirLabel(dir)}</span>
                {isDefault && <span className="skills-panel__dir-badge">默认</span>}
                {!isDefault && (
                  <button
                    className="icon-btn skills-panel__dir-remove"
                    onClick={(e) => { e.stopPropagation(); void onRemoveDir(dir) }}
                    title="移除目录"
                    aria-label="移除目录"
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
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
          <div className="skills-panel__spacer" />
          {isBuiltinDir && (
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

        {notice && (
          <div className={`notice ${notice.kind === 'ok' ? 'notice--ok' : 'notice--err'}`}>
            {notice.kind === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
            <span>{notice.text}</span>
          </div>
        )}

        <div className="skills-panel__list" role="list" aria-label="Skill 列表">
          {loading ? (
            <div className="skills-panel__loading">加载中…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<IconTerminal size={22} />}
              title={search ? '无匹配' : '暂无 Skill'}
              text={search ? '没有匹配的 Skill'
                : isBuiltinDir ? '点击「导入 ZIP」或「导入目录」添加 Skill'
                : '此目录下暂无 Skill'}
            />
          ) : (
            filtered.map((skill) => (
              <div key={skill.id} className="skill-row" role="listitem">
                <div className="skill-row__info">
                  <span className="skill-row__name">{skill.name}</span>
                  {skill.description && <span className="skill-row__desc">{skill.description}</span>}
                  {skill.triggers.length > 0 && (
                    <span className="skill-row__triggers">
                      {skill.triggers.map((t) => <span key={t} className="skill-row__tag">{t}</span>)}
                    </span>
                  )}
                </div>
                {isBuiltinDir && (
                  <div className="skill-row__actions">
                    <button className="icon-btn" onClick={() => void onDelete(skill.id, skill.name)} title="删除" aria-label="删除">
                      <IconTrash size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="skills-panel__status">
          {selectedDir ? (
            <>
              <span title={selectedDir}>{dirLabel(selectedDir)}</span>
              <span>·</span>
              <span>{dirSkills.length} 个 Skill</span>
            </>
          ) : (
            <span>未选择目录</span>
          )}
        </div>
      </div>
    </div>
  )
}
