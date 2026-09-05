import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { IconClose } from './icons'

/** 内联 prompt / confirm 对话框（支持可选复选框） */
export function Dialogs() {
  const dialog = useAppStore((s) => s.dialog)
  const resolveDialog = useAppStore((s) => s.resolveDialog)
  const [value, setValue] = useState('')
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  /** holdOpen 模式下确定后的执行中状态：按钮 loading、取消/遮罩关闭全部锁死 */
  const [confirming, setConfirming] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setConfirming(false)
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
  const isChoice = dialog.kind === 'choice'
  const hasChecks = !!dialog.checks?.length

  const toggleCheck = (id: string) => setChecks((prev) => ({ ...prev, [id]: !prev[id] }))

  const confirm = () => {
    if (!hasChecks) { resolveDialog(isPrompt ? value.trim() : true); return }
    if (dialog.holdOpen) { setConfirming(true); dialog.resolve({ confirmed: true, checks } as never); return }
    dialog.resolve({ confirmed: true, checks } as never)
    useAppStore.setState({ dialog: null })
  }
  const cancel = () => {
    if (confirming) return
    if (!hasChecks) { resolveDialog(isPrompt ? null : false); return }
    dialog.resolve({ confirmed: false, checks } as never)
    useAppStore.setState({ dialog: null })
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget && !confirming) cancel() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={dialog.title}>
        <div className="modal__head">
          <span>{dialog.title}</span>
          <button className="icon-btn" onClick={cancel} aria-label="关闭" disabled={confirming}>
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
                  disabled={confirming}
                />
                <span className="modal__check-label">{c.label}</span>
              </label>
            ))}
          </div>
        )}

        <div className="modal__actions">
          {isChoice && dialog.choices ? (
            <>
              <button className="btn btn--ghost" onClick={cancel} disabled={confirming}>取消</button>
              {dialog.choices.map((c) => (
                <button
                  key={c.id}
                  className={`btn btn--${c.variant ?? 'primary'}`}
                  onClick={() => {
                    dialog.resolve(c.id as never)
                    useAppStore.setState({ dialog: null })
                  }}
                  disabled={confirming}
                >
                  {c.label}
                </button>
              ))}
            </>
          ) : (
            <>
              {!isAlert && <button className="btn btn--ghost" onClick={cancel} disabled={confirming}>取消</button>}
              <button
                className="btn btn--primary"
                onClick={confirm}
                autoFocus
                disabled={(isPrompt && !value.trim()) || confirming}
              >
                {confirming ? (dialog.confirmingText ?? '处理中…') : isAlert ? '知道了' : '确定'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
