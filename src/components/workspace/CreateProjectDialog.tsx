import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { api } from '@/services/desktop'
import { IconClose, IconFolder, IconPlus, IconTrash } from '@/components/common/icons'

type Tab = 'empty' | 'clone'

/**
 * 创建项目对话框：两种模式 —— 创建空项目 / 从远端仓库克隆（支持多仓库）。
 */
export function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const openProject = useAppStore((s) => s.openProject)
  const showAlert = useAppStore((s) => s.showAlert)

  const [tab, setTab] = useState<Tab>('empty')

  // 空项目
  const [emptyName, setEmptyName] = useState('')
  const [emptyParent, setEmptyParent] = useState('')

  // 克隆
  const [cloneUrls, setCloneUrls] = useState<string[]>([''])
  const [cloneParent, setCloneParent] = useState('')

  const [creating, setCreating] = useState(false)

  if (!open) return null

  const reset = () => {
    setEmptyName('')
    setEmptyParent('')
    setCloneUrls([''])
    setCloneParent('')
    setCreating(false)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const pickEmptyParent = async () => {
    try {
      const dir = await api.pickParentDir()
      if (dir) setEmptyParent(dir)
    } catch (e) {
      console.error('pickParentDir 失败：', e)
    }
  }

  const pickCloneParent = async () => {
    try {
      const dir = await api.pickParentDir()
      if (dir) setCloneParent(dir)
    } catch (e) {
      console.error('pickParentDir 失败：', e)
    }
  }

  const handleCreateEmpty = async () => {
    if (!emptyName.trim() || !emptyParent.trim()) return
    setCreating(true)
    try {
      const projectPath = await api.createEmptyProject(emptyParent.trim(), emptyName.trim())
      await openProject(projectPath)
      handleClose()
    } catch (e) {
      await showAlert('创建失败', String(e))
    } finally {
      setCreating(false)
    }
  }

  const handleClone = async () => {
    const validUrls = cloneUrls.map((u) => u.trim()).filter(Boolean)
    if (!validUrls.length || !cloneParent.trim()) return
    setCreating(true)
    try {
      const paths = await api.cloneRepos(cloneParent.trim(), validUrls)
      // 打开第一个克隆的目录（或多仓库时打开父目录）
      const openPath = paths.length === 1 ? paths[0] : cloneParent.trim()
      await openProject(openPath)
      handleClose()
    } catch (e) {
      await showAlert('克隆失败', String(e))
    } finally {
      setCreating(false)
    }
  }

  const addCloneUrl = () => setCloneUrls((prev) => [...prev, ''])
  const removeCloneUrl = (i: number) => setCloneUrls((prev) => prev.filter((_, idx) => idx !== i))
  const updateCloneUrl = (i: number, val: string) => setCloneUrls((prev) => prev.map((u, idx) => idx === i ? val : u))

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose() }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="创建项目">
        <div className="modal__head">
          <span>创建项目</span>
          <button className="icon-btn" onClick={handleClose} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="创建方式">
          <button
            className={`settings-tab ${tab === 'empty' ? 'settings-tab--active' : ''}`}
            onClick={() => setTab('empty')}
            role="tab"
            aria-selected={tab === 'empty'}
          >
            创建空项目
          </button>
          <button
            className={`settings-tab ${tab === 'clone' ? 'settings-tab--active' : ''}`}
            onClick={() => setTab('clone')}
            role="tab"
            aria-selected={tab === 'clone'}
          >
            从远端克隆
          </button>
        </div>

        {tab === 'empty' ? (
          <>
            <label className="field">
              <span className="field__label">父目录</span>
              <div className="create-project__dir-row">
                <input
                  className="field__input mono"
                  value={emptyParent}
                  onChange={(e) => setEmptyParent(e.target.value)}
                  placeholder="选择一个目录作为父目录"
                />
                <button className="btn btn--ghost btn--sm" onClick={pickEmptyParent} title="浏览选择">
                  <IconFolder size={13} />
                </button>
              </div>
              <span className="field__hint">新项目将创建在此目录下</span>
            </label>
            <label className="field">
              <span className="field__label">项目名称</span>
              <input
                className="field__input mono"
                value={emptyName}
                onChange={(e) => setEmptyName(e.target.value)}
                placeholder="my-project"
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateEmpty() }}
              />
            </label>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={handleClose}>取消</button>
              <button
                className="btn btn--primary"
                onClick={handleCreateEmpty}
                disabled={!emptyName.trim() || !emptyParent.trim() || creating}
              >
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field__label">父目录</span>
              <div className="create-project__dir-row">
                <input
                  className="field__input mono"
                  value={cloneParent}
                  onChange={(e) => setCloneParent(e.target.value)}
                  placeholder="选择一个目录存放克隆的仓库"
                />
                <button className="btn btn--ghost btn--sm" onClick={pickCloneParent} title="浏览选择">
                  <IconFolder size={13} />
                </button>
              </div>
              <span className="field__hint">每个仓库克隆为子目录；单仓库直接打开该子目录</span>
            </label>

            <div className="field">
              <span className="field__label">仓库地址</span>
              <div className="create-project__urls">
                {cloneUrls.map((url, i) => (
                  <div key={i} className="create-project__url-row">
                    <input
                      className="field__input mono"
                      value={url}
                      onChange={(e) => updateCloneUrl(i, e.target.value)}
                      placeholder="https://github.com/user/repo.git"
                    />
                    {cloneUrls.length > 1 && (
                      <button className="icon-btn" onClick={() => removeCloneUrl(i)} aria-label="移除" title="移除此地址">
                        <IconTrash size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button className="btn btn--ghost btn--sm" onClick={addCloneUrl} style={{ marginTop: 6 }}>
                <IconPlus size={12} /> 添加仓库
              </button>
            </div>

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={handleClose}>取消</button>
              <button
                className="btn btn--primary"
                onClick={handleClone}
                disabled={!cloneUrls.some((u) => u.trim()) || !cloneParent.trim() || creating}
              >
                {creating ? '克隆中…' : '克隆'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
