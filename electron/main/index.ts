/** Electron 主进程入口：多窗口管理、IPC 注册、退出清理 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { registerWindow, removeWindow, getAllWindows } from '../lib/emitter'
import * as fsops from '../lib/fsops'
import * as config from '../lib/config'
import * as watcher from '../lib/watcher'
import * as proc from '../lib/proc'
import * as secrets from '../lib/secrets'
import * as ai from '../lib/ai'
import * as snapshot from '../lib/snapshot'
import * as inspect from '../lib/inspect'
import * as sessions from '../lib/sessions'
import * as skills from '../lib/skills'
import * as projectCreate from '../lib/project-create'
import * as git from '../lib/git'
import * as consolebridge from '../lib/consolebridge'

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

/** 退出清理（幂等）：先杀运行中的子进程树（含在途 CLI 子进程），再停所有 watcher */
function cleanup(): void {
  proc.killRunningForCleanup()
  proc.cancelRunOnce()
  void watcher.stopWatching()
}

function registerIpc(): void {
  const handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, payload: any) => unknown): void => {
    ipcMain.handle(channel, (event, payload: any) => listener(event, payload))
  }

  // 文件系统（projectRoot 来自渲染层，主进程做 ensureInside 校验）
  handle('list_dir', (_e, p) => fsops.listDir(p.projectRoot, p.dir))
  handle('search_files', (_e, p) => fsops.searchFiles(p.projectRoot, p.query))
  handle('read_text_file', (_e, p) => fsops.readTextFile(p.projectRoot, p.path))
  handle('write_text_file', (_e, p) => fsops.writeTextFile(p.projectRoot, p.path, p.content))
  handle('create_entry', (_e, p) => fsops.createEntry(p.projectRoot, p.parentDir, p.name, p.isDir))
  handle('rename_entry', (_e, p) => fsops.renameEntry(p.projectRoot, p.path, p.newName))
  handle('delete_entry', (_e, p) => fsops.deleteEntry(p.projectRoot, p.path))
  handle('copy_entry', (_e, p) => fsops.copyEntry(p.projectRoot, p.srcPath, p.destDir))
  handle('move_entry', (_e, p) => fsops.moveEntry(p.projectRoot, p.srcPath, p.destDir))
  handle('delete_project_files', (_e, p) => fsops.deleteProjectFiles(p.projectRoot))

  // 文件快照
  handle('snapshot_file', (_e, p) => snapshot.snapshotFile(p.projectRoot, p.sessionId, p.path))
  handle('list_snapshots', (_e, p) => snapshot.listSnapshots(p.projectRoot))
  handle('restore_file', (_e, p) => snapshot.restoreFile(p.projectRoot, p.path))
  handle('restore_session', (_e, p) => snapshot.restoreSession(p.projectRoot, p.sessionId))
  handle('clear_project_snapshots', (_e, p) => snapshot.clearProjectSnapshots(p.projectRoot))

  // 会话历史持久化
  handle('load_session', (_e, p) => sessions.loadSession(p.projectRoot))
  handle('save_session', (_e, p) => sessions.saveSession(p.projectRoot, p.messages))

  // 子进程 / watcher（windowId 用于事件定向路由）
  handle('run_project', (e, p) => proc.runProject(p.projectRoot, p.name, p.command, e.sender.id))
  handle('run_once', (_e, p) => proc.runOnce(p.projectRoot, p.command, p.token))
  handle('run_once_cancel', (_e, p) => proc.cancelRunOnce(p?.token))
  handle('stop_project', (_e, p) => proc.stopProject(p?.projectRoot ?? null, p?.name ?? null))
  handle('check_url', (_e, p) => proc.checkUrlHealthy(String(p?.url ?? '')))
  // 预览控制台
  handle('preview_console_attach', (_e, p) => consolebridge.setConsoleFilter(p?.url ? String(p.url) : null))
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
  handle('set_secret', (_e, p) => secrets.setSecret(p.key, p.value))
  handle('has_secret', (_e, p) => secrets.hasSecret(p.key))
  handle('delete_secret', (_e, p) => secrets.deleteSecret(p.key))

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
    const result = await dialog.showOpenDialog(win, {
      title: '选择父目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // AI（windowId 绑定到发起请求的窗口，用于事件定向路由）
  handle('ai_chat_stream', (e, p) =>
    ai.aiChatStream(p.requestId, p.provider, p.baseUrl, p.model, p.messages, p.tools, p.dispatchMode, p.projectRoot, e.sender.id))
  handle('ai_test_connection', (_e, p) => ai.aiTestConnection(p.provider, p.baseUrl, p.model, p.dispatchMode))
  handle('ai_cancel', (_e, p) => ai.aiCancel(p.requestId))

  // 窗口（对话框绑定到调用方窗口）
  handle('pick_directory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择项目目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
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
  handle('start_element_pick', (e, p) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) {
      void inspect.startElementPick(win.webContents, String(p.url ?? ''))
    }
  })
}

/** 窗口位置偏移：新窗口相对上一个偏移 40px */
function nextWindowOffset(): { x: number; y: number } {
  const wins = getAllWindows()
  if (wins.length === 0) return { x: NaN, y: NaN }
  const last = wins[wins.length - 1]
  const bounds = last.getBounds()
  return { x: bounds.x + 40, y: bounds.y + 40 }
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

  if (state.maximized && getAllWindows().length === 0) win.maximize()
  registerWindow(win)

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
  win.on('close', () => saveWindowState(win))
  win.on('closed', () => {
    removeWindow(win)
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

app.whenReady().then(() => {
  // 清理上次异常退出遗留的服务进程树
  try {
    const killed = proc.cleanupOrphanServices()
    if (killed > 0) console.log(`[cleanup] 已清理 ${killed} 个上次遗留的服务进程`)
  } catch { /* 清理失败不阻塞启动 */ }

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 所有窗口关闭后退出
app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  cleanup()
})
