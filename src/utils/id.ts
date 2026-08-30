/** 轻量唯一 id（避免仅为 nanoid 增加依赖） */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
