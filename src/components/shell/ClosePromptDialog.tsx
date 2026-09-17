/**
 * 主窗口关闭询问弹窗：主进程拦截 X 后推送 app:close-request，这里给出口径——
 * 最小化（隐藏窗口、桌宠仍在）还是完全退出；勾选记住后主进程落盘 closeAction 偏好。
 * 强制二选一（点遮罩不关闭）：关闭动作必须拿到明确口径，不猜。
 * app:close-cancel = 主进程超时兜底已按最小化处理，这里收起弹窗，
 * 否则窗口找回后残留的死按钮会打在已失效的 pending 位上（点了没反应）。
 */
import { useEffect, useState } from 'react'
import { onCloseCancel, onCloseRequest } from '@/services/desktop'

export function ClosePromptDialog() {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    const offRequest = onCloseRequest(() => {
      setRemember(false)
      setOpen(true)
    })
    const offCancel = onCloseCancel(() => setOpen(false))
    return () => {
      offRequest()
      offCancel()
    }
  }, [])

  if (!open) return null

  const resolve = (action: 'minimize' | 'quit') => {
    setOpen(false)
    window.desktopAPI?.resolveClose(action, remember)
  }

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" aria-label="关闭主窗口">
      <div className="modal">
        <div className="modal__head"><span>关闭主窗口</span></div>
        <p className="modal__msg">
          要把「轻驭」最小化到桌宠，还是完全退出？最小化后可随时右键桌宠选「打开工作台」找回。
        </p>
        <div className="modal__checks">
          <label className="modal__check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span className="modal__check-label">记住我的选择，下次不再询问</span>
          </label>
        </div>
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={() => resolve('quit')}>退出应用</button>
          <button className="btn btn--primary" onClick={() => resolve('minimize')}>最小化</button>
        </div>
      </div>
    </div>
  )
}
