import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useBuildStore, selectSlotState } from '@/store/useBuildStore'
import { useChatStore } from '@/store/useChatStore'
import { api, onPreviewConsole } from '@/services/desktop'
import { BuildPipeline } from './BuildPipeline'
import { Select } from '@/components/common/Select'
import type { PreviewConsoleEntry } from '@/types'
import { IconPlay, IconStop, IconRefresh, IconTerminal, IconLink, IconFolder, IconTarget, IconDesktop, IconTablet, IconMobile, IconExternal, IconClose, IconTrash } from '@/components/common/icons'
import { EmptyState } from '@/components/common/EmptyState'

const PHASE_LABEL: Record<string, string> = {
  idle: '未运行', building: '编译中', deploying: '部署中', running: '运行中', error: '异常',
}

/** 控制台日志最大保留行数 */
const MAX_CONSOLE_LINES = 500

type DeviceMode = 'desktop' | 'tablet' | 'mobile'

const DEVICES: { mode: DeviceMode; label: string; width: number | null; Icon: typeof IconDesktop }[] = [
  { mode: 'desktop', label: '桌面', width: null, Icon: IconDesktop },
  { mode: 'tablet', label: '平板 (768px)', width: 768, Icon: IconTablet },
  { mode: 'mobile', label: '手机 (375px)', width: 375, Icon: IconMobile },
]

/** 服务列表合并视图的一行：存档命令（AI 编译产出）∪ 存活槽（chat 里 run_project 的） */
interface ServiceRow {
  name: string
  /** 展示用的命令：运行时以实际槽为准，未启动时显示存档命令 */
  command: string
  archived: boolean
  slot: ReturnType<typeof selectSlotState>
}

