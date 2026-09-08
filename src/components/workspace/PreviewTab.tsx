import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useStartupStore } from '@/store/useStartupStore'
import { useBuildStore, selectSlotState, selectCurrentBuild } from '@/store/useBuildStore'
import { useChatStore, selectCurrentChat } from '@/store/useChatStore'
import { api, onPreviewConsole, previewSetUrl, previewBounds, previewReload, previewDevtools } from '@/services/desktop'
import { BuildPipeline } from './BuildPipeline'
import { Select } from '@/components/common/Select'
import type { PreviewConsoleEntry } from '@/types'
import { IconPlay, IconPlus, IconStop, IconRefresh, IconTerminal, IconLink, IconFolder, IconTarget, IconDesktop, IconTablet, IconMobile, IconExternal, IconClose, IconTrash, IconPencil } from '@/components/common/icons'
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

/** 服务列表合并视图的一行 */
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
  const setCreateProjectOpen = useAppStore((s) => s.setCreateProjectOpen)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const showAlert = useAppStore((s) => s.showAlert)
  const startupCommands = useStartupStore((s) => s.startupCommands)

  const build = useBuildStore(selectCurrentBuild)
  const { slots, slotOrder, activeSlot } = build
  const selectSlot = useBuildStore((s) => s.selectSlot)
  const start = useBuildStore((s) => s.start)
  const stop = useBuildStore((s) => s.stop)
  const removeSlot = useBuildStore((s) => s.removeSlot)
  const stopAll = useBuildStore((s) => s.stopAll)
  const activeTab = useAppStore((s) => s.activeTab)
  const selectUrl = useBuildStore((s) => s.selectUrl)
  const slot = useBuildStore((s) => selectSlotState(s, selectCurrentBuild(s).activeSlot))

  const chat = useChatStore(selectCurrentChat)
  const chatStatus = chat.status
  const chatMessages = chat.messages

  /** 当前查看日志的服务节点 */
  const [logSlot, setLogSlot] = useState<string | null>(null)
  const logSt = logSlot ? slots[logSlot] : undefined
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop')
  const placeholderRef = useRef<HTMLDivElement>(null)

  // 命令行内编辑状态
  const [editingCmd, setEditingCmd] = useState<string | null>(null)
  const [editingCmdValue, setEditingCmdValue] = useState('')
  const cmdSavedRef = useRef(false) // Enter/Escape 已保存时跳过 onBlur 重复写入
  const updateStartCommand = useStartupStore((s) => s.updateStartCommand)
  const deleteStartCommand = useStartupStore((s) => s.deleteStartCommand)
  const showConfirm = useAppStore((s) => s.showConfirm)
  // 手动添加服务
  const [addingService, setAddingService] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCmd, setAddCmd] = useState('')
  /** 提交手动添加服务（Enter 和按钮共用） */
  const submitAddService = (): void => {
    const n = addName.trim()
    const c = addCmd.trim()
    if (n && c && projectPath) {
      void updateStartCommand(n, { run: c }, projectPath)
      setAddingService(false)
      setAddName('')
      setAddCmd('')
    }
  }

  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleLines, setConsoleLines] = useState<PreviewConsoleEntry[]>([])
  const consoleBodyRef = useRef<HTMLDivElement>(null)
  // 端口占用者（EADDRINUSE 时的可视化）
  const [portInfo, setPortInfo] = useState<{ pid: number; name: string; port: number } | null>(null)
  // 预览报错→lesson 采集（噪音控制：同消息30s去重、每预览会话最多3条）
  const recentErrorsRef = useRef<Map<string, number>>(new Map())
  const errorCountRef = useRef(0)

  const previewUrl = slot?.detectedUrl || ''

  useEffect(() => {
    const off = onPreviewConsole((entry) => {
      setConsoleLines((lines) => {
        const next = [...lines, entry]
        return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next
      })
      // 预览报错→lesson（噪音控制：error 级别 + 同消息30s去重 + 每预览会话最多3条）
      if (entry.level === 'error' && errorCountRef.current < 3) {
        const now = Date.now()
        const key = entry.message.slice(0, 100)
        const last = recentErrorsRef.current.get(key) ?? 0
        if (now - last > 30_000) {
          recentErrorsRef.current.set(key, now)
          errorCountRef.current++
          const project = useAppStore.getState().projectPath
          const session = useChatStore.getState().current ? useChatStore.getState().byProject[useChatStore.getState().current!]?.sessionId : undefined
          if (project && session) {
            void api.noteLesson(project, session, {
              title: `预览报错：${key.slice(0, 60)}`,
              content: `level=${entry.level}\nsource=${entry.sourceId}\n${entry.message}`.slice(0, 2000),
            }).catch(() => {})
          }
        }
      }
    })
    // 预览地址切换时重置噪音计数
    recentErrorsRef.current.clear()
    errorCountRef.current = 0
    return off
  }, [previewUrl])

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

  // 预览视图门控：仅在 running 且有地址时创建 WebContentsView；building 期主动销毁残留。
  // 原先只依赖 previewUrl，但 previewUrl 在 slot 创建时即为 AI 上报的 seed（非空），
  // 导致 building 期就 loadURL——服务器尚未监听 → 连接拒绝 → 空白；且 phase 转 running
  // 后 previewUrl 不变、effect 不重跑，不会重试 loadURL。
  useEffect(() => {
    void previewSetUrl(showIframe ? previewUrl : '')
  }, [showIframe, previewUrl])

  // placeholder 坐标同步（ResizeObserver + window resize → 主进程 setBounds）。
  // isActive 守卫：WebContentsView 是原生层，Tab 切换只是 CSS 隐藏 DOM 藏不住它——
  // 非激活 Tab 时必须把 bounds 清零（零面积=不可见），切回时重报真实坐标。
  useEffect(() => {
    if (!showIframe || activeTab !== 'preview') {
      void previewBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    const el = placeholderRef.current
    if (!el) return
    let raf = 0
    const report = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        void previewBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
      })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', report) }
  }, [showIframe, deviceMode, activeTab])

  const chatBusy = chatStatus !== 'idle' && chatStatus !== 'error'
  const compiling = useMemo(() => {
    if (!chatBusy) return false
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') return chatMessages[i].meta?.projectStart === true
    }
    return false
  }, [chatBusy, chatMessages])
  const hasCommands = startupCommands.length > 0

  /** 服务列表合并视图 */
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
        // 未运行时优先取存档命令（AI/用户更新后立即反映）；运行中用 slot 实际命令
        command: (st?.processAlive ? st.command : null) || archived?.run || st?.command || '',
        archived: !!archived,
        slot: st,
      }
    })
  })()

  /** AI 编译：调模型探测技术栈 + 识别启动命令并存档。已识别过时需用户确认覆盖 */
  const aiCompile = async () => {
    if (!projectPath) return
    const cliMode = useAppStore.getState().settings.dispatchMode === 'claude-cli'
    if (!hasApiKey && !cliMode) {
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
    const chat = selectCurrentChat(useChatStore.getState())
    if (chat.status !== 'idle' && chat.status !== 'error') {
      void showAlert('AI 正忙', '上一条消息还在处理中，请稍候，或点击「停止生成」后重试。')
      return
    }
    // AI 编译规则与主系统提示（services/ai.ts buildSystemPrompt）同源对齐：CLI 无 verify_start/
    // report_start_commands 工具，走 [[START_COMMANDS]] 尾行协议（与 ai-cli.ts 提取正则配对）。
    // url 字段：AI 读过代码/输出，知道本地预览地址（含端口）时必须上报——这是预览地址的第一来源
    const prompt = cliMode
      ? '这是 AI 编译阶段：请探测当前项目的技术栈，需要时安装依赖 / 验证编译，' +
        '然后为每个需要长期运行的服务取一个简短英文服务名（各不重复），' +
        '逐个验证启动命令能真正启动（验证通过即停止进程，不要把服务留在后台运行），' +
        '全部通过后在回复最后一行用 [[START_COMMANDS: [{"name":"portal","run":"npm run dev","url":"http://localhost:5173"}]]] 格式提交（紧凑单行 JSON；url 为该服务的本地预览地址含端口，能从代码或启动输出确定就必填，只有 name 和 run 也可以）。该行由系统消费、不会展示给用户。提交后即完成，运行由我来决定。'
      : '这是 AI 编译阶段：请探测当前项目的技术栈，需要时用 run_once 安装依赖 / 验证编译，' +
        '然后为每个需要长期运行的服务取一个简短英文服务名（各不重复），' +
        '逐个用 verify_start 验证启动命令能真正启动（验证通过会自动停止进程），' +
        '全部通过后用 report_start_commands 提交启动命令清单，能确定的服务附上本地预览地址 url（含端口）。提交后即完成，不要直接 run_project 启动服务——运行由我来决定。'
    void useChatStore.getState().send(prompt, { projectStart: true })
  }

  /** 工具链缺失：用户点「授权 AI 自动安装」即视为授权，AI 直接安装后重启服务 */
  const requestToolchainInstall = () => {
    if (!slot) return
    const chat = selectCurrentChat(useChatStore.getState())
    if (chat.status !== 'idle' && chat.status !== 'error') {
      void showAlert('AI 正忙', '请等待当前任务完成，或点击「停止生成」后再试。')
      return
    }
    void useChatStore.getState().send(
      `启动服务「${slot.name}」失败：${slot.errorText}` +
      ' 我已授权你自动安装缺失的工具链：请安装缺失的命令（Windows 用 winget install --id <包ID> --silent --accept-package-agreements --accept-source-agreements，macOS 用 brew install，Linux 用发行版包管理器），' +
      `安装完成后先用 run_once 验证工具可用，再用原命令重新启动服务「${slot.name}」，并用 get_build_status 确认进入运行中状态。`,
    )
  }

  /** 指令运行：直接执行存档的启动命令（零模型调用）；已存活的服务跳过。
   *  命令存档里带预览地址（AI 编译上报的 url）时作为初始检测地址传入 */
  const runAll = async () => {
    if (!projectPath || !hasCommands) return
    const bs = useBuildStore.getState()
    for (const c of startupCommands) {
      const st = bs.byProject[projectPath]?.slots[c.name.toLowerCase()]
      if (st?.processAlive) continue
      await bs.start(c.name, c.run, projectPath, c.url)
    }
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
        <button className="btn btn--danger-ghost btn--sm" disabled={!anyAlive} onClick={() => void stopAll(projectPath ?? undefined)} title="停止全部服务进程">
          <IconStop size={12} /> 全部停止
        </button>
        <span className="preview__hint">
          {hasCommands
            ? `已识别 ${startupCommands.length} 个服务，点「全部运行」直接启动`
            : '先「AI 编译」识别启动命令，之后「全部运行」不再调用 AI'}
        </span>
        <div className="preview__spacer" />
      </div>

      {/* 服务列表 */}
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
                  {editingCmd === key ? (
                    <input
                      className="slots__cmd-input mono"
                      value={editingCmdValue}
                      onChange={(e) => setEditingCmdValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const val = editingCmdValue.trim()
                          if (val && val !== row.command && projectPath) void updateStartCommand(row.name, { run: val }, projectPath)
                          cmdSavedRef.current = true
                          setEditingCmd(null)
                        } else if (e.key === 'Escape') {
                          cmdSavedRef.current = true
                          setEditingCmd(null)
                        }
                      }}
                      onBlur={() => {
                        // Enter/Escape 已 setEditingCmd(null) 触发 unmount → onBlur；
                        // 用 cmdSavedRef 防止重复写入
                        if (cmdSavedRef.current) return
                        const val = editingCmdValue.trim()
                        if (val && val !== row.command && projectPath) void updateStartCommand(row.name, { run: val }, projectPath)
                        setEditingCmd(null)
                      }}
                      autoFocus
                    />
                  ) : (
                    <span className="slots__cmd mono" title={row.command || '（未知命令）'}>{row.command || '（未知命令）'}</span>
                  )}
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
                  <span key={st?.phase ?? 'idle'} className={`slots__phase slots__phase--${st?.phase ?? 'idle'}`}>
                    {PHASE_LABEL[st?.phase ?? 'idle']}
                  </span>
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
                    <button className="btn btn--ghost btn--sm slots__action" onClick={(e) => { e.stopPropagation(); void stop(row.name, projectPath ?? undefined) }}>
                      停止
                    </button>
                  ) : (
                    <button
                      className="btn btn--ghost btn--sm slots__action"
                      disabled={!row.command || !projectPath}
                      onClick={(e) => { e.stopPropagation(); void start(row.name, row.command, projectPath ?? undefined) }}
                      title={`以原命令运行「${row.name}」`}
                    >
                      运行
                    </button>
                  )}
                  {!alive && (
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        cmdSavedRef.current = false
                        setEditingCmd(key)
                        setEditingCmdValue(row.command)
                      }}
                      aria-label="编辑命令"
                      title="编辑启动命令"
                    >
                      <IconPencil size={12} />
                    </button>
                  )}
                  {!alive && (
                    <button
                      className="icon-btn"
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!projectPath) return
                        // 严格判断（showConfirm 可能返回对象，truthy 判断会误放行）
                        if (await showConfirm('删除服务', `确认删除「${row.name}」？将同时移除启动命令存档与运行记录，删除后需重新 AI 编译或手动添加。`) !== true) return
                        removeSlot(row.name, projectPath)
                        void deleteStartCommand(row.name, projectPath)
                      }}
                      aria-label="删除服务"
                      title="删除此服务（含命令存档与运行记录）"
                    >
                      <IconTrash size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {/* 手动添加服务 */}
          {addingService ? (
            <div className="slots__add-form">
              <input
                className="slots__add-input mono"
                placeholder="服务名"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setAddingService(false) }}
                autoFocus
              />
              <input
                className="slots__add-input slots__add-input--cmd mono"
                placeholder="启动命令（如 npm run dev）"
                value={addCmd}
                onChange={(e) => setAddCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    submitAddService()
                  } else if (e.key === 'Escape') {
                    setAddingService(false)
                  }
                }}
              />
              <button
                className="btn btn--ghost btn--sm"
                disabled={!addName.trim() || !addCmd.trim()}
                onClick={submitAddService}
              >
                添加
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setAddingService(false)}>取消</button>
            </div>
          ) : (
            <button className="btn btn--ghost btn--sm slots__add-btn" onClick={() => setAddingService(true)}>
              <IconPlus size={12} /> 添加服务
            </button>
          )}
        </>
      )}

      {/* 节点日志台 */}
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
        <button
          className="icon-btn"
          disabled={!showIframe}
          onClick={() => void previewReload()}
          aria-label="刷新预览"
          title="清缓存并刷新预览"
        >
          <IconRefresh size={13} />
        </button>
        <button className="icon-btn" disabled={!showIframe} onClick={() => void previewDevtools()} aria-label="DevTools" title="打开预览页 DevTools">
          <IconTerminal size={13} />
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
          <div className="error-box__actions">
            <button
              className="btn btn--primary btn--sm"
              disabled={chatBusy || !slot?.errorText}
              onClick={() => {
                const chat = selectCurrentChat(useChatStore.getState())
                if (chat.status !== 'idle' && chat.status !== 'error') return
                // 命令更新通道按调度模式分支：API 模式走 update_start_command 工具；
                // CLI 模式无此工具，走 [[START_COMMANDS]] 尾行协议（ai-cli.ts 提取后自动存档，
                // 全量替换语义——需提交完整清单，含未变更的其他服务）
                const cliMode = useAppStore.getState().settings.dispatchMode === 'claude-cli'
                const fixHint = cliMode
                  ? ' 诊断后如果需要修改启动命令，在回复最后一行用 [[START_COMMANDS: [{"name":"portal","run":"npm run dev"}]]] 格式提交修正后的完整启动命令清单（紧凑单行 JSON；必须包含所有服务，未变更的原样带上；该行由系统存档、不会展示给用户）。'
                  : ' 诊断后如果需要修改启动命令（路径不对、端口冲突、缺少子目录等），必须调用 update_start_command 更新该服务的启动命令，否则下次运行仍会失败。'
                void useChatStore.getState().send(
                  `启动服务「${slot!.name}」失败，当前启动命令为：\n\`\`\`\n${slot!.command}\n\`\`\`\n报错信息如下：\n\`\`\`\n${slot!.errorText}\n\`\`\`\n请诊断原因并修复。` +
                  fixHint,
                )
              }}
            >
              发给 AI 修复
            </button>
            {slot?.errorText.includes('未找到命令') && (
              <button className="btn btn--ghost btn--sm" onClick={requestToolchainInstall}>
                授权 AI 自动安装
              </button>
            )}
            <span className="error-box__hint">将错误信息发到对话，由 AI 诊断并修复</span>
          </div>
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
            text="创建一个新项目，或选择一个本地目录后，即可在这里编译并预览应用。"
            action={
              <div className="btn-row">
                <button className="btn btn--primary" onClick={() => setCreateProjectOpen(true)}>
                  <IconPlus size={14} /> 创建项目
                </button>
                <button className="btn btn--ghost" onClick={() => void openProjectDialog()}>
                  <IconFolder size={14} /> 打开项目
                </button>
              </div>
            }
          />
        ) : showIframe ? (
          <div
            ref={placeholderRef}
            className={`preview__frame-wrap ${constrained ? 'preview__frame-wrap--constrained' : ''}`}
            style={constrained ? { maxWidth: activeDevice.width! } : undefined}
          >
            {/* WebContentsView 由主进程叠在此 div 上方，bounds 由 ResizeObserver 同步 */}
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
