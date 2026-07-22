import { getViteHubErrorShape, ViteHubError } from '@vite-hub/runtime'

export interface SandboxErrorMetadata {
  code?: `SANDBOX_${string}`
  provider?: string
  method?: string
  httpStatus?: number
  details?: Record<string, unknown>
  cause?: unknown
}

export function sandboxError(message: string, metadata: SandboxErrorMetadata = {}): ViteHubError<`SANDBOX_${string}`> {
  const { cause, code = 'SANDBOX_RUNTIME_ERROR', details, httpStatus, method, provider } = metadata
  return new ViteHubError(code, message, {
    cause,
    details: {
      ...(provider === undefined ? {} : { provider }),
      ...(method === undefined ? {} : { method }),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...details,
    },
  })
}

export function isSandboxError(value: unknown): value is ViteHubError<`SANDBOX_${string}`> {
  return getViteHubErrorShape(value)?.code.startsWith('SANDBOX_') === true
}
