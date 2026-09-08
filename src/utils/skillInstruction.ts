/**
 * load_skill 加载指令的唯一生成器：ChatInput（发送时拼接）与 chatHistory（历史重建时拼接）
 * 共用，保证两路输出逐字节一致。
 *
 * ⚠️ 措辞是协议：electron/lib/ai-cli.ts 的 SKILL_MULTI_RE / SKILL_SINGLE_RE 正则靠这段文本
 * 反解 Skill id，scripts/smoke-ai-cli.ts 也有断言钉死——改措辞必须生成器、正则、smoke 三处同步。
 */
export function skillLoadInstruction(ids: string[]): string {
  const joined = ids.join(', ')
  return ids.length > 1
    ? `请先用 load_skill 依次加载以下 ${ids.length} 个 Skill，全部加载后再执行：${joined}`
    : `请先用 load_skill 加载 Skill「${joined}」，再执行。`
}
