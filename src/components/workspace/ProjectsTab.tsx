import { useAppStore } from '@/store/useAppStore'
import { api } from '@/services/desktop'
import { IconClock, IconClose, IconFolder, IconPlus, IconTrash } from '@/components/common/icons'
import { basename } from '@/utils/path'
import { timeAgo } from '@/utils/time'

/** 项目 Tab：顶栏「创建/打开项目」+ 分「当前项目」（本会话驻留/运行中）与「历史项目」（持久化记录）两段。 */
export function ProjectsTab() {
  const projectPath = useAppStore((s) => s.projectPath)
  const openProjects = useAppStore((s) => s.openProjects)
  const recentProjects = useAppStore((s) => s.recentProjects)
  const openProject = useAppStore((s) => s.openProjectWithChoice)
  const openProjectDialog = useAppStore((s) => s.openProjectDialog)
  const closeProject = useAppStore((s) => s.closeProject)
  const removeRecentProject = useAppStore((s) => s.removeRecentProject)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const showAlert = useAppStore((s) => s.showAlert)
  const setCreateProjectOpen = useAppStore((s) => s.setCreateProjectOpen)

  // 历史项目 = 最近记录里排除当前已打开（避免与「当前项目」重复）
  const historyOnly = recentProjects.filter((p) => !openProjects.includes(p.path))

  const removeFromHistory = async (proj: { path: string; name: string }) => {
    const res = await showConfirm(
      '移除历史记录',
      `确定要将「${proj.name}」从历史记录中移除吗？`,
      [
        { id: 'session', label: '同时删除对话历史（不可恢复）' },
        { id: 'memory', label: '同时删除工程记忆' },
        { id: 'files', label: '同时删除项目文件（不可恢复）' },
      ],
      { holdOpen: true, confirmingText: '删除中…' },
    )
    const r = res as { confirmed?: boolean; checks?: Record<string, boolean> } | boolean | null
    const confirmed = r && typeof r === 'object' && r.confirmed
    const checks = confirmed && typeof r === 'object' ? (r.checks ?? {}) : {}
    if (!confirmed) {
      useAppStore.getState().closeDialog()
      return
    }

    const patch = useAppStore.getState().patchDialog
    let failed = ''
    try {
      if (checks.session) {
        patch({ confirmingText: '正在删除对话数据…' })
        try { await api.projectDataDelete(proj.path) } catch { /* 忽略 */ }
      }
      if (checks.memory) {
        patch({ confirmingText: '正在清除记忆…' })
        try { await api.memoryClear('project', proj.path) } catch { /* 忽略 */ }
      }
      let deleteFailed = ''
      if (checks.files) {
        patch({ confirmingText: '删除中…' })
        // 停 watcher + 服务（不单独展示状态，统一"删除中"）
        await api.stopProject(proj.path).catch(() => {})
        await api.stopWatchingProject(proj.path).catch(() => {})
        if (useAppStore.getState().openProjects.includes(proj.path)) {
          await useAppStore.getState().closeProject(proj.path)
        }
        await new Promise((r) => setTimeout(r, 500))
        try {
          await api.deleteProjectFiles(proj.path)
        } catch (e) {
          deleteFailed = String(e)
        }
        await useAppStore.getState().clearStartupCommands(proj.path)
        await api.clearProjectSnapshots(proj.path).catch(() => {})
      }
      if (deleteFailed) {
        // 删除失败：保留在列表，提示用户
        useAppStore.getState().closeDialog()
        void showAlert('删除失败', deleteFailed)
      } else {
        // 删除成功：从列表移除
        removeRecentProject(proj.path)
        useAppStore.getState().closeDialog()
      }
      return
    } catch (e) {
      failed = String(e)
    }
    useAppStore.getState().closeDialog()
    if (failed) void showAlert('移除失败', failed)
  }

  const empty = recentProjects.length === 0 && openProjects.length === 0

  return (
    <div className="projects-tab">
      <div className="projects-tab__bar">
        <button className="btn btn--primary btn--sm" onClick={() => setCreateProjectOpen(true)}>
          <IconPlus size={13} /> 创建项目
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => void openProjectDialog()}>
          <IconFolder size={13} /> 打开项目
        </button>
      </div>

      {empty ? (
        <div className="history">
          <div className="emptystate">
            <div className="emptystate__icon"><IconClock size={22} /></div>
            <div className="emptystate__title">暂无项目</div>
            <div className="emptystate__text">创建或打开一个项目后，这里会记录你的项目列表。</div>
          </div>
        </div>
      ) : (
        <div className="history">
          <div className="history__section">
            <div className="history__section-label">当前项目</div>
            {openProjects.length === 0 ? (
              <div className="history__empty">无打开项目</div>
            ) : (
              <div className="history__list">
                {openProjects.map((p) => {
                  const isActive = p === projectPath
                  return (
                    <div
                      key={p}
                      className={`history__item ${isActive ? 'history__item--active' : ''}`}
                      onClick={() => { if (!isActive) void openProject(p) }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !isActive) void openProject(p) }}
                    >
                      <div className="history__item-icon"><IconFolder size={15} /></div>
                      <div className="history__item-info">
                        <span className="history__item-name">{basename(p)}</span>
                        <span className="history__item-path mono">{p}</span>
                      </div>
                      <button
                        className="history__item-newwin"
                        onClick={(e) => { e.stopPropagation(); void closeProject(p) }}
                        aria-label={`关闭 ${basename(p)}`}
                        title="关闭项目（取消对话、停止服务）"
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="history__section">
            <div className="history__section-label">历史项目</div>
            {historyOnly.length === 0 ? (
              <div className="history__empty">暂无历史项目</div>
            ) : (
              <div className="history__list">
                {historyOnly.map((proj) => (
                  <div
                    key={proj.path}
                    className="history__item"
                    onClick={() => void openProject(proj.path)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') void openProject(proj.path) }}
                  >
                    <div className="history__item-icon"><IconFolder size={15} /></div>
                    <div className="history__item-info">
                      <span className="history__item-name">{proj.name}</span>
                      <span className="history__item-path mono">{proj.path}</span>
                    </div>
                    <span className="history__item-time">{timeAgo(proj.lastOpened)}</span>
                    <button
                      className="history__item-newwin"
                      onClick={(e) => { e.stopPropagation(); void api.openInExplorer(proj.path) }}
                      aria-label={`打开 ${proj.name} 所在目录`}
                      title="在资源管理器中打开"
                    >
                      <IconFolder size={12} />
                    </button>
                    <button
                      className="history__item-delete"
                      onClick={(e) => { e.stopPropagation(); void removeFromHistory(proj) }}
                      aria-label={`移除 ${proj.name}`}
                      title="从历史中移除"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
