import { invariantError } from "@vite-hub/internal/invariant"
import { sandboxErrorDiagnostics } from "../error-diagnostics.ts"
import { canRetryCloudflareRequest, cloudflareRetryDelays, readCloudflareFailure } from "./cloudflare-failure.ts"

export const cloudflareControlPlaneTimeout = 15_000
export const cloudflareExecTimeout = 180_000
export const cloudflareReadTimeout = 15_000
export const cloudflareStopTimeout = 10_000

export interface CloudflareRequestOptions {
  /**
   * True when a second call after a lost response has no other effect than the first.
   * Only these requests retry. A command or a new process must run at most once.
   */
  idempotent: boolean
  signal?: AbortSignal
  timeout: number
}

/**
 * Runs one Sandbox Durable Object request with a deadline.
 * A failure exposes the host's `retryable` flag as `error.data.retryable` and the host error as `cause`.
 */
export async function withCloudflareRequest<T>(operation: string, options: CloudflareRequestOptions, run: () => Promise<T>) {
  const { signal, timeout } = options
  signal?.throwIfAborted()
  for (let attempt = 0; attempt <= cloudflareRetryDelays.length; attempt++) {
    try {
      return await withDeadline(operation, timeout, run, signal)
    }
    catch (error) {
      if (signal?.aborted) throw signal.reason
      const failure = readCloudflareFailure(error)
      if (attempt === cloudflareRetryDelays.length || !canRetryCloudflareRequest(failure, options.idempotent))
        throw sandboxErrorDiagnostics.SANDBOX_R0088({ message: `[vitehub] Cloudflare Sandbox ${operation} failed: ${failure.message.trim()}`, cause: error, retryable: failure.retryable })
      await waitForRetry(cloudflareRetryDelays[attempt], signal)
    }
  }
  throw invariantError("the last Cloudflare Sandbox attempt returns or throws SANDBOX_R0088, so the retry loop never ends")
}

async function withDeadline<T>(operation: string, timeout: number, run: () => Promise<T>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(sandboxErrorDiagnostics.SANDBOX_R0090({ message: `[vitehub] Cloudflare Sandbox ${operation} timed out after ${timeout}ms.` })), timeout)
      }),
      ...(signal ? [new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
      })] : []),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
  }
}

async function waitForRetry(timeout: number, signal?: AbortSignal) {
  if (!signal) return await new Promise<void>(resolve => setTimeout(resolve, timeout))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, timeout)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
