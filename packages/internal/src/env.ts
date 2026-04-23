export function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export function readEnv(
  env: Record<string, string | undefined>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = trimmed(env[name])
    if (value) {
      return value
    }
  }
}
