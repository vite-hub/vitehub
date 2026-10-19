import type { DrainInlineChatInvocationsResult } from "../server/routes.ts"

export type ProcessStopSignal = "SIGINT" | "SIGTERM"

/**
 * Stop handlers that share one process put their drain here. Each handler waits until every
 * registered drain settles, and only the first handler that gets there exits. The record is
 * kept on `process`, so `process.__vitehubShutdown` shows the drains that run.
 */
export interface ProcessShutdownDrains {
  drains: Set<Promise<unknown>>
  exited: boolean
}

/** The part of `process` that the generated Agent shutdown drain uses. Tests pass a replacement. */
export interface AgentShutdownRuntime {
  __vitehubShutdown?: ProcessShutdownDrains
  env: Record<string, string | undefined>
  exit(code: number): void
  listeners(signal: ProcessStopSignal): unknown[]
  on(signal: ProcessStopSignal, listener: (signal: ProcessStopSignal) => void): unknown
}

export interface AgentShutdownDrainWork {
  /** Drain inline Chat invocations, usually `drainInlineChatInvocations`. */
  chat(options: { timeoutMs: number }): Promise<DrainInlineChatInvocationsResult>
  /** Stop the webhook queues and wait for them, with the budget the queue reads from the env. */
  queues(): Promise<unknown>
}

/**
 * Installs the SIGTERM and SIGINT drain of the generated webhook queue plugin on a Node host.
 *
 * On the first signal it drains inline Chat invocations and stops the webhook queues in
 * parallel. Both use `VITEHUB_SHUTDOWN_DRAIN_MS`; `defaultDrainMs` only sets the variable
 * when it is empty, so the queue, which reads the variable itself, uses the same budget.
 * When the server's `shutdown` listener closes HTTP, the drain also waits up to 10 seconds
 * for Nitro's close hooks. Then it waits for other registered drains, such as a process
 * host, and exits once.
 *
 * The listeners are added after the first timer and then the next check phase. At that
 * point srvx has added its listeners, and a process host stop handler has already taken
 * the listeners that were added during startup, so it cannot hold this drain back.
 *
 * The plugin generator emits this function with `Function.prototype.toString()`,
 * so it must use only its parameters and JavaScript globals.
 */
export function installAgentShutdownDrain(
  work: AgentShutdownDrainWork,
  app: { hooks: { hook(name: "close", callback: () => void): unknown } },
  defaultDrainMs: number | undefined,
  runtime: AgentShutdownRuntime,
): void {
  if (defaultDrainMs !== undefined && !runtime.env.VITEHUB_SHUTDOWN_DRAIN_MS)
    runtime.env.VITEHUB_SHUTDOWN_DRAIN_MS = String(defaultDrainMs)
  const shutdown = (runtime.__vitehubShutdown ??= { drains: new Set(), exited: false })
  let draining: Promise<void> | undefined
  const stop = (signal: ProcessStopSignal) => {
    if (draining) return
    const configured = Number(runtime.env.VITEHUB_SHUTDOWN_DRAIN_MS)
    const drainMs = Number.isFinite(configured) && configured > 0 ? configured : 0
    const startedAt = Date.now()
    // srvx closes HTTP from its `shutdown` listener, and Nitro calls the close hooks after that.
    // Hooks run in order, so a hook added now runs after every other close hook.
    const closed = new Promise<void>((resolve) => { app.hooks.hook("close", () => resolve()) })
    console.info("[vitehub]", JSON.stringify({ event: "agent.shutdown.draining", drainMs, signal, timestamp: new Date().toISOString() }))
    draining = (async () => {
      const [chat] = await Promise.all([work.chat({ timeoutMs: drainMs }), work.queues()])
      if (closed) await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 10_000).unref())])
      console.info("[vitehub]", JSON.stringify({ event: "agent.shutdown.drained", chat, durationMs: Date.now() - startedAt, signal, timestamp: new Date().toISOString() }))
    })().catch((error: unknown) => console.error("[vitehub] Agent shutdown drain failed.", error))
    shutdown.drains.add(draining)
    void (async () => {
      let settled = -1
      while (settled !== shutdown.drains.size) {
        settled = shutdown.drains.size
        await Promise.allSettled(shutdown.drains)
      }
      if (shutdown.exited) return
      shutdown.exited = true
      runtime.exit(0)
    })()
  }
  ;(stop as typeof stop & { __vitehubAgentDrain?: boolean }).__vitehubAgentDrain = true
  const signals: ProcessStopSignal[] = ["SIGTERM", "SIGINT"]
  for (const signal of signals) runtime.on(signal, stop)
}
