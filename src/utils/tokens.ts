/** token 估算与展示格式（主对话与子 agent 共用） */

/** 粗略 token 估算：ASCII 4 字符 / 非 ASCII（中日韩等）1 字符 ≈ 1 token */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

/** token 数展示：1.2k 风格 */
export function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}
