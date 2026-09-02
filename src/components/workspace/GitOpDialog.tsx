/**
 * git 操作过场弹窗：运行中（转圈，不可关闭）→ 成功（✓ + 输出）/ 失败（✗ + 原因）→ 用户手动关闭。
 * 挂载于 FilesTab 一次；GitPanel 按钮与文件树右键的 git 操作共用。
 */
import { useGitStore } from '@/store/useGitStore'
import { IconAlert, IconCheck, IconClose } from '@/components/common/icons'

export function GitOpDialog() {
  const dialog = useGitStore((s) => s.opDialog)
  const closeOpDialog = useGitStore((s) => s.closeOpDialog)
  if (!dialog) return null
  const done = dialog.state !== 'running'

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => { if (e.target === e.currentTarget && done) closeOpDialog() }}
    >
      <div className="modal gitop" role="alertdialog" aria-modal="true" aria-label={dialog.label}>
        <div className="modal__head">
          <span>{dialog.label}</span>
          {done && (
            <button className="icon-btn" onClick={closeOpDialog} aria-label="关闭">
              <IconClose size={14} />
            </button>
          )}
        </div>

        {dialog.state === 'running' && (
          <div className="gitop__running">
            <span className="gitop__spinner" aria-label="进行中" />
            <span className="gitop__running-text">{dialog.label}中…</span>
            <span className="gitop__hint">正在与仓库通信，请稍候</span>
          </div>
        )}

        {dialog.state === 'ok' && (
          <div className="gitop__result">
            <div className="gitop__badge"><IconCheck size={17} /></div>
            <div className="gitop__title">{dialog.label}成功</div>
            {dialog.detail && <pre className="gitop__detail mono">{dialog.detail}</pre>}
            <div className="modal__actions">
              <button className="btn btn--primary btn--sm" onClick={closeOpDialog}>好的</button>
            </div>
          </div>
        )}

        {dialog.state === 'fail' && (
          <div className="gitop__result gitop__result--fail">
            <div className="gitop__badge"><IconAlert size={17} /></div>
            <div className="gitop__title">{dialog.label}失败</div>
            <pre className="gitop__detail mono">{dialog.detail || '未知错误'}</pre>
            <div className="modal__actions">
              <button className="btn btn--primary btn--sm" onClick={closeOpDialog}>知道了</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
