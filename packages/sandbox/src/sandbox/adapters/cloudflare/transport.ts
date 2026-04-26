import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS } from '../../../internal/shared/cloudflare-retry'
import { SandboxError } from '../../errors'
import { sleep } from '../_shared'

export const CLOUDFLARE_CONTROL_PLANE_TIMEOUT_MS = 15_000
export const CLOUDFLARE_READ_FILE_TIMEOUT_MS = 15_000
export const CLOUDFLARE_STOP_TIMEOUT_MS = 10_000
export const CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS = 180_000

export function createCloudflareTransportError(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return new SandboxError(message, {
    cause: error,
    code: 'SANDBOX_TRANSPORT_ERROR',
    details: { operation },
    provider: 'cloudflare',
  })
}

export function isRetriableCloudflareTransportError(error: unknown) {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (sandboxError?.code === 'TIMEOUT')
    return true
  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(message)
}

export async function withCloudflareDeadline<T>(operation: string, timeoutMs: number, run: () => Promise<T>) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new SandboxError(`Cloudflare sandbox ${operation} timed out after ${timeoutMs}ms.`, {
            code: 'TIMEOUT',
            details: { operation, timeout: timeoutMs },
            provider: 'cloudflare',
          }))
        }, timeoutMs)
      }),
    ])
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
  }
}

export async function withCloudflareTransportRetry<T>(operation: string, run: () => Promise<T>) {
  const attempts = CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length + 1

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run()
    }
    catch (error) {
      const sandboxError = error instanceof SandboxError
        ? error
        : createCloudflareTransportError(operation, error)

      const shouldRetry = attempt < CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length
        && isRetriableCloudflareTransportError(sandboxError)

      if (!shouldRetry)
        throw sandboxError

      await sleep(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt])
    }
  }

  throw new SandboxError(`Cloudflare sandbox ${operation} retries exhausted.`, {
    code: 'SANDBOX_TRANSPORT_ERROR',
    details: { operation },
    provider: 'cloudflare',
  })
}

export function resolveExecRequestTimeout(timeout?: number) {
  if (typeof timeout === 'number' && timeout > 0)
    return Math.min(timeout, CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS)

  return CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS
}
