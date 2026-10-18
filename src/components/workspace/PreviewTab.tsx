import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useStartupStore } from '@/store/useStartupStore'
import { useBuildStore, selectSlotState, selectCurrentBuild } from '@/store/useBuildStore'
import { useChatStore, selectCurrentChat } from '@/store/useChatStore'
import { api, onPreviewConsole, previewSetUrl, previewBounds, previewReload, previewDevtools } from '@/services/desktop'
import { BuildPipeline } from './BuildPipeline'
import { Select } from '@/components/common/Select'
import type { PreviewConsoleEntry } from '@/types'
import { IconPlay, IconStop, IconRefresh, IconTerminal, IconLink, IconFolder, IconTarget, IconDesktop, IconTablet, IconMobile, IconExternal, IconClose, IconTrash } from '@/components/common/icons'
import { EmptyState } from '@/components/common/EmptyState'
import { DeployTab } from './DeployTab'
import { ServiceList } from './ServiceList'
import { ErrorDetail } from './ErrorDetail'
import { toast } from '@/components/common/Toast'
import { aiCompileAllOpen } from '@/services/ai-compile'

const PHASE_LABEL: Record<string, string> = {
  idle: '未运行', building: '编译中', deploying: '部署中', running: '运行中', error: '异常',
}
const MAX_CONSOLE_LINES = 500

type DeviceMode = 'desktop' | 'tablet' | 'mobile'
const DEVICES: { mode: DeviceMode; label: string; width: number | null; Icon: typeof IconDesktop }[] = [
  { mode: 'desktop', label: '桌面', width: null, Icon: IconDesktop },
  { mode: 'tablet', label: '平板 (768px)', width: 768, Icon: IconTablet },
  { mode: 'mobile', label: '手机 (375px)', width: 375, Icon: IconMobile },
]

/** 服务列表合并视图的一行（供 ServiceList 消费） */
export interface ServiceRow {
  name: string
  command: string
  archived: boolean
  slot: ReturnType<typeof selectSlotState>
}

