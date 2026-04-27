export function randomId(prefix?: string): string {
  const body = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  return prefix ? `${prefix}_${body}` : body
}
