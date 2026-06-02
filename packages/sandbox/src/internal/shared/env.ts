export interface RuntimeEnv {
  [key: string]: string | undefined
}

export function readNonEmptyEnv(env: RuntimeEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const trimmed = env[key]?.trim()
    if (trimmed)
      return trimmed
  }
  return undefined
}
