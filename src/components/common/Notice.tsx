/**
 * 提示条（ok/err）+ 自动收口：全仓面板共用一份渲染与节奏（6s 不粘屏）。
 * 静态错误提示（无自动消失）也可直接用 <Notice/>，不接 useNotice 即常驻。
 */
import { useEffect, useState } from 'react'
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

/** notice 状态 + 自动消失（timeoutMs 缺省 6s） */
export function useNotice(timeoutMs = 6000): [NoticeState | null, (n: NoticeState | null) => void] {
  const [notice, setNotice] = useState<NoticeState | null>(null)
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), timeoutMs)
    return () => window.clearTimeout(t)
  }, [notice, timeoutMs])
  return [notice, setNotice]
}
