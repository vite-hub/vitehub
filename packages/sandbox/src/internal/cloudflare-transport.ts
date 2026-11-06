import { sandboxErrorDiagnostics } from "../error-diagnostics.ts"
const retryDelays = [1_000, 2_000, 5_000, 10_000, 15_000]
const notStartedMessage = /container is starting|currently provisioning|retry in a moment|not listening in the tcp address|maximum number of running container instances exceeded|there is no container instance that can be provided to this durable object/i
const transientMessage = /network connection lost|durable object reset|code was updated|aborterror|aborted/i

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
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      return await withDeadline(operation, timeout, run, signal)
    }
    catch (error) {
      if (signal?.aborted) throw signal.reason
      const message = [error instanceof Error ? error.message : String(error), error instanceof Error && error.cause instanceof Error ? error.cause.message : ''].join('\n')
      const host = hostRetryFlags(error)
      if (attempt === retryDelays.length || !shouldRetry(options.idempotent, host, message))
        throw sandboxErrorDiagnostics.SANDBOX_R0088({ message: `[vitehub] Cloudflare Sandbox ${operation} failed: ${message.trim()}`, cause: error, retryable: host.retryable })
      await waitForRetry(retryDelays[attempt], signal)
    }
  }
  throw sandboxErrorDiagnostics.SANDBOX_R0089({ message: `[vitehub] Cloudflare Sandbox ${operation} retries exhausted.` })
}

function shouldRetry(idempotent: boolean, host: HostRetryFlags, message: string) {
  // Cloudflare: an overloaded Durable Object must not receive more requests.
  if (host.overloaded) return false
  // provider-message-match: Cloudflare has no flag for a Container that is not ready. The request never reached a process, so even a command can retry.
  if (notStartedMessage.test(message)) return true
  // A lost response can follow a started command, so only an idempotent request can retry.
  if (!idempotent) return false
  if (host.retryable !== undefined) return host.retryable
  // provider-message-match: Sandbox SDK errors can reach the Worker without a retryable flag.
  return transientMessage.test(message)
}

interface HostRetryFlags {
  overloaded: boolean
  retryable: boolean | undefined
}

/** Reads the Durable Object error flags from the error or its cause. */
function hostRetryFlags(error: unknown): HostRetryFlags {
  const errors = [error, errorProperty(error, "cause")]
  return {
    overloaded: errors.some(value => errorFlag(value, "overloaded") === true),
    retryable: errors.map(value => errorFlag(value, "retryable")).find(value => value !== undefined),
  }
}

function errorFlag(error: unknown, name: "overloaded" | "retryable") {
  const value = errorProperty(error, name)
  return typeof value === "boolean" ? value : undefined
}

function errorProperty(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null && name in error ? Reflect.get(error, name) : undefined
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
