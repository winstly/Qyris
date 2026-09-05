export function uid(): string {
  return crypto.randomUUID()
}

export function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
