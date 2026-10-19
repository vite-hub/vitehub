/** A failed warm-up is tried again after this many milliseconds. */
export const agentWebhookWarmupRetryMs = 5_000

export interface AgentWebhookWarmupAgent {
  /** Milliseconds that the last warm-up attempt of this Agent took. */
  durationMs?: number
  error?: string
  status: "error" | "ready" | "warming"
}

/** The body of `/api/_vitehub/ready`. */
export interface AgentWebhookReadiness {
  agents: Record<string, AgentWebhookWarmupAgent>
  /** The error of the last failed attempt, while the process is not ready. */
  error?: string
  ready: boolean
  readyAt?: string
  /** Milliseconds until the next attempt after a failure. */
  retryMs?: number
  startedAt?: string
  status: "error" | "ready" | "warming"
}

export interface AgentWebhookWarmup {
  /** The current state, for a readiness route. */
  readiness(): AgentWebhookReadiness
  /** `200` with the readiness once every Agent is warm, `503` before. `HEAD` gets no body. */
  response(method?: string): Response
  /** Starts the warm-up, or returns the running one. A failed attempt is tried again after `retryMs`. */
  warm(): Promise<void>
}

/**
 * Runs the `warm()` of every Agent's webhook handler once, and reports when all of them are ready.
 * A failure keeps the process not ready and tries again, because the first delivery would fail the same way.
 * Logs `{ scope: "vitehub.agent.ready" }` once when the process is ready.
 */
export function createAgentWebhookWarmup(
  agents: Record<string, () => Promise<void>>,
  options: { retryMs?: number } = {},
): AgentWebhookWarmup {
  const retryMs = options.retryMs ?? agentWebhookWarmupRetryMs
  const states: Record<string, AgentWebhookWarmupAgent> = {}
  let error: string | undefined
  let running: Promise<void> | undefined
  let readyAt: string | undefined
  let startedAt: string | undefined

  const attempt = async () => {
    await Promise.all(Object.entries(agents).map(async ([name, warm]) => {
      const agentStartedAt = Date.now()
      states[name] = { status: "warming" }
      try {
        await warm()
        states[name] = { durationMs: Date.now() - agentStartedAt, status: "ready" }
      }
      catch (cause) {
        states[name] = { durationMs: Date.now() - agentStartedAt, error: cause instanceof Error ? cause.message : String(cause), status: "error" }
        throw cause
      }
    }))
    error = undefined
    readyAt = new Date().toISOString()
    console.info(JSON.stringify({ scope: "vitehub.agent.ready", agents: states, readyAt, startedAt }))
  }

  const warmup: AgentWebhookWarmup = {
    readiness() {
      const ready = readyAt !== undefined
      const failed = !ready && error !== undefined
      return {
        agents: { ...states },
        ...(failed ? { error, retryMs } : {}),
        ready,
        ...(readyAt ? { readyAt } : {}),
        ...(startedAt ? { startedAt } : {}),
        status: ready ? "ready" : failed ? "error" : "warming",
      }
    },
    response(method) {
      const readiness = warmup.readiness()
      return new Response(method === "HEAD" ? null : JSON.stringify(readiness), {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
        status: readiness.ready ? 200 : 503,
      })
    },
    warm() {
      if (running) return running
      startedAt ??= new Date().toISOString()
      running = attempt().catch((cause: unknown) => {
        error = cause instanceof Error ? cause.message : String(cause)
        console.error(`[vitehub] Webhook route warm-up failed. It is tried again in ${retryMs} ms.`, cause)
        const retry = setTimeout(() => {
          running = undefined
          void warmup.warm()
        }, retryMs)
        if (typeof retry === "object") retry.unref?.()
      })
      return running
    },
  }
  return warmup
}
