export function readEnv(
  env: Record<string, string | undefined>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}
