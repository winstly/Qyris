import { useMemo, useEffect, useCallback, useState } from 'react'
import { IconCheck } from '@/components/common/icons'
import type { SkillMeta } from '@/types'

/** Slash 命令状态管理：打开/关闭、过滤、选中索引、自动滚动 */
export function useSlashCommand(allSkills: SkillMeta[]) {
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)

  const filteredSkills = useMemo(() => {
    if (!slashOpen) return []
    if (!slashFilter) return allSkills
    const q = slashFilter.toLowerCase()
    // 按匹配字段分级排序：名称/id > 触发词 > 描述；同级保持原序
    const scored: { skill: SkillMeta; rank: number }[] = []
    for (const s of allSkills) {
      const nameHit = s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
      const triggerHit = !nameHit && s.triggers.some((t) => t.toLowerCase().includes(q))
      const descHit = !nameHit && !triggerHit && s.description.toLowerCase().includes(q)
      if (nameHit || triggerHit || descHit) {
        scored.push({ skill: s, rank: nameHit ? 0 : triggerHit ? 1 : 2 })
      }
    }
    return scored.sort((a, b) => a.rank - b.rank).map((s) => s.skill)
  }, [slashOpen, slashFilter, allSkills])

  useEffect(() => { setSlashIndex(0) }, [slashFilter])

  useEffect(() => {
    if (!slashOpen) return
    const el = document.querySelector('.slash-menu__item--active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashOpen])

  const closeSlash = useCallback(() => {
    setSlashOpen(false)
    setSlashFilter('')
    setSlashIndex(0)
  }, [])

  return {
    slashOpen, setSlashOpen,
    slashFilter, setSlashFilter,
    slashIndex, setSlashIndex,
    filteredSkills,
    closeSlash,
  }
}

/** Slash 菜单：选中态打勾、项目/用户分隔线、键盘提示 */
export function SlashMenu({
  filteredSkills,
  slashIndex,
  selectedIds,
  onSelect,
  onHoverIndex,
  className,
}: {
  filteredSkills: SkillMeta[]
  slashIndex: number
  selectedIds: Set<string>
  onSelect: (skill: SkillMeta) => void
  onHoverIndex?: (i: number) => void
  className?: string
}) {
  if (filteredSkills.length === 0) {
    return (
      <div className={`slash-menu ${className ?? ''}`}>
        <div className="slash-menu__empty">无匹配的 Skill</div>
        <div className="slash-menu__hint"><span>Esc 关闭</span></div>
      </div>
    )
  }
  return (
    <div className={`slash-menu ${className ?? ''}`} role="listbox" aria-label="选择 Skill">
      {filteredSkills.map((skill, i) => {
        const isFirstUserSkill = skill.scope !== 'project' && i > 0 && filteredSkills[i - 1]?.scope === 'project'
        return (
          <div key={skill.id}>
            {isFirstUserSkill && <div className="slash-menu__sep" />}
            <div
              className={`slash-menu__item ${i === slashIndex ? 'slash-menu__item--active' : ''}`}
              role="option"
              aria-selected={i === slashIndex}
              onMouseEnter={() => onHoverIndex?.(i)}
              onClick={() => onSelect(skill)}
            >
              <div className="slash-menu__item-name">
                {selectedIds.has(skill.id) ? (
                  <span className="slash-menu__item-check"><IconCheck size={10} /></span>
                ) : (
                  <span className="slash-menu__item-check-placeholder" />
                )}
                {skill.scope === 'project' && <span className="slash-menu__item-scope">项目</span>}
                <span>{skill.name}</span>
              </div>
              {skill.description && <span className="slash-menu__item-desc">{skill.description}</span>}
            </div>
          </div>
        )
      })}
      <div className="slash-menu__hint"><span>↑↓ 导航 · Enter 选择 · Esc 关闭</span></div>
    </div>
  )
}
