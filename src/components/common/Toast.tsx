/**
 * 全局 Toast（右上角堆叠，自动消失）：操作反馈的统一出口——新增/删除/编辑/导入/导出/
 * 恢复等结果都在这里冒泡。取代两条旧路：内联 Notice 条（易被忽略）与模态 showAlert
 * （打断流）。错误 toast 停留更久；点击任意一条立即关闭。
 * 用法：import { toast } from '@/components/common/Toast' → toast.ok('已保存', 'xxx')
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { IconClose } from './icons'

/** 状态图标（remixicon 圆角实心系，与全仓 ri-* 图标语言一致；着色走 CSS，无底色圆） */
const KIND_ICON: Record<ToastKind, string> = {
  ok: 'ri-checkbox-circle-fill',
  err: 'ri-close-circle-fill',
  info: 'ri-information-fill',
}

export type ToastKind = 'ok' | 'err' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  title: string
  text?: string
}

interface ToastState {
  items: ToastItem[]
  push: (kind: ToastKind, title: string, text?: string) => void
  dismiss: (id: number) => void
}

let seq = 0
/** ok 3.5s 自清；err/info 需要读正文，6s */
const DURATION: Record<ToastKind, number> = { ok: 3500, err: 6000, info: 6000 }
/** 同屏最多 4 条，更早的让位（连续批量操作不堆成幕墙） */
const MAX_VISIBLE = 4

export const useToastStore = create<ToastState>()((set) => ({
  items: [],
  push: (kind, title, text) =>
    set((s) => ({
      items: [...s.items, { id: ++seq, kind, title, text }].slice(-MAX_VISIBLE),
    })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

/** 命令式入口（组件外/事件回调里也能发）：toast.ok(...) / toast.err(...) / toast.info(...) */
export const toast = {
  ok: (title: string, text?: string): void => { useToastStore.getState().push('ok', title, text) },
  err: (title: string, text?: string): void => { useToastStore.getState().push('err', title, text) },
  info: (title: string, text?: string): void => { useToastStore.getState().push('info', title, text) },
}

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss)
  useEffect(() => {
    const t = window.setTimeout(() => dismiss(item.id), DURATION[item.kind])
    return () => window.clearTimeout(t)
  }, [item.id, item.kind, dismiss])

  return (
    // 点击整卡即关：toast 是反馈不是弹窗，不强制找关闭钮
    <div
      className={`toast toast--${item.kind}`}
      role="status"
      aria-live="polite"
      onClick={() => dismiss(item.id)}
      title="点击关闭"
    >
      <i className={`toast__icon od-icon ${KIND_ICON[item.kind]}`} aria-hidden />
      <span className="toast__body">
        <span className="toast__title">{item.title}</span>
        {item.text && <span className="toast__text">{item.text}</span>}
      </span>
      <button
        className="toast__close"
        aria-label="关闭提示"
        onClick={(e) => { e.stopPropagation(); dismiss(item.id) }}
      >
        <IconClose size={10} />
      </button>
    </div>
  )
}

/** 全局挂载一次（App 根部）：fixed 右上角堆叠容器 */
export function ToastHost() {
  const items = useToastStore((s) => s.items)
  if (items.length === 0) return null
  return (
    <div className="toast-stack" aria-label="操作提示">
      {items.map((t) => <ToastCard key={t.id} item={t} />)}
    </div>
  )
}
