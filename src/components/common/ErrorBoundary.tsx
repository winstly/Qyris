/**
 * 渲染层全局错误边界：组件树崩溃时显示可恢复界面（重载面板），不再白屏。
 * 挂在 App 最外层（main.tsx）；错误详情进 console（渲染层日志经 IPC 汇入主进程日志由 consolebridge 承担）。
 */
import React from 'react'
import { IconAlert } from '@/components/common/icons'

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[boundary] 渲染层组件树崩溃：', error, info.componentStack)
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="modal-mask">
          <div className="modal" role="alertdialog" aria-label="界面异常">
            <div className="modal__head">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconAlert size={14} /> 界面出现异常
              </span>
            </div>
            <div className="modal__msg mono" style={{ maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
              {this.state.error.message || String(this.state.error)}
            </div>
            <div className="modal__actions">
              <button className="btn btn--primary" onClick={() => window.location.reload()}>
                重载界面
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
