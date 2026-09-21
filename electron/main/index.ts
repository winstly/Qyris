/** Electron 主进程入口：多窗口管理、IPC 注册、退出清理 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray, nativeImage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { registerWindow, removeWindow, getAllWindows, emitToAllWindows, broadcastToWindows } from '../lib/emitter'
import * as pet from '../lib/pet'
import { setUnexpectedErrorHandler, isCancellationError } from '../../shared/base/errors'
import { format as logFormat } from '../../shared/base/log'
import { mainLog, attachFileLogging } from '../lib/log-file'

// 全局兜底：未捕获异常不崩主进程，统一进日志。
// （vscode onUnexpectedError 语义：取消不是错误，静默）
setUnexpectedErrorHandler((e) => {
  if (isCancellationError(e)) return
  mainLog.error(`[unexpected] ${logFormat(e)}`)
})
process.on('uncaughtException', (e) => {
  if (isCancellationError(e)) return
  mainLog.error(`[uncaughtException] ${logFormat(e)}`)
})
process.on('unhandledRejection', (reason) => {
  if (isCancellationError(reason)) return
  mainLog.error(`[unhandledRejection] ${logFormat(reason)}`)
})
import * as fsops from '../lib/fsops'
import * as config from '../lib/config'
import * as watcher from '../lib/watcher'
import * as proc from '../lib/proc'
import * as secrets from '../lib/secrets'
import * as ai from '../lib/ai'
import * as snapshot from '../lib/snapshot'
import * as inspect from '../lib/inspect'
import * as messages from '../lib/messages'
import * as memory from '../lib/memory/service'
import * as memoryAgent from '../lib/memory/agent'
import * as migrate from '../lib/migrate'
import { warmupEmbed } from '../lib/memory/embed'
import { closeDb, dataDir } from '../lib/db'
import * as skills from '../lib/skills'
import * as projectCreate from '../lib/project-create'
import * as git from '../lib/git'
import * as consolebridge from '../lib/consolebridge'
import * as preview from '../lib/preview'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<WindowState>
    return {
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      width: typeof parsed.width === 'number' ? parsed.width : 1440,
      height: typeof parsed.height === 'number' ? parsed.height : 900,
      maximized: parsed.maximized === true,
    }
  } catch {
    return { width: 1440, height: 900 }
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const state: WindowState = { ...win.getBounds(), maximized: win.isMaximized() }
    mkdirSync(path.dirname(windowStatePath()), { recursive: true })
    writeFileSync(windowStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* 状态保存失败不阻塞退出 */
  }
}

/** 退出清理（幂等）：先杀运行中的子进程树（含在途 CLI 子进程），再停所有 watcher、关闭 SQLite */
function cleanup(): void {
  proc.killRunningForCleanup()
  proc.cancelRunOnce()
  void watcher.stopWatching()
  if (tray && !tray.isDestroyed()) tray.destroy()
  closeDb()
}

