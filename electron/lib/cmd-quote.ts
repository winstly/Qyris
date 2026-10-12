/**
 * Windows cmd.exe 命令行拼装（shell:true 单串传参的引号纪律，全仓唯一口径）。
 * ai-cli / model/providers/claude-cli / mcp/client 三处 spawn 共用——引号规则只许有一份：
 * 规则强弱不齐时，弱的那份就是注入面（cmd 元字符被二次解析成命令分隔符）。
 */

/** Windows 单 token 引号包装：cmd 元字符（& | < > ^ ( ) !）/ 空白 / 引号任一出现即成对引号，
 *  内层双引号翻倍（argv 通行规则）；空串显式 ""（否则 `--tools ""` 这类空参会被 cmd 吞掉）。
 *  防 cmd 二次解析把 arg 拆成多条命令（如 URL 里的 & ） */
export function quoteCmdArg(token: string): string {
  if (token === '') return '""'
  return /[\s"&|<>^()!]/.test(token) ? `"${token.replace(/"/g, '""')}"` : token
}

/** 引号感知拆分命令串：`"D:\My Tools\claude.cmd" --foo` → 两段；支持 `npx -y xxx` 前置参数形态 */
export function splitCliCommand(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = m[1] ?? m[2] ?? ''
    if (t) out.push(t)
  }
  return out
}

/** Windows shell:true 整条命令行：command（先按引号拆段）与 args 一律过 quoteCmdArg 再拼接。
 *  对应 spawn(cmdLine, { shell: true })（cmd.exe /d /s /c "<整串>"，/s 只剥最外层引号）。 */
export function buildCmdLine(command: string, args: readonly string[]): string {
  return [...splitCliCommand(command), ...args].map(quoteCmdArg).join(' ')
}
