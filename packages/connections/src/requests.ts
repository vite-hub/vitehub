import type { ConnectionRequestPolicy } from "./types.ts"

const DEFAULT_ATTEMPTS = 3
const DEFAULT_DELAY_MS = 250
const DEFAULT_METHODS = ["GET", "HEAD", "OPTIONS"]

/** One request schedule and one 429 pause, shared by every Connection in the bucket. */
interface Bucket {
  /** The fixed pacing interval for this bucket. */
  intervalMs?: number
  /** The earliest start of the next request. */
  nextAt: number
  /** No request in the bucket starts before this time, after a 429. */
  pausedUntil: number
}

/** A Connection's `requests` policy with its defaults applied. */
export interface ResolvedRequestPolicy {
  attempts: number
  bucket: Bucket
  delayMs: number
  intervalMs: number
  methods: readonly string[]
  minPauseMs: number
  retry: boolean
  timeoutMs?: number
}

export type RequestScheduler = ReturnType<typeof createRequestScheduler>

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** `Retry-After` in milliseconds. It is a number of seconds or an HTTP date. */
function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after")?.trim()
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Pace, retry, and time out provider requests by the provider `requests` policy.
 * Connections with the same `bucket` share one request schedule and one 429 pause.
 * One scheduler belongs to one Connections runtime.
 */
export function createRequestScheduler() {
  const buckets = new Map<string, Bucket>()

  function resolve(name: string, requests: ConnectionRequestPolicy): ResolvedRequestPolicy {
    const key = requests.bucket ?? name
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, bucket = { nextAt: 0, pausedUntil: 0 })
    const intervalMs = !requests.rate ? 0 : "intervalMs" in requests.rate ? requests.rate.intervalMs : requests.rate.perMs / requests.rate.limit
    if (bucket.intervalMs === undefined) bucket.intervalMs = intervalMs
    else if (Math.abs(bucket.intervalMs - intervalMs) > Number.EPSILON * Math.max(1, Math.abs(bucket.intervalMs), Math.abs(intervalMs)) * 8) {
      throw new Error(`Connections sharing request bucket "${key}" must use the same rate interval.`)
    }
    const retry = requests.retry
    return {
      attempts: retry ? retry.attempts ?? DEFAULT_ATTEMPTS : 1,
      bucket,
      delayMs: retry?.delayMs ?? DEFAULT_DELAY_MS,
      intervalMs: bucket.intervalMs,
      methods: (retry?.methods ?? DEFAULT_METHODS).map(method => method.toUpperCase()),
      minPauseMs: retry?.on429?.minDelayMs ?? 0,
      retry: retry !== undefined,
      timeoutMs: requests.timeoutMs,
    }
  }

  /** Wait for a start slot. A 429 that arrives while this request waits moves it after the pause. */
  async function slot(policy: ResolvedRequestPolicy, signal: AbortSignal | undefined): Promise<void> {
    const { bucket } = policy
    for (;;) {
      signal?.throwIfAborted()
      const now = Date.now()
      const start = Math.max(now, bucket.nextAt, bucket.pausedUntil)
      bucket.nextAt = start + policy.intervalMs
      await sleep(start - now, signal)
      if (Date.now() >= bucket.pausedUntil) return
    }
  }

  /** Run one attempt. `timeoutMs` aborts it, also while the caller reads the body. */
  async function attempt(policy: ResolvedRequestPolicy, init: RequestInit, dispatch: (init: RequestInit) => Promise<Response>): Promise<{ response: Response, stop: () => void }> {
    if (policy.timeoutMs === undefined) return { response: await dispatch(init), stop: () => undefined }
    const timeout = new AbortController()
    const ms = policy.timeoutMs
    const timer = setTimeout(() => timeout.abort(new DOMException(`The provider request timed out after ${ms} ms.`, "TimeoutError")), ms)
    // Do not keep a Node process alive only for the timer of a finished request.
    if (typeof timer === "object" && "unref" in timer) timer.unref()
    const stop = () => clearTimeout(timer)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal
    try {
      const response = await dispatch({ ...init, signal })
      if (!response.body) {
        stop()
        return { response, stop: () => undefined }
      }
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              stop()
              controller.close()
            }
            else controller.enqueue(chunk.value)
          }
          catch (error) {
            stop()
            controller.error(error)
          }
        },
        async cancel(reason) {
          stop()
          await reader.cancel(reason)
        },
      })
      return { response: new Response(body, response), stop }
    }
    catch (error) {
      stop()
      throw error
    }
  }

  /**
   * Send one request by the policy. A 429 pauses the whole bucket for `Retry-After`, at least
   * `retry.on429.minDelayMs`, and is retried for every method. Network errors and 5xx responses
   * are retried only for `retry.methods`, with exponential backoff. The last attempt returns its
   * response as is. A caller abort stops at once and is not retried.
   */
  async function send(policy: ResolvedRequestPolicy, init: RequestInit, dispatch: (init: RequestInit) => Promise<Response>): Promise<Response> {
    const signal = init.signal ?? undefined
    const retryable = policy.methods.includes((init.method ?? "GET").toUpperCase())
    for (let count = 1; ; count += 1) {
      await slot(policy, signal)
      const last = count >= policy.attempts
      const backoff = policy.delayMs * 2 ** (count - 1)
      let result: Awaited<ReturnType<typeof attempt>>
      try {
        result = await attempt(policy, init, dispatch)
      }
      catch (error) {
        signal?.throwIfAborted()
        if (last || !retryable) throw error
        await sleep(backoff, signal)
        continue
      }
      const { response, stop } = result
      if (response.status === 429) {
        const pause = Math.max(policy.minPauseMs, retryAfterMs(response) || (policy.retry ? backoff : 0))
        policy.bucket.pausedUntil = Math.max(policy.bucket.pausedUntil, Date.now() + pause)
        if (last) return response
      }
      else if (last || !retryable || response.status < 500) {
        return response
      }
      stop()
      await discard(response)
      if (response.status !== 429) await sleep(backoff, signal)
    }
  }

  return { resolve, send }
}
