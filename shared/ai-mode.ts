/**
 * CLI agent 档口径（claude-cli / codex-cli）：配置归一、渲染层守卫、引擎分支共用同一判定，
 * 防新增档位时白名单/判定点漏改——codex-cli 曾因归一白名单缺失被抹成 api（设置保存即弹回）。
 */
export type CliAgentMode = 'claude-cli' | 'codex-cli'

export function isCliAgentMode(v: unknown): v is CliAgentMode {
  return v === 'claude-cli' || v === 'codex-cli'
}
