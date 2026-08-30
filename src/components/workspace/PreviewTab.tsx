import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useBuildStore, selectSlotState } from '@/store/useBuildStore'
import { useChatStore } from '@/store/useChatStore'
import { api } from '@/services/desktop'
import { BuildPipeline } from './BuildPipeline'
import { IconPlay, IconStop, IconRefresh, IconTerminal, IconLink, IconFolder, IconTarget, IconDesktop, IconTablet, IconMobile } from '@/components/common/icons'

const PHASE_LABEL: Record<string, string> = {
  idle: '未运行', building: '编译中', deploying: '部署中', running: '运行中', error: '异常',
}

type DeviceMode = 'desktop' | 'tablet' | 'mobile'

const DEVICES: { mode: DeviceMode; label: string; width: number | null; Icon: typeof IconDesktop }[] = [
  { mode: 'desktop', label: '桌面', width: null, Icon: IconDesktop },
  { mode: 'tablet', label: '平板 (768px)', width: 768, Icon: IconTablet },
  { mode: 'mobile', label: '手机 (375px)', width: 375, Icon: IconMobile },
]

/** 预览 Tab：AI 启动 + 服务槽列表 + 状态流水线 + 预览 iframe（支持设备尺寸切换）。 */
export function PreviewTab() {
  const projectPath = useAppStore((s) => s.projectPath)
  const openProjectDialog = useAppStore((s) => s.openProjectDialog)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const showAlert = useAppStore((s) => s.showAlert)

  const slots = useBuildStore((s) => s.slots)
  const slotOrder = useBuildStore((s) => s.slotOrder)
  const activeSlot = useBuildStore((s) => s.activeSlot)
  const selectSlot = useBuildStore((s) => s.selectSlot)
  const start = useBuildStore((s) => s.start)
  const stop = useBuildStore((s) => s.stop)
  const stopAll = useBuildStore((s) => s.stopAll)
  const selectUrl = useBuildStore((s) => s.selectUrl)
  const slot = useBuildStore((s) => selectSlotState(s, s.activeSlot))

  const [showLogs, setShowLogs] = useState(false)
  const [iframeNonce, setIframeNonce] = useState(0)
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop')

  const phase = slot?.phase ?? 'idle'
  const url = slot?.detectedUrl || ''
  const anyAlive = slotOrder.some((k) => slots[k]?.processAlive)
  const showIframe = phase === 'running' && url !== ''
  const activeDevice = DEVICES.find((d) => d.mode === deviceMode) ?? DEVICES[0]
  const constrained = activeDevice.width !== null

  /** AI 启动 */
  const aiStart = () => {
    if (!projectPath) return
    if (!hasApiKey) {
      void showAlert('尚未配置 API Key', '点击右上角对话栏的齿轮图标，配置 Base URL 与 API Key 后即可使用 AI 启动。')
      return
    }
    const chat = useChatStore.getState()
    if (chat.status !== 'idle' && chat.status !== 'error') {
      void showAlert('AI 正忙', '上一条消息还在处理中，请稍候，或点击「停止生成」后重试。')
      return
    }
    void useChatStore.getState().send(
      `请帮我启动当前项目${slotOrder.length ? '（注意：部分服务已在运行，先 get_build_status 了解现状）' : ''}。` +
      '请探测技术栈，为每个需要启动的服务取一个简短英文服务名（各不重复），' +
      '用 run_project 逐个启动（不要拼进一个脚本），然后跟踪「编译 / 部署 / 运行」三个阶段的状态向我汇报；' +
      '编译失败请根据错误输出修复文件后重新启动。',
      { projectStart: true },
    )
  }

  const startPick = () => {
    if (!url) return
    void api.startElementPick(url)
  }

  return (
    <div className="preview">
      {/* 启动工具栏 */}
      <div className="preview__bar">
        <button
          className="btn btn--primary btn--sm"
          disabled={!projectPath}
          onClick={aiStart}
          title="由 AI 探测技术栈，为每个服务命名并逐一启动"
        >
          <IconPlay size={12} /> 启动
        </button>
        <span className="preview__hint">AI 会探测技术栈，为每个服务命名并各自启动（服务名自动对应地址）</span>
        <div className="preview__spacer" />
        <button className="btn btn--danger-ghost btn--sm" disabled={!anyAlive} onClick={() => void stopAll()} title="停止全部服务进程">
          <IconStop size={12} /> 全部停止
        </button>
      </div>

      {/* 服务槽列表 */}
      {slotOrder.length > 0 && (
        <div className="slots" role="list" aria-label="服务列表">
          {slotOrder.map((key) => {
            const st = slots[key]
            if (!st) return null
            const alive = st.processAlive
            const running = st.phase === 'running' && !!st.detectedUrl
            return (
              <div
                key={key}
                role="listitem"
                className={`slots__row ${key === activeSlot ? 'slots__row--active' : ''}`}
                onClick={() => selectSlot(key)}
              >
                <span className={`status-dot status-dot--${st.phase}`} />
                <span className="slots__name mono" title={key}>{key}</span>
                <span className="slots__cmd mono" title={st.command}>{st.command || '（未知命令）'}</span>
                {running && (
                  <a
                    className="slots__url mono"
                    href={st.detectedUrl!}
                    target="_blank"
                    rel="noreferrer"
                    title={`在浏览器中打开 ${st.detectedUrl}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {st.detectedUrl}
                  </a>
                )}
                <span className={`slots__phase slots__phase--${st.phase}`}>{PHASE_LABEL[st.phase]}</span>
                {alive ? (
                  <button className="btn btn--ghost btn--sm slots__action" onClick={(e) => { e.stopPropagation(); void stop(key) }}>
                    停止
                  </button>
                ) : (
                  <button className="btn btn--ghost btn--sm slots__action" disabled={!st.command} onClick={(e) => { e.stopPropagation(); void start(key, st.command) }} title="以原命令重启该服务">
                    启动
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 当前查看槽的阶段流水线 */}
      <BuildPipeline phase={phase} />

      {/* 预览地址控制条 + 设备切换 */}
      <div className="preview__urlbar">
        <IconLink size={13} />
        {slot && slot.detectedUrl ? (
          <>
            <a
              className="preview__addr mono"
              href={slot.detectedUrl}
              target="_blank"
              rel="noreferrer"
              title={`在浏览器中打开 ${slot.detectedUrl}`}
            >
              {slot.detectedUrl}
            </a>
            {slot.detectedUrls.length > 1 && (
              <select
                className="preview__url-select mono"
                value={slot.detectedUrl}
                onChange={(e) => selectUrl(slot.name, e.target.value)}
                aria-label="切换服务地址"
              >
                {slot.detectedUrls.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            )}
          </>
        ) : (
          <span className="preview__addr preview__addr--empty">当前服务的地址待自动解析（可查看进程日志）</span>
        )}
        <div className="preview__spacer" />
        {/* 设备切换按钮组 */}
        <div className="preview__devices" role="radiogroup" aria-label="预览设备">
          {DEVICES.map(({ mode, label, Icon }) => (
            <button
              key={mode}
              className={`preview__device-btn ${deviceMode === mode ? 'preview__device-btn--active' : ''}`}
              onClick={() => setDeviceMode(mode)}
              title={label}
              aria-label={label}
              aria-pressed={deviceMode === mode}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
        <span className="statusbar__sep" />
        <button className="icon-btn" onClick={startPick} disabled={!showIframe} aria-label="选取元素" title="选取预览页元素，带入 AI 对话">
          <IconTarget size={13} />
        </button>
        <button className="icon-btn" onClick={() => setIframeNonce((n) => n + 1)} disabled={!showIframe} aria-label="刷新预览" title="刷新预览">
          <IconRefresh size={13} />
        </button>
        <button className={`icon-btn ${showLogs ? 'icon-btn--active' : ''}`} onClick={() => setShowLogs((v) => !v)} aria-label="进程日志" title="进程日志">
          <IconTerminal size={13} />
        </button>
      </div>

      {/* 异常详情 */}
      {phase === 'error' && (
        <div className="error-box" role="alert">
          <div className="error-box__title">{activeSlot ?? '服务'} 异常 · 以下为 stderr 末尾输出</div>
          <pre className="error-box__body mono">{slot?.errorText || '（无错误输出）'}</pre>
        </div>
      )}

      {/* 进程日志抽屉 */}
      {showLogs && slot && <LogDrawer logs={slot.logs} />}

      {/* 主舞台（设备尺寸约束） */}
      <div className="preview__stage">
        {!projectPath ? (
          <EmptyState
            icon={<IconFolder size={22} />}
            title="尚未打开项目"
            text="选择一个本地目录后，即可在这里编译并预览应用。"
            action={
              <button className="btn btn--primary" onClick={() => void openProjectDialog()}>
                <IconFolder size={14} /> 打开项目
              </button>
            }
          />
        ) : showIframe ? (
          <div
            className={`preview__frame-wrap ${constrained ? 'preview__frame-wrap--constrained' : ''}`}
            style={constrained ? { maxWidth: activeDevice.width! } : undefined}
          >
            <iframe
              key={iframeNonce}
              className="preview__frame"
              src={url}
              title="应用预览"
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
            />
          </div>
        ) : !slot || phase === 'idle' ? (
          <EmptyState
            icon={<IconPlay size={22} />}
            title="待启动"
            text="点击「启动」，由 AI 探测项目技术栈并为每个服务命名、逐个启动（支持多服务并行跟踪）。"
            action={
              <button className="btn btn--primary" onClick={aiStart}>
                <IconPlay size={14} /> 启动
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={<IconTerminal size={22} />}
            title={phase === 'error' ? '进程异常，已停止加载预览' : '正在准备预览…'}
            text={phase === 'error' ? '请查看上方错误详情，修复后重新启动。' : `等待「${activeSlot}」的服务地址出现（也可手动填写预览地址）。`}
          />
        )}
      </div>
    </div>
  )
}

function LogDrawer({ logs }: { logs: { stream: 'stdout' | 'stderr'; line: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div className="logdrawer" ref={ref}>
      {logs.length === 0 && <div className="logdrawer__empty">暂无输出</div>}
      {logs.map((l, i) => (
        <div key={i} className={`logdrawer__line logdrawer__line--${l.stream}`}>
          <span className="logdrawer__prefix">{l.stream === 'stderr' ? 'err' : 'out'}</span>
          {l.line}
        </div>
      ))}
    </div>
  )
}

function EmptyState({ icon, title, text, action }: {
  icon: React.ReactNode
  title: string
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="emptystate">
      <div className="emptystate__icon">{icon}</div>
      <div className="emptystate__title">{title}</div>
      <div className="emptystate__text">{text}</div>
      {action}
    </div>
  )
}
