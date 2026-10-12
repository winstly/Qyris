/**
 * 项目配置键归一（跨进程共用，纯函数，不 import node/electron）。
 * deployServersMap / mcpServersMap 等以 projectRoot 为键的配置表共用此口径：
 * 统一分隔符 + 去尾分隔符 + 按平台折叠大小写（win32/darwin 折叠，与 watcher.ts normPath 同规；
 * Linux 大小写敏感，保留原样——否则 /ProjA 与 /proja 两个目录会并成一桶）。
 * 注意：proc.ts runOnce 另有自己的 key 归一（只剥尾分隔符，不转分隔符），语义不完全一致。
 */
export function projectConfigKey(projectRoot: string): string {
  const n = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  // 共享层拿不到 node 的 process.platform 时保守折叠大小写（等价旧口径）
  const platform = typeof process !== 'undefined' ? process.platform : 'win32'
  return platform === 'win32' || platform === 'darwin' ? n.toLowerCase() : n
}
