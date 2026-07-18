import { runCloudflareOperation } from '../../../internal/shared/cloudflare-attempt'
import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE } from '../../../internal/shared/cloudflare-retry'
import { SandboxError } from '../../errors'

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

export function runCloudflareTransportOperation<T>(operation: string, timeout: number, run: () => Promise<T>) {
  return runCloudflareOperation({
    isRetriable: isRetriableCloudflareTransportError,
    mapError: error => error instanceof SandboxError ? error : createCloudflareTransportError(operation, error),
    operation,
    run,
    timeout,
  })
}

export function resolveExecRequestTimeout(timeout?: number) {
  if (typeof timeout === 'number' && timeout > 0)
    return Math.min(timeout, CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS)

  return CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS
}
