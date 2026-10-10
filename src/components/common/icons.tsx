/**
 * RemixIcon 图标字体适配层 —— 单一字体字形族，跟随 currentColor
 *
 * theme-v2-chat 口径（换血决策，覆盖旧「不换 Remix」的在案理由）：
 *   · npm 官方 remixicon 包（全量 woff2 ~130KB，31 个导出全有真字形）
 *     —— Qyris-new 目录里的裁剪版只有 47 字形、缺 11 个，不引入。
 *   · 字体图标天然 currentColor，换主题零改动。
 *   · 导出名与 { size, className } 签名保持不变，调用方零改动。
 *   · `od-icon` 类名保留作 CSS 钩子（兼容历史选择器与尺寸覆盖位）。
 */
import type { CSSProperties } from 'react'

type P = { size?: number; className?: string; style?: CSSProperties }

/** 字体图标渲染：size 走 fontSize（RemixIcon 是 1em 网格的字体字形） */
function ri(glyph: string, { size = 16, className, style }: P) {
  return (
    <i
      className={`od-icon ${glyph}${className ? ` ${className}` : ''}`}
      style={{ fontSize: size, ...style }}
      aria-hidden
    />
  )
}

export function IconFolder(p: P) { return ri('ri-folders-line', p) }
export function IconFolderOpen(p: P) { return ri('ri-folder-open-line', p) }
export function IconFolderPlus(p: P) { return ri('ri-folder-add-line', p) }
export function IconFile(p: P) { return ri('ri-file-text-line', p) }
export function IconChevron(p: P) { return ri('ri-arrow-right-s-line', p) }
export function IconPlay(p: P) { return ri('ri-play-fill', p) }
export function IconStop(p: P) { return ri('ri-stop-fill', p) }
export function IconRefresh(p: P) { return ri('ri-refresh-line', p) }
export function IconSend(p: P) { return ri('ri-send-plane-fill', p) }
export function IconGear(p: P) { return ri('ri-settings-3-line', p) }
export function IconSearch(p: P) { return ri('ri-search-line', p) }
export function IconClose(p: P) { return ri('ri-close-line', p) }
export function IconPlus(p: P) { return ri('ri-add-line', p) }
export function IconTrash(p: P) { return ri('ri-delete-bin-line', p) }
export function IconPencil(p: P) { return ri('ri-edit-line', p) }
export function IconCopy(p: P) { return ri('ri-file-copy-line', p) }
export function IconScissors(p: P) { return ri('ri-scissors-line', p) }
export function IconCheck(p: P) { return ri('ri-check-line', p) }
export function IconAlert(p: P) { return ri('ri-alert-line', p) }
export function IconTerminal(p: P) { return ri('ri-terminal-box-line', p) }
export function IconLink(p: P) { return ri('ri-links-line', p) }
export function IconBranch(p: P) { return ri('ri-git-branch-line', p) }
export function IconExternal(p: P) { return ri('ri-external-link-line', p) }
export function IconEye(p: P) { return ri('ri-eye-line', p) }
export function IconTarget(p: P) { return ri('ri-focus-3-line', p) }
export function IconUndo(p: P) { return ri('ri-arrow-go-back-line', p) }
export function IconClock(p: P) { return ri('ri-time-line', p) }
export function IconDesktop(p: P) { return ri('ri-computer-line', p) }
export function IconTablet(p: P) { return ri('ri-tablet-line', p) }
export function IconMobile(p: P) { return ri('ri-smartphone-line', p) }
export function IconLayers(p: P) { return ri('ri-stack-line', p) }