/** 预览 Tab：AI 编译（识别启动命令）+ 一键全部运行 + 服务列表 + 节点日志台 + 状态流水线 + 预览 iframe。 */
export function PreviewTab() {
  const projectPath = useAppStore((s) => s.projectPath)
  const openProjectDialog = useAppStore((s) => s.openProjectDialog)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const showAlert = useAppStore((s) => s.showAlert)
  const startupCommands = useAppStore((s) => s.startupCommands)

  const slots = useBuildStore((s) => s.slots)
  const slotOrder = useBuildStore((s) => s.slotOrder)
  const activeSlot = useBuildStore((s) => s.activeSlot)
  const selectSlot = useBuildStore((s) => s.selectSlot)
  const start = useBuildStore((s) => s.start)
  const stop = useBuildStore((s) => s.stop)
  const stopAll = useBuildStore((s) => s.stopAll)
  const selectUrl = useBuildStore((s) => s.selectUrl)
  const slot = useBuildStore((s) => selectSlotState(s, s.activeSlot))

  const chatStatus = useChatStore((s) => s.status)
  const chatMessages = useChatStore((s) => s.messages)

  /** 当前查看日志的服务节点（key=槽名）：单一日志台展示，避免列表内展开造成多层滚动 */
  const [logSlot, setLogSlot] = useState<string | null>(null)
  const logSt = logSlot ? slots[logSlot] : undefined
  const [iframeNonce, setIframeNonce] = useState(0)
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop')

  // 预览控制台：被预览页面的 console 输出（主进程按 origin 过滤后转发）
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleLines, setConsoleLines] = useState<PreviewConsoleEntry[]>([])
  const consoleBodyRef = useRef<HTMLDivElement>(null)
  // 端口占用者（EADDRINUSE 时的可视化）
  const [portInfo, setPortInfo] = useState<{ pid: number; name: string; port: number } | null>(null)

  // 预览地址变化 → 更新主进程的采集过滤 origin（变更时主进程清空缓冲）
  const previewUrl = slot?.detectedUrl || ''
  useEffect(() => {
    void api.previewConsoleAttach(previewUrl || null).catch(() => {})
  }, [previewUrl])

  useEffect(() => {
    const off = onPreviewConsole((entry) => {
      setConsoleLines((lines) => {
        const next = [...lines, entry]
        return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next
      })
    })
    return off
  }, [])

  // 打开面板时拉取主进程缓冲的历史
  useEffect(() => {
    if (consoleOpen) void api.previewConsoleHistory().then(setConsoleLines).catch(() => {})
  }, [consoleOpen])

  useEffect(() => {
    const el = consoleBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [consoleLines, consoleOpen])

  // 异常输出含端口占用时，查出占用者展示（EADDRINUSE 行里的最后一个端口号）
  useEffect(() => {
    const text = slot?.phase === 'error' ? slot?.errorText ?? '' : ''
    const line = text.split('\n').find((l) => /EADDRINUSE|already in use/i.test(l))
    const port = line ? [...line.matchAll(/:(\d{2,5})\b/g)].map((m) => Number(m[1])).pop() ?? null : null
    if (!port) {
      setPortInfo(null)
      return
    }
    let cancelled = false
    void api.portOwner(port)
      .then((owner) => { if (!cancelled) setPortInfo(owner ? { ...owner, port } : null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [slot?.phase, slot?.errorText])

  const phase = slot?.phase ?? 'idle'
  const url = slot?.detectedUrl || ''
  const anyAlive = slotOrder.some((k) => slots[k]?.processAlive)
  const showIframe = phase === 'running' && url !== ''
  const activeDevice = DEVICES.find((d) => d.mode === deviceMode) ?? DEVICES[0]
  const constrained = activeDevice.width !== null

  const chatBusy = chatStatus !== 'idle' && chatStatus !== 'error'
  // 最近一条用户消息是否为 AI 编译（用于把「AI 编译」按钮置为进行中文案）
  const compiling = (() => {
    if (!chatBusy) return false
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') return chatMessages[i].meta?.projectStart === true
    }
    return false
  })()
  const hasCommands = startupCommands.length > 0

  /** 服务列表合并视图：存档命令在前列出（未启动也显示，供核对数量与命令），存活槽补在后面 */
  const serviceRows: ServiceRow[] = (() => {
    const names: string[] = []
    const push = (n: string): void => { if (!names.includes(n)) names.push(n) }
    startupCommands.forEach((c) => push(c.name))
    slotOrder.forEach((k) => push(k))
    return names.map((name) => {
      const archived = startupCommands.find((c) => c.name === name)
      const st = slots[name.toLowerCase()]
      return {
        name,
        command: st?.command || archived?.run || '',
        archived: !!archived,
        slot: st,
      }
    })
  })()

  /** AI 编译：调模型探测技术栈 + 识别启动命令并存档。已识别过时需用户确认覆盖 */
  const aiCompile = async () => {
    if (!projectPath) return
    if (!hasApiKey) {
      void showAlert('尚未配置 API Key', '点击右上角对话栏的齿轮图标，配置 Base URL 与 API Key 后即可使用 AI 编译。')
      return
    }
    if (hasCommands) {
      const confirmed = await useAppStore.getState().showConfirm(
        'AI 重新编译',
        '将重新调用 AI 识别启动命令（可能重新安装依赖），已识别的命令会被覆盖。继续？',
      )
      if (confirmed !== true) return
    }
    const chat = useChatStore.getState()
    if (chat.status !== 'idle' && chat.status !== 'error') {
      void showAlert('AI 正忙', '上一条消息还在处理中，请稍候，或点击「停止生成」后重试。')
      return
    }
    void chat.send(
      '这是 AI 编译阶段：请探测当前项目的技术栈，需要时用 run_once 安装依赖 / 验证编译，' +
      '然后为每个需要长期运行的服务取一个简短英文服务名（各不重复），' +
      '逐个用 verify_start 验证启动命令能真正启动（验证通过会自动停止服务），' +
      '全部通过后用 report_start_commands 提交启动命令清单。不要直接 run_project 启动服务，运行由我来决定。',
      { projectStart: true },
    )
  }

  /** 工具链缺失：用户点「授权 AI 自动安装」即视为授权，AI 直接安装后重启服务 */
  const requestToolchainInstall = () => {
    if (!slot) return
    const chat = useChatStore.getState()
    if (chat.status !== 'idle' && chat.status !== 'error') {
      void showAlert('AI 正忙', '请等待当前任务完成，或点击「停止生成」后再试。')
      return
    }
    void chat.send(
      `启动服务「${slot.name}」失败：${slot.errorText}` +
      ' 我已授权你自动安装缺失的工具链：请安装缺失的命令（Windows 优先用 winget，注意加非交互参数），' +
      `安装完成后用原命令重新启动服务「${slot.name}」，并用 get_build_status 确认进入运行中状态。`,
    )
  }

  /** 指令运行：直接执行存档的启动命令（零模型调用）；已存活的服务跳过 */
  const runAll = async () => {
    if (!projectPath || !hasCommands) return
    const bs = useBuildStore.getState()
    for (const c of startupCommands) {
      const st = bs.slots[c.name.toLowerCase()]
      if (st?.processAlive) continue
      await bs.start(c.name, c.run)
    }
  }

  const startPick = () => {
    if (!url) return
    void api.startElementPick(url)
  }

  return (
    <div className="preview">
      {/* 启动工具栏：AI 编译（调模型）与 运行（零模型）两个独立操作 */}
      <div className="preview__bar">
        <button
          className="btn btn--ghost btn--sm"
          disabled={!projectPath || chatBusy}
          onClick={() => void aiCompile()}
          title={hasCommands ? '重新调用 AI 识别启动命令（会覆盖现有命令）' : '由 AI 探测技术栈、装依赖并识别启动命令'}
        >
          {compiling ? 'AI 编译中…' : 'AI 编译'}
        </button>
        <button
          className="btn btn--primary btn--sm"
          disabled={!projectPath || !hasCommands}
          onClick={() => void runAll()}
          title={hasCommands ? '直接运行已识别的全部启动命令（不调用 AI）' : '请先点击「AI 编译」识别启动命令'}
        >
          <IconPlay size={12} /> 全部运行
        </button>
        {/* 全部停止紧邻「全部运行」：启停是成对高频操作，弹到最右要跨整条工具栏找 */}
        <button className="btn btn--danger-ghost btn--sm" disabled={!anyAlive} onClick={() => void stopAll()} title="停止全部服务进程">
          <IconStop size={12} /> 全部停止
        </button>
        <span className="preview__hint">
          {hasCommands
            ? `已识别 ${startupCommands.length} 个服务，点「全部运行」直接启动`
            : '先「AI 编译」识别启动命令，之后「全部运行」不再调用 AI'}
        </span>
        <div className="preview__spacer" />
      </div>

      {/* 服务列表：存档命令 ∪ 存活槽（核对可运行系统数量与命令） */}
      {serviceRows.length > 0 && (
        <>
          <div className="slots__count">共 {serviceRows.length} 个服务</div>
          <div className="slots" role="list" aria-label="服务列表">
            {serviceRows.map((row) => {
              const st = row.slot
              const alive = st?.processAlive ?? false
              const running = st?.phase === 'running' && !!st.detectedUrl
              const key = st?.name ?? row.name.toLowerCase()
              const logOn = logSlot === key
              return (
                <div
                  key={key}
                  role="listitem"
                  className={`slots__row ${key === activeSlot ? 'slots__row--active' : ''}`}
                  onClick={() => selectSlot(row.name)}
                >
                  <span className={`status-dot status-dot--${st?.phase ?? 'idle'}`} />
                  <span className="slots__name mono" title={row.name}>{row.name}</span>
                  <span className="slots__cmd mono" title={row.command}>{row.command || '（未知命令）'}</span>
                  {running && (
                    <a
                      className="slots__url mono"
                      href={st!.detectedUrl!}
                      target="_blank"
                      rel="noreferrer"
                      title={`在浏览器中打开 ${st!.detectedUrl}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {st!.detectedUrl}
                    </a>
                  )}
                  {/* key 含 phase：徽标状态变化时重挂，badge-in 淡入重放 */}
                  <span key={st?.phase ?? 'idle'} className={`slots__phase slots__phase--${st?.phase ?? 'idle'}`}>
                    {PHASE_LABEL[st?.phase ?? 'idle']}
                  </span>
                  {/* 日志按钮挂进程节点：展示收敛到列表下方的单一日志台 */}
                  {st && (
                    <button
                      className={`btn btn--ghost btn--sm slots__action ${logOn ? 'slots__action--on' : ''}`}
                      onClick={(e) => { e.stopPropagation(); selectSlot(key); setLogSlot((cur) => (cur === key ? null : key)) }}
                      aria-expanded={logOn}
                      aria-label={`${key} 进程日志`}
                      title="进程日志"
                    >
                      <IconTerminal size={12} /> 日志
                    </button>
                  )}
                  {alive ? (
                    <button className="btn btn--ghost btn--sm slots__action" onClick={(e) => { e.stopPropagation(); void stop(row.name) }}>
                      停止
                    </button>
                  ) : (
                    <button
                      className="btn btn--ghost btn--sm slots__action"
                      disabled={!row.command}
                      onClick={(e) => { e.stopPropagation(); void start(row.name, row.command) }}
                      title={`以原命令运行「${row.name}」`}
                    >
                      运行
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* 节点日志台：服务列表下方单一面板，滚动只有一层；按钮在对应节点行上 */}
      {logSlot && logSt && (
        <div className="consolepane">
          <div className="consolepane__head">
            <span className="consolepane__name mono" title={logSlot}>{logSlot}</span>
            <span className={`slots__phase slots__phase--${logSt.phase}`}>
              {PHASE_LABEL[logSt.phase]}
            </span>
            <span className="consolepane__meta">{logSt.logs.length} 行</span>
            <div className="preview__spacer" />
            <button className="icon-btn" onClick={() => setLogSlot(null)} aria-label="关闭日志" title="关闭日志">
              <IconClose size={12} />
            </button>
          </div>
          <div className="consolepane__body">
            <LogDrawer logs={logSt.logs} />
          </div>
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
              <div className="preview__url-switch">
                <Select
                  size="sm"
                  value={slot.detectedUrl}
                  onChange={(u) => selectUrl(slot.name, u)}
                  options={slot.detectedUrls.map((u) => ({ value: u, label: u }))}
                  ariaLabel="切换服务地址"
                />
              </div>
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
        <button
          className="icon-btn"
          onClick={() => void api.openExternal(url)}
          disabled={!url}
          aria-label="系统浏览器打开"
          title="在系统默认浏览器中打开当前地址"
        >
          <IconExternal size={13} />
        </button>
        <button className="icon-btn" onClick={startPick} disabled={!showIframe} aria-label="选取元素" title="选取预览页元素，带入 AI 对话">
          <IconTarget size={13} />
        </button>
        <button className="icon-btn" onClick={() => setIframeNonce((n) => n + 1)} disabled={!showIframe} aria-label="刷新预览" title="刷新预览">
          <IconRefresh size={13} />
        </button>
        <button
          className={`icon-btn ${consoleOpen ? 'icon-btn--active' : ''}`}
          onClick={() => setConsoleOpen((v) => !v)}
          disabled={!showIframe}
          aria-label="页面控制台"
          title="页面控制台（console 输出）"
        >
          <IconTerminal size={13} />
        </button>
      </div>

      {/* 进程日志：已迁移到服务节点的「日志」按钮，不再有全局抽屉 */}

      {/* 异常详情 */}
      {phase === 'error' && (
        <div className="error-box" role="alert">
          <div className="error-box__title">{activeSlot ?? '服务'} 异常 · 以下为 stderr 末尾输出</div>
          <pre className="error-box__body mono">{slot?.errorText || '（无错误输出）'}</pre>
          {portInfo && (
            <div className="error-box__port mono">
              端口 {portInfo.port} 正被 {portInfo.name}（PID {portInfo.pid}）监听——可「全部停止」后重试，或在对话中让 AI 换端口
            </div>
          )}
          {/* 工具链缺失（启动预检报「未找到命令」）：一键授权 AI 安装，不用用户自己装 */}
          {slot?.errorText.includes('未找到命令') && (
            <div className="error-box__actions">
              <button className="btn btn--ghost btn--sm" onClick={requestToolchainInstall}>
                授权 AI 自动安装
              </button>
              <span className="error-box__hint">点击后 AI 会安装缺失工具并重启该服务</span>
            </div>
          )}
        </div>
      )}

      {/* 页面控制台：被预览页面的 console 输出（#14） */}
      {consoleOpen && (
        <div className="consolepane">
          <div className="consolepane__head">
            <span className="consolepane__name">控制台</span>
            <span className="consolepane__meta mono">{(() => { try { return new URL(previewUrl).host } catch { return '' } })()}</span>
            <span className="consolepane__meta">{consoleLines.length} 条</span>
            <div className="preview__spacer" />
            <button className="icon-btn" onClick={() => setConsoleLines([])} aria-label="清空显示" title="清空显示">
              <IconTrash size={12} />
            </button>
            <button className="icon-btn" onClick={() => setConsoleOpen(false)} aria-label="关闭控制台" title="关闭控制台">
              <IconClose size={12} />
            </button>
          </div>
          <div className="consolepane__body console-stream" ref={consoleBodyRef}>
            {consoleLines.length === 0 ? (
              <div className="console-stream__empty">暂无输出——页面里的 console.log / error 会显示在这里</div>
            ) : (
              consoleLines.map((l, i) => (
                <div key={i} className={`console-stream__line console-stream__line--${l.level}`}>
                  <span className="console-stream__level">{l.level === 'warning' ? 'warn' : l.level}</span>
                  <span className="console-stream__text">{l.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

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
            text={hasCommands
              ? `已识别 ${startupCommands.length} 个服务的启动命令，点击「全部运行」直接启动（不调用 AI）。`
              : '点击「AI 编译」，由 AI 探测项目技术栈、安装依赖并识别每个服务的启动命令。'}
            action={
              hasCommands ? (
                <button className="btn btn--primary" onClick={() => void runAll()}>
                  <IconPlay size={14} /> 全部运行
                </button>
              ) : (
                <button className="btn btn--primary" disabled={chatBusy} onClick={() => void aiCompile()}>
                  {compiling ? 'AI 编译中…' : 'AI 编译'}
                </button>
              )
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
