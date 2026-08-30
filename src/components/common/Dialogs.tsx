import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { IconClose } from './icons'

/**
 * 内联 prompt / confirm 对话框（支持可选复选框）。
 * 不用 window.confirm / alert —— Electron WebView 对原生弹窗支持不完整。
 */
export function Dialogs() {
  const dialog = useAppStore((s) => s.dialog)
  const resolveDialog = useAppStore((s) => s.resolveDialog)
  const [value, setValue] = useState('')
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.value ?? '')
      requestAnimationFrame(() => inputRef.current?.select())
    }
    if (dialog?.checks) {
      const init: Record<string, boolean> = {}
      for (const c of dialog.checks) init[c.id] = c.checked ?? false
      setChecks(init)
    } else {
      setChecks({})
    }
  }, [dialog])

  if (!dialog) return null

  const isPrompt = dialog.kind === 'prompt'
  const isAlert = dialog.kind === 'alert'
  const hasChecks = !!dialog.checks?.length

  const toggleCheck = (id: string) => setChecks((prev) => ({ ...prev, [id]: !prev[id] }))

  const confirm = () => {
    if (hasChecks) {
      // 直接调用 dialog 自带的 resolve，绕过 resolveDialog 的类型限制
      dialog.resolve({ confirmed: true, checks } as never)
      // 关闭对话框（不经过 resolveDialog 二次 resolve）
      useAppStore.setState({ dialog: null })
    } else {
      resolveDialog(isPrompt ? value.trim() : true)
    }
  }
  const cancel = () => {
    if (hasChecks) {
      dialog.resolve({ confirmed: false, checks } as never)
      useAppStore.setState({ dialog: null })
    } else {
      resolveDialog(isPrompt ? null : false)
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={dialog.title}>
        <div className="modal__head">
          <span>{dialog.title}</span>
          <button className="icon-btn" onClick={cancel} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </div>

        {dialog.message && <p className="modal__msg">{dialog.message}</p>}

        {isPrompt && (
          <input
            ref={inputRef}
            className="modal__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
              if (e.key === 'Escape') cancel()
            }}
            placeholder="输入名称"
          />
        )}

        {hasChecks && (
          <div className="modal__checks">
            {dialog.checks!.map((c) => (
              <label key={c.id} className="modal__check">
                <input
                  type="checkbox"
                  checked={checks[c.id] ?? false}
                  onChange={() => toggleCheck(c.id)}
                />
                <span className="modal__check-label">{c.label}</span>
              </label>
            ))}
          </div>
        )}

        <div className="modal__actions">
          {!isAlert && <button className="btn btn--ghost" onClick={cancel}>取消</button>}
          <button className="btn btn--primary" onClick={confirm} autoFocus disabled={isPrompt && !value.trim()}>
            {isAlert ? '知道了' : '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
