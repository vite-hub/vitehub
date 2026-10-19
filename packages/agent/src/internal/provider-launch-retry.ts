import { getViteHubErrorShape } from "@vite-hub/runtime"

/** Waits before each new launch. Two retries cover a provider that fails to open its local state once. */
export const providerLaunchRetryDelaysMs: readonly number[] = [2_000, 8_000]

function isProviderLaunchFailure(error: unknown): boolean {
  const shape = getViteHubErrorShape(error)
  return shape?.code === "PROVIDER_LAUNCH_FAILED" && shape.details?.phase === "launch"
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, delayMs)
    signal?.addEventListener("abort", done, { once: true })
  })
}

/**
 * Launch the provider again when its process exits before the first event. Such a provider did no
 * work, so a new launch is safe. A failure after the first event belongs to the turn and is not
 * retried. An aborted invocation is never launched again.
 */
export async function* retryProviderLaunch<T>(
  launch: () => AsyncIterable<T>,
  signal: AbortSignal | undefined,
  delaysMs: readonly number[],
): AsyncGenerator<T> {
  for (let attempt = 0; ; attempt++) {
    let started = false
    try {
      for await (const event of launch()) {
        started = true
        yield event
      }
      return
    }
    catch (error) {
      const delayMs = delaysMs[attempt]
      if (started || delayMs === undefined || signal?.aborted || !isProviderLaunchFailure(error)) throw error
      console.warn(`[vitehub] Provider launch failed; launching again in ${delayMs} ms (attempt ${attempt + 2} of ${delaysMs.length + 1}).`, getViteHubErrorShape(error)?.details?.stderr ?? error)
      await waitForRetry(delayMs, signal)
      if (signal?.aborted) throw signal.reason ?? new DOMException("[vitehub] Provider launch retry aborted.", "AbortError")
    }
  }
}
