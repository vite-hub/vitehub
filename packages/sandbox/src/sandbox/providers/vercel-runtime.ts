export const VERCEL_SANDBOX_RUNTIMES = ['node22', 'node24'] as const

export type VercelSandboxRuntime = (typeof VERCEL_SANDBOX_RUNTIMES)[number]

export function normalizeVercelSandboxRuntime(runtime?: string) {
  if (!runtime)
    return 'node24' satisfies VercelSandboxRuntime

  return runtime
}

export function isSupportedVercelSandboxRuntime(runtime: string): runtime is VercelSandboxRuntime {
  return VERCEL_SANDBOX_RUNTIMES.includes(runtime as VercelSandboxRuntime)
}
