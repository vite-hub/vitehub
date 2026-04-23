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

export function readFrameworkEnv(
  env: RuntimeEnv,
  options: {
    plain?: string[]
    vite?: string[]
    nitro?: string[]
    nuxt?: string[]
  },
): string | undefined {
  return readNonEmptyEnv(
    env,
    ...(options.nitro || []),
    ...(options.nuxt || []),
    ...(options.vite || []),
    ...(options.plain || []),
  )
}
