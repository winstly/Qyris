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
