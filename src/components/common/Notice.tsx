/**
 * 静态提示条（ok/err，无自动消失）：常驻状态展示用（列表加载失败等）。
 * 操作反馈不走这里——统一出口是 Toast（右上角冒泡，自动消失）。
 */
import { IconAlert, IconCheck } from './icons'

export interface NoticeState {
  kind: 'ok' | 'err'
  text: string
}

export function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null
  return (
    <div className={`notice ${notice.kind === 'ok' ? 'notice--ok' : 'notice--err'}`}>
      {notice.kind === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
      <span>{notice.text}</span>
    </div>
  )
}
