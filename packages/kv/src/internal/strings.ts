export function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const out = value.trim()
  return out ? out : undefined
}
