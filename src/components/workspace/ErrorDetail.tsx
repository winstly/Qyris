import { useAppStore } from '@/store/useAppStore'
import { useChatStore, selectCurrentChat } from '@/store/useChatStore'

interface Props {
  slotName: string
  errorText: string
  slotCommand: string
  portInfo: { pid: number; name: string; port: number } | null
  chatBusy: boolean
  requestToolchainInstall: () => void
}

/** 异常详情：错误输出 + 端口占用 + 发给 AI 修复 / 授权安装 */
export function ErrorDetail(p: Props) {
  const onFix = () => {
    const chat = selectCurrentChat(useChatStore.getState())
    if (chat.status !== 'idle' && chat.status !== 'error') return
    const cliMode = useAppStore.getState().settings.dispatchMode === 'claude-cli'
    const fixHint = cliMode
      ? ' 诊断后如果需要修改启动命令，在回复最后一行用 [[START_COMMANDS: [{"name":"portal","run":"npm run dev"}]]] 格式提交修正后的完整启动命令清单。'
      : ' 诊断后如果需要修改启动命令，必须调用 update_start_command 更新该服务的启动命令。'
    void useChatStore.getState().send(
      `启动服务「${p.slotName}」失败，当前启动命令为：\n\`\`\`\n${p.slotCommand}\n\`\`\`\n报错信息如下：\n\`\`\`\n${p.errorText}\n\`\`\`\n请诊断原因并修复。` + fixHint,
    )
  }

  return (
    <div className="error-box" role="alert">
      <div className="error-box__title">{p.slotName} 异常 · 以下为 stderr 末尾输出</div>
      <pre className="error-box__body mono">{p.errorText || '（无错误输出）'}</pre>
      {p.portInfo && (
        <div className="error-box__port mono">
          端口 {p.portInfo.port} 正被 {p.portInfo.name}（PID {p.portInfo.pid}）监听——可「全部停止」后重试，或在对话中让 AI 换端口
        </div>
      )}
      <div className="error-box__actions">
        <button className="btn btn--primary btn--sm" disabled={p.chatBusy || !p.errorText} onClick={onFix}>
          发给 AI 修复
        </button>
        {p.errorText.includes('未找到命令') && (
          <button className="btn btn--ghost btn--sm" onClick={p.requestToolchainInstall}>授权 AI 自动安装</button>
        )}
        <span className="error-box__hint">将错误信息发到对话，由 AI 诊断并修复</span>
      </div>
    </div>
  )
}
