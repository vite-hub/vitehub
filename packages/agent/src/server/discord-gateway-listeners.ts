import { agentDiagnostics } from "../agent-diagnostics.ts"

/** A failed Discord Gateway listener starts again after this many milliseconds. */
export const discordGatewayRetryMs = 5_000

/** One Discord Gateway listener run. It ends when the Gateway connection closes or `abortSignal` aborts. */
export type DiscordGatewayListener = (abortSignal: AbortSignal) => Promise<Response>

/**
 * Keeps one Discord Gateway listener per Agent running in a long-lived process. A listener that answers `204` has no
 * Gateway to listen to, such as a simulated Discord Channel, and does not run again. A failed listener logs the error
 * and runs again after `retryMs`. The returned function stops every listener.
 */
export function runDiscordGatewayListeners(
  listeners: Record<string, DiscordGatewayListener>,
  retryMs: number = discordGatewayRetryMs,
): () => Promise<void> {
  const controller = new AbortController()
  const running = Promise.all(Object.values(listeners).map(async (listen) => {
    while (!controller.signal.aborted) {
      try {
        const response = await listen(controller.signal)
        if (response.status === 204) return
        if (!response.ok) throw agentDiagnostics.AGENT_R0896({ message: `Discord Gateway listener failed with ${response.status}.` })
      }
      catch (error) {
        if (controller.signal.aborted) return
        console.error("[vitehub:agent] Discord Gateway listener failed and will retry.", error)
        await abortableDelay(retryMs, controller.signal)
      }
    }
  }))
  return async () => {
    controller.abort()
    await running
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}
