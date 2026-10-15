/**
 * load_skill 指令协议：生成器与反解正则同文件收编（措辞即协议）。
 * ChatInput（发送时拼接）与 chatHistory（历史重建时拼接）共用生成器，两路输出逐字节一致；
 * ai-cli.extractSkillIds 用下方正则从历史消息反解 Skill id。改措辞 = 改协议：本文件内生成器与正则同步改。
 */

/** 加载指令生成器（单/多 Skill 两形态） */
export function skillLoadInstruction(ids: string[]): string {
  const joined = ids.join(', ')
  return ids.length > 1
    ? `请先用 load_skill 依次加载以下 ${ids.length} 个 Skill，全部加载后再执行：${joined}`
    : `请先用 load_skill 加载 Skill「${joined}」，再执行。`
}

/** 历史消息反解正则（与上方生成器一一对应） */
export const SKILL_MULTI_RE = /请先用 load_skill 依次加载以下 \d+ 个 Skill，全部加载后再执行：([^\n]+)/g
export const SKILL_SINGLE_RE = /请先用 load_skill 加载 Skill「([^」]+)」/g

/** 剥前缀正则（渲染层展示用户原文用）：锚定 ^ 的整段匹配，与生成器输出逐字节对应。
 *  多 Skill 形态的 id 列表以「[^\n]+」整行吞掉（生成器输出到行尾，行尾后即用户原文分隔）；
 *  单 Skill 形态必须吃到「，再执行。」——只到「」会把尾句漏进用户可见文本。 */
export const SKILL_MULTI_STRIP_RE = /^请先用 load_skill 依次加载以下 \d+ 个 Skill，全部加载后再执行：[^\n]+/
export const SKILL_SINGLE_STRIP_RE = /^请先用 load_skill 加载 Skill「[^」]+」，再执行。/

/** 剥掉 Skill 加载指令前缀，返回用户原文（无前缀原样返回） */
export function stripSkillInstruction(content: string): string {
  return content.replace(SKILL_MULTI_STRIP_RE, '').replace(SKILL_SINGLE_STRIP_RE, '')
}
