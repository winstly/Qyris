/** load_skill 加载指令生成器（唯一定义在 shared/skill-protocol.ts，与反解正则同文件） */
export { skillLoadInstruction, stripSkillInstruction } from '../../shared/skill-protocol'

import type { SkillMeta } from '@/types'

/** 项目 + 用户 Skill 合并：项目在前用户在后，按 id 去重（项目侧命中优先）。
 *  同一 Skill 目录既挂全局又挂项目时不去重会出现两行同名。 */
export function mergeSkills(project: SkillMeta[], user: SkillMeta[]): SkillMeta[] {
  const out: SkillMeta[] = []
  const seen = new Set<string>()
  for (const s of [...project, ...user]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}
