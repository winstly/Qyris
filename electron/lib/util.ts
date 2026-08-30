/** 统一把 unknown 错误转成可展示信息（对应 Rust 的 `{e}` Display 插值位） */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