function registerIpc(): void {
  const handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, payload: any) => unknown): void => {
    ipcMain.handle(channel, (event, payload: any) => listener(event, payload))
  }

  // 文件系统（projectRoot 来自渲染层，主进程做 ensureInside 校验）
  handle('list_dir', (_e, p) => fsops.listDir(p.projectRoot, p.dir))
  handle('list_dir_batch', (_e, p) => fsops.listDirBatch(p.projectRoot, p.dirs))
  handle('search_files', (_e, p) => fsops.searchFiles(p.projectRoot, p.query))
  handle('grep_files', (_e, p) =>
    fsops.grepFiles(p.projectRoot, String(p?.pattern ?? ''), {
      glob: p?.glob ?? undefined,
      maxResults: p?.maxResults ?? undefined,
      caseSensitive: p?.caseSensitive === true,
    }))
  handle('read_text_file', (_e, p) => fsops.readTextFile(p.projectRoot, p.path))
  handle('write_text_file', (_e, p) =>
    fsops.writeTextFile(p.projectRoot, p.path, p.content, {
      expectedMtimeMs: p?.expectedMtimeMs ?? null,
      force: p?.force === true,
    }))
  handle('edit_text_file', (_e, p) => fsops.editTextFile(p.projectRoot, p.path, p.oldString, p.newString))
  handle('create_entry', (_e, p) => fsops.createEntry(p.projectRoot, p.parentDir, p.name, p.isDir))
  handle('rename_entry', (_e, p) => fsops.renameEntry(p.projectRoot, p.path, p.newName))
  handle('delete_entry', (_e, p) => fsops.deleteEntry(p.projectRoot, p.path))
  handle('copy_entry', (_e, p) => fsops.copyEntry(p.projectRoot, p.srcPath, p.destDir))
  handle('move_entry', (_e, p) => fsops.moveEntry(p.projectRoot, p.srcPath, p.destDir))
  handle('delete_project_files', (_e, p) => {
    // 真超时：fsp.rm 在 EBUSY 下可能卡住重试很久，前端 30s flag 杀不掉 IPC。
    // 主进程侧用 AbortSignal.timeout 强制 reject，保证前端一定能收到响应。
    return Promise.race([
      fsops.deleteProjectFiles(p.projectRoot),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('删除超时（15s），文件被其他程序占用。请关闭占用程序后手动删除，或重启电脑后重试。')), 15_000),
      ),
    ])
  })

  // 文件快照（v2：版本快照 + diff 预览 + 定点回退）
  handle('snapshot_file', (_e, p) => snapshot.snapshotFile(p.projectRoot, p.sessionId, p.path, { version: p?.version === true }))
  handle('list_snapshots', (_e, p) => snapshot.listSnapshots(p.projectRoot))
  handle('snapshot_versions', (_e, p) => snapshot.listFileSnapshotVersions(p.projectRoot, p.path))
  handle('snapshot_read', (_e, p) => snapshot.readSnapshotContent(p.projectRoot, p.sessionId, p.path, p?.versionKey ?? null))
  handle('snapshot_diff', (_e, p) => snapshot.snapshotDiff(p.projectRoot, p.sessionId, p.path, p?.versionKey ?? null))
  handle('snapshot_restore_at', (_e, p) => snapshot.restoreSnapshotAt(p.projectRoot, p.sessionId, p.path, p?.versionKey ?? null))
  handle('restore_file', (_e, p) => snapshot.restoreFile(p.projectRoot, p.path))
  handle('restore_session', (_e, p) => snapshot.restoreSession(p.projectRoot, p.sessionId))
  handle('clear_project_snapshots', (_e, p) => snapshot.clearProjectSnapshots(p.projectRoot))

  // 会话消息持久化（SQLite）
  handle('messages_recent', (_e, p) => messages.messagesRecent(p.projectRoot, p.limit))
  handle('save_current_session', (_e, p) => messages.saveCurrentSession(p.projectRoot, p.sessionId))
  handle('messages_before', (_e, p) => messages.messagesBefore(p.projectRoot, p.sessionId, p.beforeSeq, p.limit))
  handle('message_append', (_e, p) => messages.messageAppend(p.projectRoot, p.sessionId, p.message))
  handle('message_patch', (_e, p) => messages.messagePatch(p.projectRoot, p.sessionId, p.id, p.patch))
  handle('messages_truncate', (_e, p) => messages.messagesTruncate(p.projectRoot, p.sessionId, p.afterSeq))
  handle('project_data_delete', (_e, p) => messages.projectDataDelete(p.projectRoot))
  handle('save_session_tokens', (_e, p) => messages.saveSessionTokens(p.projectRoot, p.sessionId, p.tokens))
  handle('load_session_tokens', (_e, p) => messages.loadSessionTokens(p.projectRoot, p.sessionId))

  // 记忆（检索底座：FTS + 向量混合；写入由 P2 mem agent 负责，此处仅管理通道）
  handle('memory_list', (_e, p) => memory.memoryList(p.projectRoot, p.includeArchived === true))
  handle('memory_search', (_e, p) =>
    memory.memorySearch(String(p.query ?? ''), p.projectRoot, p.topK, p.includeArchived === true))
  handle('memory_update', (_e, p) => memory.memoryUpdate(p.id, p.patch))
  handle('memory_delete', (_e, p) => memory.memoryDelete(p.id))
  handle('memory_move_scope', (_e, p) => memory.memoryMoveScope(p.id, p.target, p.projectRoot))
  handle('memory_clear', (_e, p) => memory.memoryClear(p.scope, p.projectRoot))
  handle('memory_stats', () => memory.memoryStats())
  // P3 备份通道（对话框绑定调用方窗口）
  handle('memory_export', (e, p) =>
    memory.memoryExport(p.scope, p.projectRoot ?? undefined, BrowserWindow.fromWebContents(e.sender)))
  handle('memory_import', (e) =>
    memory.memoryImport(BrowserWindow.fromWebContents(e.sender)))

  // mem agent（P2 记忆蒸馏管线：滚动/收尾/手动触发 + 会话摘要 + lesson；游标与频控在主进程）
  handle('memory_session_context', async (_e, p) => ({
    summary: await memory.sessionSummary(String(p.projectRoot ?? ''), String(p.sessionId ?? '')),
  }))
  handle('memory_maybe_extract', (_e, p) =>
    memoryAgent.memoryMaybeExtract(String(p.projectRoot ?? ''), String(p.sessionId ?? '')))
  handle('session_ended', (_e, p) =>
    memoryAgent.sessionEnded(String(p.projectRoot ?? ''), String(p.sessionId ?? '')))
  handle('memory_run_now', (_e, p) => memoryAgent.memoryRunNow(String(p.projectRoot ?? '')))
  handle('memory_extracting', (_e, p) => memoryAgent.isExtracting(String(p.projectRoot ?? '')))
  handle('note_lesson', (_e, p) =>
    memory.noteLesson(String(p.projectRoot ?? ''), String(p.sessionId ?? ''), p.lesson))

  // 存储位置（设置项：当前路径显示 / 选择目录 + 迁移）
  handle('get_data_dir', () => dataDir())
  handle('select_data_dir', (e) => migrate.selectDataDir(BrowserWindow.fromWebContents(e.sender)))
  handle('migrate_data_dir', (_e, p) => migrate.migrateDataDir(String(p?.dir ?? '')))

  // 子进程 / watcher（windowId 用于事件定向路由）
  handle('run_project', (e, p) => proc.runProject(p.projectRoot, p.name, p.command, e.sender.id))
  handle('run_once', (_e, p) => proc.runOnce(p.projectRoot, p.command, p.token))
  handle('run_once_cancel', (_e, p) => proc.cancelRunOnce(p?.token))
  handle('stop_project', (_e, p) => proc.stopProject(p?.projectRoot ?? null, p?.name ?? null))
  handle('check_url', (_e, p) => proc.checkUrlHealthy(String(p?.url ?? '')))
  // 预览控制台
  handle('preview_console_attach', (_e, p) => consolebridge.setConsoleFilter(p?.url ? String(p.url) : null))
  handle('preview_set_url', async (_e, p) => preview.setPreviewUrl(String(p?.url ?? '')))
  handle('preview_bounds', async (_e, p) => preview.setPreviewBounds(p as { x: number; y: number; width: number; height: number }))
  handle('preview_reload', async () => preview.reloadPreview())
  handle('preview_clear_cache', async () => preview.clearPreviewCache())
  handle('preview_devtools', async () => preview.previewOpenDevTools())
  handle('preview_execute_js', async (_e, p) => preview.previewExecuteJs(String(p?.code ?? '')))
  handle('preview_visible', async (_e, p) => preview.setPreviewVisible(p?.visible !== false))
  handle('preview_console_history', () => consolebridge.consoleHistory())
  // 端口占用查询
  handle('port_owner', (_e, p) => proc.portOwner(Number(p?.port)))
  // 多窗口 watcher：传入 windowId
  handle('start_watching', (e, p) => watcher.startWatching(p.projectRoot, e.sender.id))
  handle('stop_watching', (e) => watcher.stopWatchingForWindow(e.sender.id))
  handle('stop_watching_project', (e, p) => watcher.stopProjectWatching(p.projectRoot, e.sender.id))

  // 配置与密钥
  handle('get_config', () => config.getConfig())
  handle('merge_config', (_e, p) => config.mergeConfig(p.patch))
  // 密钥增删后广播 config:changed：另一窗口（桌宠面板无 SettingsDialog）据此刷新 hasApiKey
  handle('set_secret', async (_e, p) => {
    await secrets.setSecret(p.key, p.value)
    emitToAllWindows('config:changed', ['secrets'])
  })
  handle('has_secret', (_e, p) => secrets.hasSecret(p.key))
  handle('delete_secret', async (_e, p) => {
    await secrets.deleteSecret(p.key)
    emitToAllWindows('config:changed', ['secrets'])
  })

  // Skills 目录
  handle('scan_skills', (_e, p) => skills.scanSkillsDirs(p.dirs))
  handle('read_skill', (_e, p) => skills.readSkillFromDirs(p.dirs, p.skillId))
  handle('pick_skills_dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Skills 目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  // 项目级 Skill CRUD
  handle('project_skill_import_zip', (_e, p) => skills.importSkillFromZip(p.dir, p.zipPath))
  handle('project_skill_import_dir', (_e, p) => skills.importSkillFromDir(p.dir, p.srcDir))
  handle('project_skill_delete', (_e, p) => skills.deleteProjectSkill(p.dir, p.skillId))
  handle('project_skill_pick_zip', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Skill ZIP 包',
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  handle('project_skill_pick_dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Skill 目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // 创建项目 / Git
  handle('create_empty_project', (_e, p) => projectCreate.createEmptyProject(p.parentDir, p.name))
  handle('clone_repos', (_e, p) => projectCreate.cloneRepos(p.parentDir, p.repos))
  handle('test_repo', (_e, p) => projectCreate.testRepo(p.url))
  handle('git_repo_info', (_e, p) => projectCreate.gitRepoInfo(p.dir))
  handle('git_checkout', (_e, p) => projectCreate.gitCheckout(p.dir, p.branch))
  // Git 工作区
  handle('git_status', (_e, p) => git.gitStatus(p.dir))
  handle('git_is_repo_root', (_e, p) => git.gitIsRepoRoot(p.dir))
  handle('git_diff', (_e, p) => git.gitDiff(p.dir, p.path, p.staged === true))
  handle('git_add', (_e, p) => git.gitAdd(p.dir, p.paths))
  handle('git_unstage', (_e, p) => git.gitUnstage(p.dir, p.paths ?? []))
  handle('git_commit', (_e, p) => git.gitCommit(p.dir, String(p.message ?? '')))
  handle('git_pull', (_e, p) => git.gitPull(p.dir))
  handle('git_fetch', (_e, p) => git.gitFetch(p.dir))
  handle('git_push', (_e, p) => git.gitPush(p.dir))
  handle('git_discard', (_e, p) => git.gitDiscard(p.dir, p.paths ?? []))
  handle('pick_parent_dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    // 同 pick_directory：alwaysOnTop 窗口先取消置顶再弹原生对话框
    const wasAlwaysOnTop = win.isAlwaysOnTop()
    if (wasAlwaysOnTop) win.setAlwaysOnTop(false)
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '选择父目录',
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    } finally {
      if (wasAlwaysOnTop) win.setAlwaysOnTop(true)
    }
  })

  // AI（windowId 绑定到发起请求的窗口，用于事件定向路由；opts 透传 CLI 记忆反哺通道——
  //  sessionSummary/memoryBlock，缺此一跳 CLI 模式的记忆注入会整体断供）
  handle('ai_chat_stream', (e, p) =>
    Promise.resolve(
      ai.aiChatStream(p.requestId, p.provider, p.baseUrl, p.model, p.messages, p.tools, p.dispatchMode, p.projectRoot, e.sender.id, p.opts ?? undefined),
    ).then(
      (r) => {
        // 镜像管道：请求收场广播给其余窗口（镜像侧据此收口状态并从库校正）
        broadcastToWindows('chat:request-done', { requestId: p.requestId, projectRoot: p.projectRoot ?? null, hasError: false }, e.sender.id)
        return r
      },
      (err) => {
        broadcastToWindows('chat:request-done', { requestId: p.requestId, projectRoot: p.projectRoot ?? null, hasError: true }, e.sender.id)
        throw err
      },
    ))
  handle('ai_test_connection', (_e, p) => ai.aiTestConnection(p.provider, p.baseUrl, p.model, p.dispatchMode))
  handle('ai_cancel', (_e, p) => ai.aiCancel(p.requestId))

  // 跨窗口项目同步：发起窗口 send → 主进程广播给其余窗口
  ipcMain.on('project:changed', (e, p: { projectPath: string | null; openProjects: string[]; closedProject?: string | null }) => {
    broadcastToWindows('project:changed', p, e.sender.id)
  })

  // 桌宠视频路径解析：打包后用 file:// 指向 asarUnpack 解包的 MP4，dev 用相对路径
  handle('pet:resolve-video', (_e, filename: string) => {
    if (app.isPackaged) {
      // asarUnpack 解包到 app.asar.unpacked/out/renderer/pet/
      return `file://${path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'renderer', 'pet', filename)}`
    }
    // dev 模式：Vite dev server 的 public 目录
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) return `${rendererUrl}/pet/${filename}`
    return filename
  })

  // 窗口（对话框绑定到调用方窗口）
  handle('pick_directory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    // alwaysOnTop 窗口（桌宠面板）会盖住原生对话框 → 用户看到"点了没反应"。
    // 弹窗期间临时取消置顶，结束后恢复。
    const wasAlwaysOnTop = win.isAlwaysOnTop()
    if (wasAlwaysOnTop) win.setAlwaysOnTop(false)
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '选择项目目录',
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    } finally {
      if (wasAlwaysOnTop) win.setAlwaysOnTop(true)
    }
  })
  handle('set_window_title', (e, p) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.setTitle(String(p.title))
  })
  handle('open_external', (_e, p) => {
    const url = String(p.url ?? '')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`非法 URL：${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`仅允许 http/https 链接：${url}`)
    }
    return shell.openExternal(url)
  })
  handle('open_in_explorer', (_e, { filePath }: { filePath: string }) => {
    return shell.showItemInFolder(filePath)
  })
  // 桌宠（注入主窗口/退出动作，右键菜单用；quitApp 先置放行位再退，不与 close 拦截死缠）
  pet.registerPetIpc({
    openMain: () => showMainWindow(),
    quitApp: () => {
      quitting = true
      app.quit()
    },
  })
  ipcMain.on('pet:move-by', (e, dx: number, dy: number) => {
    // 渲染层来的 TS 类型标注只是编译期的：IPC 载荷必须运行时校验，
    // 否则字符串会拼接进坐标、NaN 会把窗口打到无效位置
    const ix = Number(dx)
    const iy = Number(dy)
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) return
    const petWin = BrowserWindow.fromWebContents(e.sender)
    if (petWin && !petWin.isDestroyed()) {
      const [x, y] = petWin.getPosition()
      petWin.setPosition(x + ix, y + iy)
      // 面板实时跟随拖动：开着面板拖桌宠时，面板贴着图标走而不是停在原地
      pet.repositionPanelIfVisible()
    }
  })
  // 主窗口生命周期：关闭询问回调（挂起中才受理，超时兜底已收口）+ 桌宠面板「打开主窗口」入口
  ipcMain.on('app:close-resolve', (_e, p: { action?: string; remember?: boolean }) => {
    if (!closePromptPending) return
    closePromptPending = false
    const action = p?.action === 'quit' ? 'quit' : 'minimize'
    if (p?.remember === true) void config.mergeConfig({ closeAction: action })
    if (action === 'quit') {
      quitting = true
      app.quit()
      return
    }
    if (mainWin && !mainWin.isDestroyed()) mainWin.hide()
  })
  // 对话镜像 relay：发起窗口的用户消息/收尾/清空 → 其余全部窗口（桌宠面板 ↔ 主窗口同一场对话）
  ipcMain.on('chat:mirror-relay', (e, p) => broadcastToWindows('chat:mirror', p, e.sender.id))

  handle('start_element_pick', (e) => {
    // 定向回传发起窗口：拾取只在主窗口预览发起，广播会让面板收到别的窗口选中的元素
    void inspect.startElementPick(preview.getPreviewWebContents(), e.sender.id)
  })
}

/** 窗口位置偏移：新窗口相对上一个主窗口偏移 40px（桌宠/面板小窗口不参与布局计算） */
function nextWindowOffset(): { x: number; y: number } {
  const wins = getAllWindows().filter((w) => !pet.isPetFamilyWindowId(w.id))
  if (wins.length === 0) return { x: NaN, y: NaN }
  const last = wins[wins.length - 1]
  const bounds = last.getBounds()
  return { x: bounds.x + 40, y: bounds.y + 40 }
}

/** 主窗口引用：桌宠面板「打开主窗口」与关闭拦截的 hide 都需要定向操作 */
let mainWin: BrowserWindow | null = null
/** 系统托盘（模块级持有防 GC） */
let tray: Tray | null = null
/** app.quit() 进行中：放行所有窗口 close，避免关闭拦截把退出也拦下来 */
let quitting = false
/** 关闭询问弹窗挂起中：防重复触发；渲染层超时未响应时兜底 */
let closePromptPending = false

/** 主窗口关闭（已 preventDefault）：按配置分流。
 *  ask=推给渲染层弹询问框；minimize=隐藏保留桌宠；quit=退出整个应用。
 *  渲染层 10s 无响应按最小化兜底——宁可窗口藏起来可找回，不可让应用凭空失联。 */
async function requestClose(win: BrowserWindow): Promise<void> {
  const cfg = await config.getConfig()
  if (cfg.closeAction === 'minimize') {
    win.hide()
    return
  }
  if (cfg.closeAction === 'quit') {
    quitting = true
    app.quit()
    return
  }
  if (closePromptPending) return
  closePromptPending = true
  win.webContents.send('app:close-request')
  setTimeout(() => {
    if (!closePromptPending) return
    closePromptPending = false
    // 兜底隐藏前必须通知渲染层收起询问框：否则窗口找回后残留的对话框
    // 按钮会打在已收口的 pending 位上，点了没反应（用户以为退出了其实没退）
    if (!win.isDestroyed()) {
      win.webContents.send('app:close-cancel')
      win.hide()
    }
  }, 10_000)
}

/** 把主窗口带到前台；窗口已被销毁（异常路径）时重建 */
function showMainWindow(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
    return
  }
  createWindow()
}

/** 创建主窗口（渲染层 boot 时读取配置自动恢复上次项目） */
function createWindow(): void {
  const state = loadWindowState()
  const offset = nextWindowOffset()
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    x: Number.isFinite(offset.x) ? offset.x : state.x,
    y: Number.isFinite(offset.y) ? offset.y : state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 600,
    title: '轻驭',
    icon: iconPath,
    show: false,
    backgroundColor: '#131315',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (state.maximized && getAllWindows().filter((w) => !pet.isPetFamilyWindowId(w.id)).length === 0) win.maximize()
  registerWindow(win)
  mainWin = win
  preview.setPreviewHost(win)

  win.once('ready-to-show', () => win.show())
  consolebridge.attachConsoleCapture(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url)
        return { action: 'deny' }
      }
    } catch {
      /* 非 URL 放行默认行为 */
    }
    return { action: 'allow' }
  })
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
  })
  win.on('close', (e) => {
    saveWindowState(win)
    if (quitting) return
    // 关闭行为由主进程接管（ask/minimize/quit），不允许默认销毁——桌宠还活着时窗口必须可找回
    e.preventDefault()
    void requestClose(win)
  })
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
    removeWindow(win)
    pet.clearWindowChatState(win.id)
    void watcher.stopWatchingForWindow(win.id)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const fileUrl = path.join(__dirname, '../renderer/index.html')
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(fileUrl)
  }
}

app.whenReady().then(async () => {
  // 文件日志就绪（此前日志进 BufferLogger 缓冲，此刻回放）
  attachFileLogging()
  mainLog.info('[boot] 轻驭主进程启动')
  // 配置变更广播：任一窗口/主进程写配置后，所有窗口收到变化的顶层键
  config.onConfigChanged((keys) => {
    emitToAllWindows('config:changed', [...keys])
  })

  // 清理上次异常退出遗留的服务进程树（异步校验命令行，不再阻塞启动）
  try {
    const killed = await proc.cleanupOrphanServices()
    if (killed > 0) mainLog.info(`[cleanup] 已清理 ${killed} 个上次遗留的服务进程`)
  } catch { /* 清理失败不阻塞启动 */ }

  // 嵌入模型预热 + 蒸馏 token 恢复 + 记忆维护作业（fire-and-forget 不阻塞启动）：
  //  预热成功后跑指纹自愈（不符 → 全量重嵌）；衰减/归档作业 boot 调度（30s 首跑 + 每 6h）
  void warmupEmbed().then((ready) => {
    if (ready) void memory.maybeStartReembedJob().catch((e) => mainLog.warn(`[memory] 重嵌自愈失败：${String(e)}`))
  })
  void memory.loadDistillTokens().catch(() => {})
  memory.startDecayJob()

  // 应用菜单
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]))
  } else {
    Menu.setApplicationMenu(null)
  }
  registerIpc()
  createWindow()
  // 桌宠：主窗口就绪后创建透明置顶小窗口
  pet.createPetWindow()
  // 系统托盘：主窗口隐藏后可通过托盘找回；右键菜单提供全局操作入口
  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')
  try {
    let trayIcon = nativeImage.createFromPath(trayIconPath)
    // macOS 菜单栏图标缩放到 18px（不设 Template——彩色图标设 Template 会变全白不可见）
    if (process.platform === 'darwin') {
      trayIcon = trayIcon.resize({ width: 18, height: 18 })
    }
    tray = new Tray(trayIcon)
    tray.setToolTip('轻驭')
    const buildTrayMenu = (): Menu => Menu.buildFromTemplate([
      { label: '打开工作台', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出应用', click: () => { quitting = true; app.quit() } },
    ])
    tray.setContextMenu(buildTrayMenu())
    // 左键单击打开主窗口（Windows/Linux）
    tray.on('click', () => showMainWindow())
    mainLog.info('[boot] 系统托盘已创建')
  } catch (e) {
    mainLog.warn(`[boot] 系统托盘创建失败：${String(e)}`)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 所有窗口关闭后退出
app.on('window-all-closed', () => {
  app.quit()
})

// 退出序列开始：放行所有窗口的 close 拦截，保证 ask/minimize 拦截不会卡死退出
app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  cleanup()
})