/** 预览 Tab：AI 编译 + 服务列表 + 日志台 + 预览 iframe */
export function PreviewTab() {
  const projectPath = useAppStore((s) => s.projectPath)
  const openProjectDialog = useAppStore((s) => s.openProjectDialog)
  const setCreateProjectOpen = useAppStore((s) => s.setCreateProjectOpen)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const startupCommands = useStartupStore((s) => s.startupCommands)
  const updateStartCommand = useStartupStore((s) => s.updateStartCommand)
  const deleteStartCommand = useStartupStore((s) => s.deleteStartCommand)

  const build = useBuildStore(selectCurrentBuild)
  const { slots, slotOrder, activeSlot } = build
  const selectSlot = useBuildStore((s) => s.selectSlot)
  const start = useBuildStore((s) => s.start)
  const stop = useBuildStore((s) => s.stop)
  const removeSlot = useBuildStore((s) => s.removeSlot)
  const stopAll = useBuildStore((s) => s.stopAll)
  const activeTab = useAppStore((s) => s.activeTab)
  const memorySidebarOpen = useAppStore((s) => s.memorySidebarOpen)
  const selectUrl = useBuildStore((s) => s.selectUrl)
  const slot = useBuildStore((s) => selectSlotState(s, selectCurrentBuild(s).activeSlot))

  const chat = useChatStore(selectCurrentChat)
  const chatStatus = chat.status

  const [logSlot, setLogSlot] = useState<string | null>(null)
  const logSt = logSlot ? slots[logSlot] : undefined
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop')
  const placeholderRef = useRef<HTMLDivElement>(null)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleLines, setConsoleLines] = useState<PreviewConsoleEntry[]>([])
  const consoleBodyRef = useRef<HTMLDivElement>(null)
  const [portInfo, setPortInfo] = useState<{ pid: number; name: string; port: number } | null>(null)
  const recentErrorsRef = useRef<Map<string, number>>(new Map())
  const errorCountRef = useRef(0)

  /** 手动地址（会话级覆盖）：用户在地址栏回车后生效；切服务时自动清除 */
  const [manualAddr, setManualAddr] = useState<string | null>(null)
  /** 地址栏草稿（未提交）：逐键编辑不驱动预览导航，回车才提交 */
  const [draftAddr, setDraftAddr] = useState<string | null>(null)

  const previewUrl = manualAddr ?? (slot?.detectedUrl || '')

  // 预览报错 → lesson 采集（噪音控制：同消息 30s 去重、每预览会话最多 3 条）
  useEffect(() => {
    const off = onPreviewConsole((entry) => {
      setConsoleLines((lines) => {
        const next = [...lines, entry]
        return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next
      })
      if (entry.level === 'error' && errorCountRef.current < 3) {
        const now = Date.now()
        const key = entry.message.slice(0, 100)
        const last = recentErrorsRef.current.get(key) ?? 0
        if (now - last > 30_000) {
          recentErrorsRef.current.set(key, now)
          errorCountRef.current++
          const project = useAppStore.getState().projectPath
          const session = useChatStore.getState().current ? useChatStore.getState().byProject[useChatStore.getState().current!]?.sessionId : undefined
          if (project && session) void api.noteLesson(project, session, { title: `预览报错：${key.slice(0, 60)}`, content: `level=${entry.level}\nsource=${entry.sourceId}\n${entry.message}`.slice(0, 2000) }).catch(() => {})
        }
      }
    })
    recentErrorsRef.current.clear()
    errorCountRef.current = 0
    return off
  }, [previewUrl, slot?.processAlive])

  useEffect(() => { if (consoleOpen) void api.previewConsoleHistory().then(setConsoleLines).catch(() => {}) }, [consoleOpen])
  useEffect(() => { const el = consoleBodyRef.current; if (el) el.scrollTop = el.scrollHeight }, [consoleLines, consoleOpen])

  // 端口占用检测（EADDRINUSE）
  useEffect(() => {
    const text = slot?.phase === 'error' ? slot?.errorText ?? '' : ''
    const line = text.split('\n').find((l) => /EADDRINUSE|already in use/i.test(l))
    const port = line ? [...line.matchAll(/:(\d{2,5})\b/g)].map((m) => Number(m[1])).pop() ?? null : null
    if (!port) { setPortInfo(null); return }
    let cancelled = false
    void api.portOwner(port).then((owner) => { if (!cancelled) setPortInfo(owner ? { ...owner, port } : null) }).catch(() => {})
    return () => { cancelled = true }
  }, [slot?.phase, slot?.errorText])

  const phase = slot?.phase ?? 'idle'
  const url = slot?.detectedUrl || ''
  const anyAlive = slotOrder.some((k) => slots[k]?.processAlive)
  // 手动地址也算「预览中」：嵌入浏览器支持不依赖服务的任意导航（用户诉求：手动请求某个页面）
  const showIframe = (phase === 'running' && url !== '') || manualAddr !== null
  const activeDevice = DEVICES.find((d) => d.mode === deviceMode) ?? DEVICES[0]
  const constrained = activeDevice.width !== null

  useEffect(() => { void previewSetUrl(showIframe ? previewUrl : '') }, [showIframe, previewUrl])

  // 切服务（activeSlot 变化）→ 清手动地址，回到自动检测的 URL
  useEffect(() => {
    setManualAddr(null)
    setDraftAddr(null)
  }, [activeSlot])

  // AI 编译提交新命令（name/run/url 签名变化）→ 预览强制刷新（重编译产物可能已变，旧页面是陈旧内容）。
  // 首次挂载/hydration 不触发：签名从空到已存配置是加载，不是本次编译
  const cmdSignature = startupCommands.map((c) => `${c.name}:${c.run}:${c.url ?? ''}`).join('|')
  const prevCmdSignature = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevCmdSignature.current
    prevCmdSignature.current = cmdSignature
    if (prev === null || prev === cmdSignature) return
    if (showIframe) void previewReload()
  }, [cmdSignature, showIframe])

  // placeholder 坐标同步（ResizeObserver + window resize → 主进程 setBounds）
  // 跨屏拖拽时 DPI 变化会触发 resize 事件风暴，throttle 到 rAF 频率避免 IPC 堆积
  useEffect(() => {
    if (!showIframe || activeTab !== 'preview') { void previewBounds({ x: 0, y: 0, width: 0, height: 0 }); return }
    const el = placeholderRef.current
    if (!el) return
    let raf = 0
    let lastSent = 0
    const MIN_INTERVAL = 50 // 最多 20fps 的 IPC 频率
    const send = (): void => {
      const r = el.getBoundingClientRect()
      // 极小窗口时 placeholder 可能为0x0或负值，钳制到合理范围
      const rect = {
        x: Math.max(0, Math.round(r.x)),
        y: Math.max(0, Math.round(r.y)),
        width: Math.max(0, Math.round(r.width)),
        height: Math.max(0, Math.round(r.height)),
      }
      void previewBounds(rect)
      lastSent = Date.now()
    }
    const report = (): void => {
      cancelAnimationFrame(raf)
      const elapsed = Date.now() - lastSent
      if (elapsed >= MIN_INTERVAL) {
        raf = requestAnimationFrame(send)
      } else {
        raf = window.setTimeout(send, MIN_INTERVAL - elapsed)
      }
    }
    send()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', report) }
  }, [showIframe, deviceMode, activeTab, memorySidebarOpen])

  const chatBusy = chatStatus !== 'idle' && chatStatus !== 'error'
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
      return { name, command: (st?.processAlive ? st.command : null) || archived?.run || st?.command || '', archived: !!archived, slot: st }
    })
  })()

  // 全部编译进行中：按钮 loading 态 + 防重复点击（串行循环在后台跑，逐工程 Toast 汇报）
  const [compilingAll, setCompilingAll] = useState(false)

  /** AI 全部编译：串行编译所有已打开工程 */
  const aiCompileAll = (): void => {
    if (!projectPath || compilingAll) return
    setCompilingAll(true)
    void aiCompileAllOpen().finally(() => setCompilingAll(false))
  }

  /** 服务列表刷新：从 config 重读全量存档并重投影当前工程。
   *  兜底后台编译（目标≠当前工程）等投影不同步场景——数据在 map 里，重读即现。 */
  const refreshStartupCommands = (): void => {
    useStartupStore.getState().reloadFromConfig(projectPath).catch((e) => toast.err('刷新失败', String(e)))
  }

  /** 工具链缺失：授权 AI 自动安装 */
  const requestToolchainInstall = () => {
    if (!slot) return
    const curChat = selectCurrentChat(useChatStore.getState())
    if (curChat.status !== 'idle' && curChat.status !== 'error') { toast.info('AI 正忙', '请等待当前任务完成。'); return }
    void useChatStore.getState().send(
      `启动服务「${slot.name}」失败：${slot.errorText} 我已授权你自动安装缺失的工具链：请安装缺失的命令，安装完成后先验证工具可用，再用原命令重新启动服务「${slot.name}」。`,
    )
  }

  /** 二级视图切换：本地预览 / 远程发布（同一「项目怎么跑」流水线的两段） */
  const [subView, setSubView] = useState<'local' | 'deploy'>('local')

  /** 指令运行：直接执行存档的启动命令（零模型调用） */
  const runAll = async () => {
    if (!projectPath || !hasCommands) return
    const bs = useBuildStore.getState()
    for (const c of startupCommands) {
      const st = bs.byProject[projectPath]?.slots[c.name.toLowerCase()]
      if (st?.processAlive) continue
      await bs.start(c.name, c.run, projectPath, c.url)
    }
  }

  return (
    <div className="preview">
      {/* 二级切换：本地预览 / 远程发布 */}
      <div className="preview__segmented" role="tablist" aria-label="预览与发布">
        <button
          className={`preview__seg ${subView === 'local' ? 'preview__seg--active' : ''}`}
          onClick={() => setSubView('local')}
          role="tab"
          aria-selected={subView === 'local'}
        >
          本地预览
        </button>
        <button
          className={`preview__seg ${subView === 'deploy' ? 'preview__seg--active' : ''}`}
          onClick={() => setSubView('deploy')}
          role="tab"
          aria-selected={subView === 'deploy'}
        >
          远程发布
        </button>
      </div>
      {subView === 'deploy' ? (
        <DeployTab />
      ) : (
      <>
      {/* 启动工具栏：单工程 AI 编译入口在文件树根目录右键（accent 标识），工具栏只留批量与运行 */}
      <div className="preview__bar">
        <button
          className="btn btn--ghost btn--sm"
          disabled={!projectPath || compilingAll}
          aria-busy={compilingAll}
          onClick={() => aiCompileAll()}
          title="逐个对所有已打开工程调用 AI 识别启动命令（串行执行，忙的工程自动跳过；单工程编译在文件树根目录右键）"
        >
          {compilingAll ? '全部编译中…' : 'AI 全部编译'}
        </button>
        <button className="btn btn--primary btn--sm" disabled={!projectPath || !hasCommands} onClick={() => void runAll()}
          title={hasCommands ? '直接运行已识别的全部启动命令' : '请先点击「AI 全部编译」识别启动命令'}>
          <IconPlay size={12} /> 全部运行
        </button>
        <button className="btn btn--danger-ghost btn--sm" disabled={!anyAlive} onClick={() => void stopAll(projectPath ?? undefined)} title="停止全部服务进程">
          <IconStop size={12} /> 全部停止
        </button>
        <span className="preview__hint">
          {hasCommands
            ? `已识别 ${startupCommands.length} 个服务，点「全部运行」直接启动`
            : '单工程编译：文件树根目录右键「AI 编译」；「AI 全部编译」逐个编译所有已打开工程；识别完成后「全部运行」零 AI 启动'}
        </span>
        <div className="preview__spacer" />
        <button
          className="icon-btn"
          disabled={!projectPath}
          onClick={() => void refreshStartupCommands()}
          aria-label="刷新服务列表"
          title="刷新服务列表（从配置重读已识别的启动命令）"
        >
          <IconRefresh size={12} />
        </button>
      </div>

      {/* 服务列表 */}
      <ServiceList
        serviceRows={serviceRows} activeSlot={activeSlot} logSlot={logSlot} setLogSlot={setLogSlot}
        projectPath={projectPath} selectSlot={selectSlot}
        start={start} stop={stop} removeSlot={removeSlot}
        updateStartCommand={updateStartCommand} deleteStartCommand={deleteStartCommand}
        showConfirm={showConfirm}
      />

      {/* 节点日志台 */}
      {logSlot && logSt && (
        <div className="consolepane">
          <div className="consolepane__head">
            <span className="consolepane__name mono" title={logSlot}>{logSlot}</span>
            <span className={`slots__phase slots__phase--${logSt.phase}`}>{PHASE_LABEL[logSt.phase]}</span>
            <span className="consolepane__meta">{logSt.logs.length} 行</span>
            <div className="preview__spacer" />
            <button className="icon-btn" onClick={() => setLogSlot(null)} aria-label="关闭日志" title="关闭日志"><IconClose size={12} /></button>
          </div>
          <div className="consolepane__body"><LogDrawer logs={logSt.logs} /></div>
        </div>
      )}

      <BuildPipeline phase={phase} />

      {/* 预览地址栏（可编辑：回车导航；无协议自动补 http://）+ 设备切换 */}
      <div className="preview__urlbar">
        <IconLink size={13} />
        <input
          className="preview__addr-input mono"
          value={draftAddr ?? previewUrl}
          onChange={(e) => setDraftAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            const raw = (draftAddr ?? previewUrl).trim()
            // 空输入 = 放弃手动覆盖，回到自动检测地址
            if (!raw) {
              setDraftAddr(null)
              setManualAddr(null)
              return
            }
            const normalized = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
            setDraftAddr(null)
            setManualAddr(normalized)
            void previewSetUrl(normalized)
          }}
          placeholder={slot?.detectedUrl || '输入地址后回车导航（如 localhost:5173）'}
          aria-label="预览地址"
          spellCheck={false}
        />
        {slot && slot.detectedUrls.length > 1 && (
          <div className="preview__url-switch">
            {/* 下拉选检测地址：只切检测源，不建手动覆盖（否则后续重新检测被钉死在旧地址） */}
            <Select size="sm" value={slot.detectedUrl ?? ''} onChange={(u) => { setDraftAddr(null); setManualAddr(null); selectUrl(slot.name, u); void previewSetUrl(u) }}
              options={slot.detectedUrls.map((u) => ({ value: u, label: u }))} ariaLabel="切换服务地址" />
          </div>
        )}
        {(draftAddr !== null || (manualAddr !== null && manualAddr !== slot?.detectedUrl)) && (
          <button className="icon-btn" onClick={() => { setDraftAddr(null); setManualAddr(null) }} aria-label="回到自动检测地址" title="清除手动地址，回到自动检测">
            <IconClose size={12} />
          </button>
        )}
        <div className="preview__spacer" />
        <div className="preview__devices" role="radiogroup" aria-label="预览设备">
          {DEVICES.map(({ mode, label, Icon }) => (
            <button key={mode} className={`preview__device-btn ${deviceMode === mode ? 'preview__device-btn--active' : ''}`}
              onClick={() => setDeviceMode(mode)} title={label} aria-label={label} aria-pressed={deviceMode === mode}>
              <Icon size={13} />
            </button>
          ))}
        </div>
        <span className="statusbar__sep" />
        <button className="icon-btn" onClick={() => void api.openExternal(previewUrl)} disabled={!previewUrl} aria-label="系统浏览器打开" title="在系统默认浏览器中打开"><IconExternal size={13} /></button>
        <button className="icon-btn" onClick={() => void api.startElementPick()} disabled={!showIframe} aria-label="选取元素" title="选取预览页元素"><IconTarget size={13} /></button>
        <button className="icon-btn" disabled={!showIframe} onClick={() => void previewReload()} aria-label="刷新预览" title="清缓存并刷新预览"><IconRefresh size={13} /></button>
        <button className="icon-btn" disabled={!showIframe} onClick={() => void previewDevtools()} aria-label="DevTools" title="打开预览页 DevTools"><IconTerminal size={13} /></button>
        <button className={`icon-btn ${consoleOpen ? 'icon-btn--active' : ''}`} onClick={() => setConsoleOpen((v) => !v)} disabled={!showIframe} aria-label="页面控制台" title="页面控制台"><IconTerminal size={13} /></button>
      </div>

      {/* 异常详情 */}
      {phase === 'error' && slot && (
        <ErrorDetail
          slotName={activeSlot ?? '服务'} errorText={slot.errorText ?? ''} slotCommand={slot.command ?? ''}
          portInfo={portInfo} chatBusy={chatBusy} requestToolchainInstall={requestToolchainInstall}
        />
      )}

      {/* 页面控制台 */}
      {consoleOpen && (
        <div className="consolepane">
          <div className="consolepane__head">
            <span className="consolepane__name">控制台</span>
            <span className="consolepane__meta mono">{(() => { try { return new URL(previewUrl).host } catch { return '' } })()}</span>
            <span className="consolepane__meta">{consoleLines.length} 条</span>
            <div className="preview__spacer" />
            <button className="icon-btn" onClick={() => setConsoleLines([])} aria-label="清空显示" title="清空显示"><IconTrash size={12} /></button>
            <button className="icon-btn" onClick={() => setConsoleOpen(false)} aria-label="关闭控制台" title="关闭控制台"><IconClose size={12} /></button>
          </div>
          <div className="consolepane__body console-stream" ref={consoleBodyRef}>
            {consoleLines.length === 0 ? (
              <div className="console-stream__empty">暂无输出——页面里的 console.log / error 会显示在这里</div>
            ) : consoleLines.map((l, i) => (
              <div key={i} className={`console-stream__line console-stream__line--${l.level}`}>
                <span className="console-stream__level">{l.level === 'warning' ? 'warn' : l.level}</span>
                <span className="console-stream__text">{l.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 主舞台 */}
      <div className="preview__stage">
        {!projectPath ? (
          <EmptyState icon={<IconFolder size={22} />} title="尚未打开项目"
            text="创建一个新项目，或选择一个本地目录后，即可在这里编译并预览应用。"
            action={<div className="btn-row">
              <button className="btn btn--primary" onClick={() => setCreateProjectOpen(true)}><IconPlay size={14} /> 创建项目</button>
              <button className="btn btn--ghost" onClick={() => void openProjectDialog()}><IconFolder size={14} /> 打开项目</button>
            </div>}
          />
        ) : showIframe ? (
          <div ref={placeholderRef} className={`preview__frame-wrap ${constrained ? 'preview__frame-wrap--constrained' : ''}`}
            style={constrained ? { maxWidth: activeDevice.width! } : undefined} />
        ) : !slot || phase === 'idle' ? (
          <EmptyState icon={<IconPlay size={22} />} title="待启动"
            text={hasCommands
              ? `已识别 ${startupCommands.length} 个服务的启动命令，点击「全部运行」直接启动。`
              : '可直接在上方「添加服务」手动定义启动命令；也可在文件树根目录右键选「AI 编译」由 AI 自动识别。'}
            action={hasCommands
              ? <button className="btn btn--primary" onClick={() => void runAll()}><IconPlay size={14} /> 全部运行</button>
              : undefined}
          />
        ) : (
          <EmptyState icon={<IconTerminal size={22} />}
            title={phase === 'error' ? '进程异常，已停止加载预览' : '正在准备预览…'}
            text={phase === 'error' ? '请查看上方错误详情，修复后重新启动。' : `等待「${activeSlot}」的服务地址出现。`}
          />
        )}
      </div>
      </>
      )}
    </div>
  )
}

function LogDrawer({ logs }: { logs: { stream: 'stdout' | 'stderr'; line: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }, [logs])
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
