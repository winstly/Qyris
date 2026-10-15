/**
 * 卡片列表分页：usePaged 切片 + Pager 翻页条。
 * 全仓卡片列表（Skill / 记忆 / 项目历史 / MCP server）共用一份节奏与样式。
 * resetKey 变化（切目录/换筛选/换工程）回第一页；数据量收缩时 safePage 自动钳制不悬空。
 */
import { useEffect, useMemo, useState } from 'react'

/** 全仓统一每页条数（Skill / 记忆 / 项目历史 / MCP / 部署服务器共用） */
export const PAGE_SIZE = 20

export function usePaged<T>(items: readonly T[], size: number, resetKey = '') {
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [resetKey])
  const pageCount = Math.max(1, Math.ceil(items.length / size))
  const safePage = Math.min(page, pageCount)
  // 数据量收缩时把存储页码一并钳下来：只钳显示值的话，列表回涨会无人操作跳回旧页
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])
  const start = (safePage - 1) * size
  const slice = useMemo(() => items.slice(start, start + size), [items, start, size])
  return {
    page: safePage,
    setPage,
    pageCount,
    total: items.length,
    /** 当前页首条在全量列表中的绝对下标（轮换花色等按绝对序取值用） */
    start,
    slice,
  }
}

export function Pager({ page, pageCount, total, onPage }: {
  page: number
  pageCount: number
  total: number
  onPage: (p: number) => void
}) {
  if (pageCount <= 1) return null
  return (
    <div className="pager" role="navigation" aria-label="分页">
      <button className="pager__btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="上一页" title="上一页">‹</button>
      <span className="pager__info">第 {page} / {pageCount} 页 · 共 {total} 条</span>
      <button className="pager__btn" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="下一页" title="下一页">›</button>
    </div>
  )
}
