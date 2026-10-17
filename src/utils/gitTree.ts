/**
 * Git 改动列表的目录树构建（纯函数，GitPanel 视图专用）。
 * 路径按目录层级折叠成分组头，行内只显示文件名；单孩子目录链压缩成一行
 * （src/components/workspace/），fileCount = 子树内文件总数（折叠头计数徽标）。
 */
import type { GitFileEntry } from '@/types'

export type GitTreeNode =
  | { kind: 'dir'; label: string; path: string; fileCount: number; children: GitTreeNode[] }
  | { kind: 'file'; name: string; entry: GitFileEntry }

export function buildGitTree(files: GitFileEntry[]): GitTreeNode[] {
  interface DirNode extends Extract<GitTreeNode, { kind: 'dir' }> {}
  const dirs = new Map<string, DirNode>()
  const root: GitTreeNode[] = []
  const ensureDir = (dirPath: string): DirNode => {
    const hit = dirs.get(dirPath)
    if (hit) return hit
    const sep = dirPath.lastIndexOf('/')
    const parentPath = sep === -1 ? '' : dirPath.slice(0, sep)
    const node: DirNode = {
      kind: 'dir',
      label: sep === -1 ? dirPath : dirPath.slice(sep + 1),
      path: dirPath,
      fileCount: 0,
      children: [],
    }
    dirs.set(dirPath, node)
    if (sep === -1) root.push(node)
    else ensureDir(parentPath).children.push(node)
    return node
  }
  for (const f of files) {
    const segs = f.path.split('/')
    const name = segs.pop() as string
    const dirPath = segs.join('/')
    const parent = dirPath ? ensureDir(dirPath) : null
    ;(parent ? parent.children : root).push({ kind: 'file', name, entry: f })
    for (let d: DirNode | undefined = parent ?? undefined; d; ) {
      d.fileCount++
      const sep = d.path.lastIndexOf('/')
      d = sep === -1 ? undefined : dirs.get(d.path.slice(0, sep))
    }
  }
  const compress = (nodes: GitTreeNode[]): GitTreeNode[] =>
    nodes.map((n) => {
      if (n.kind !== 'dir') return n
      const children = compress(n.children)
      let merged: DirNode = { ...n, children }
      // 链上无分叉的目录合成一行：fileCount 插入期已沿祖先链累计，链合并不改变子树文件数
      while (merged.children.length === 1 && merged.children[0].kind === 'dir') {
        const only = merged.children[0] as DirNode
        merged = { ...merged, label: `${merged.label}/${only.label}`, path: only.path, children: only.children }
      }
      return merged
    })
  return compress(root)
}
