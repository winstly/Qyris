/** 取路径最后一段（兼容 / 与 \） */
export function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '')
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return i === -1 ? norm : norm.slice(i + 1)
}

/** 项目内相对路径展示 */
export function relativePath(root: string, p: string): string {
  const nr = root.replace(/[\\/]+$/, '')
  if (p.startsWith(nr)) {
    const rel = p.slice(nr.length).replace(/^[\\/]/, '')
    return rel || p
  }
  return p
}

/** 简易 join：root + 相对路径（跟随 root 的分隔符风格） */
export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  const clean = rel.replace(/^[\\/]+/, '').replace(/\//g, sep)
  return `${root.replace(/[\\/]+$/, '')}${sep}${clean}`
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 编辑器语言名（用于状态栏展示） */
export function languageLabel(fileName: string): string {
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript JSX', js: 'JavaScript', jsx: 'JavaScript JSX',
    mjs: 'JavaScript', cjs: 'JavaScript', json: 'JSON', html: 'HTML', htm: 'HTML',
    css: 'CSS', scss: 'SCSS', less: 'Less', md: 'Markdown', py: 'Python',
    rs: 'Rust', vue: 'Vue', svelte: 'Svelte', go: 'Go', java: 'Java', yml: 'YAML', yaml: 'YAML',
    toml: 'TOML', sh: 'Shell', sql: 'SQL', txt: 'Plain Text',
  }
  return map[extOf(fileName)] ?? (extOf(fileName).toUpperCase() || 'Plain Text')
}
