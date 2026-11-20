/**
 * Graceful shutdown that ViteHub owns.
 *
 * Each package registers its drain once with `onShutdown()`. On a stop signal, ViteHub runs
 * every drain in parallel with one shared budget, then lets the server close HTTP, waits for
 * Nitro `close` hooks, and exits the process once.
 */

export type ShutdownSignal = "SIGINT" | "SIGTERM"

export interface ShutdownDrainContext {
  /** Aborts when the shared drain budget ends. */
  signal: AbortSignal
  /** The shared drain budget in milliseconds. */
  timeoutMs: number
}

/** Stops new work and waits for active work. It gets the shared budget and an abort signal. */
export type ShutdownDrain = (context: ShutdownDrainContext) => unknown

export interface ShutdownDrainResult {
  durationMs: number
  error?: string
  name: string
  status: "drained" | "failed" | "timeout"
}

export interface ShutdownDrainEntry {
  app: ShutdownApp
  drain: ShutdownDrain
  name: string
  result?: Promise<ShutdownDrainResult>
}

/**
 * Process-wide shutdown state, kept on `process.__vitehubShutdown`. Read it to see the
 * registered drains, the stop signal, and the drain results.
 */
export interface ShutdownState {
  /** Nitro apps that already run their drains from a `close` hook. */
  apps: WeakSet<ShutdownApp>
  entries: Set<ShutdownDrainEntry>
  results: ShutdownDrainResult[]
  signal?: ShutdownSignal
  /** `true` when ViteHub handles SIGTERM and SIGINT for this process. */
  signals: boolean
  status: "running" | "draining" | "exited"
  /** Set once the stop signal handler is installed or skipped. */
  trap?: "pending" | "installed" | "skipped"
}

/** The part of a Nitro app that the shutdown helper uses. */
export interface ShutdownApp {
  hooks: { hook(name: "close", callback: () => unknown): unknown }
}

/** The part of `process` that the shutdown helper uses. Tests pass a replacement. */
export interface ShutdownRuntime {
  __vitehubShutdown?: ShutdownState
  env: Record<string, string | undefined>
  exit(code: number): void
  kill?: (pid: number, signal: ShutdownSignal) => unknown
  listeners(signal: ShutdownSignal): unknown[]
  off(signal: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown
  on(signal: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown
  release?: { name?: string }
  stdout?: { write(chunk: string, callback: (error?: Error | null) => void): unknown }
}

/** Name of the variable that sets the shared drain budget in milliseconds. The default is 0. */
export const shutdownDrainEnv = "VITEHUB_SHUTDOWN_DRAIN_MS"

const settleMs = 15_000
const closeMs = 10_000
const signals: ShutdownSignal[] = ["SIGTERM", "SIGINT"]

function currentProcess(): ShutdownRuntime | undefined {
  const candidate = globalThis.process
  if (!candidate || typeof candidate.on !== "function" || typeof candidate.listeners !== "function") return undefined
  // SAFETY: the check above proves the event methods, and Node calls signal listeners with the signal name.
  return candidate as unknown as ShutdownRuntime
}

let isolateState: ShutdownState | undefined

/** Returns the shutdown state of this process. */
export function shutdownState(runtime: ShutdownRuntime | undefined = currentProcess()): ShutdownState {
  const create = (): ShutdownState => ({ apps: new WeakSet(), entries: new Set(), results: [], signals: false, status: "running" })
  if (!runtime) return isolateState ??= create()
  return runtime.__vitehubShutdown ??= create()
}

function drainBudget(runtime: ShutdownRuntime | undefined): number {
  const configured = Number(runtime?.env[shutdownDrainEnv])
  return Number.isFinite(configured) && configured > 0 ? configured : 0
}

function drainErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error)
  }
  catch {
    return "Unknown shutdown drain error."
  }
}

async function runEntry(entry: ShutdownDrainEntry, timeoutMs: number, state: ShutdownState): Promise<ShutdownDrainResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timers: ReturnType<typeof setTimeout>[] = []
  const later = (ms: number) => new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms)
    timer.unref?.()
    timers.push(timer)
  })
  void later(timeoutMs).then(() => controller.abort(new Error("Shutdown drain budget ended.")))
  let result: ShutdownDrainResult
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => entry.drain({ signal: controller.signal, timeoutMs })).then(() => "drained" as const),
      later(timeoutMs + settleMs),
    ])
    result = { durationMs: Date.now() - startedAt, name: entry.name, status: outcome }
  }
  catch (error) {
    result = { durationMs: Date.now() - startedAt, error: drainErrorMessage(error), name: entry.name, status: "failed" }
  }
  for (const timer of timers) clearTimeout(timer)
  controller.abort()
  state.results.push(result)
  return result
}

/**
 * Runs the drains that did not start yet, in parallel, with one shared budget. Pass an app to
 * run only the drains of that app. Each drain runs once, and a later call returns its result.
 */
export function runShutdownDrains(app?: ShutdownApp, runtime: ShutdownRuntime | undefined = currentProcess()): Promise<ShutdownDrainResult[]> {
  const state = shutdownState(runtime)
  const timeoutMs = drainBudget(runtime)
  const entries = [...state.entries].filter(entry => !app || entry.app === app)
  return Promise.all(entries.map(entry => entry.result ??= runEntry(entry, timeoutMs, state).finally(() => {
    if (state.status === "running") state.entries.delete(entry)
  })))
}

function installSignalTrap(app: ShutdownApp, runtime: ShutdownRuntime, state: ShutdownState): void {
  state.trap = "pending"
  const existing = new Map(signals.map(signal => [signal, new Set(runtime.listeners(signal))]))
  const serverListeners: [ShutdownSignal, (signal: ShutdownSignal) => unknown][] = []
  let resolveSetup!: () => void
  const setup = new Promise<void>(resolve => { resolveSetup = resolve })
  const stop = (signal: ShutdownSignal) => {
    if (state.status !== "running") return
    state.status = "draining"
    state.signal = signal
    const startedAt = Date.now()
    const names = [...state.entries].map(entry => entry.name)
    console.info("[vitehub]", JSON.stringify({ drainMs: drainBudget(runtime), drains: names, event: "shutdown.draining", signal, timestamp: new Date().toISOString() }))
    void (async () => {
      await setup
      if (!serverListeners.length) {
        state.status = "running"
        if (runtime.kill && typeof process !== "undefined" && typeof process.pid === "number")
          runtime.kill(process.pid, signal)
        return
      }
      const results = await runShutdownDrains(undefined, runtime)
      console.info("[vitehub]", JSON.stringify({ durationMs: Date.now() - startedAt, event: "shutdown.drained", results, signal, timestamp: new Date().toISOString() }))
      const listeners = serverListeners.filter(([name]) => name === signal)
      const closeServer = Promise.all(listeners.map(([, listener]) => Promise.resolve().then(() => listener(signal)))).then(
        () => undefined,
        (error: unknown) => console.error("[vitehub] Server shutdown failed.", error),
      )
      await Promise.race([
        closeServer,
        new Promise((resolve) => { setTimeout(resolve, closeMs).unref?.() }),
      ])
      state.status = "exited"
      const exited = JSON.stringify({ durationMs: Date.now() - startedAt, event: "shutdown.exited", signal, timestamp: new Date().toISOString() })
      if (runtime.stdout) {
        await new Promise<void>(resolve => {
          let settled = false
          const finish = (error?: Error | null) => {
            if (settled) return
            settled = true
            if (error) console.error("[vitehub] Failed to flush shutdown output.", error)
            resolve()
          }
          const timer = setTimeout(finish, 1_000)
          timer.unref?.()
          runtime.stdout!.write(`[vitehub] ${exited}\n`, error => {
            clearTimeout(timer)
            finish(error)
          })
        })
        await new Promise<void>(resolve => setImmediate(resolve))
      } else console.info("[vitehub]", exited)
      runtime.exit(0)
    })().catch((error: unknown) => {
      console.error("[vitehub] Shutdown failed.", error)
      state.status = "exited"
      runtime.exit(1)
    })
  }
  for (const signal of signals) runtime.on(signal, stop)
  setTimeout(() => {
    for (const signal of signals) {
      const candidates = runtime.listeners(signal).filter((listener): listener is (signal: ShutdownSignal) => unknown =>
        typeof listener === "function" && listener !== stop && !existing.get(signal)?.has(listener))
      const server = candidates.find(listener => listener.name === "shutdown" || listener.name === "stop")
      if (server) {
        // SAFETY: the check above proves the listener is callable, and Node calls signal listeners with the signal name.
        const handler = server as (signal: ShutdownSignal) => void
        runtime.off(signal, handler)
        serverListeners.push([signal, handler])
      }
    }
    if (serverListeners.length) {
      state.trap = "installed"
      state.signals = true
      resolveSetup()
      return
    }
    for (const signal of signals) runtime.off(signal, stop)
    state.trap = "skipped"
    resolveSetup()
  }, 0)
}

/**
 * Registers a drain that ViteHub runs once when the host stops.
 *
 * The drain runs when a server that owns stop signals gets SIGTERM or SIGINT, or when the
 * Nitro app closes. All drains share the budget in `VITEHUB_SHUTDOWN_DRAIN_MS`.
 */
export function onShutdown(app: ShutdownApp, name: string, drain: ShutdownDrain, runtime: ShutdownRuntime | undefined = currentProcess()): void {
  const state = shutdownState(runtime)
  state.entries.add({ app, drain, name })
  if (!state.apps.has(app)) {
    state.apps.add(app)
    app.hooks.hook("close", () => runShutdownDrains(app, runtime))
  }
  if (runtime && !state.trap) {
    if ((runtime.release?.name === "node" || runtime.release?.name === "bun") && globalThis.navigator?.userAgent !== "Cloudflare-Workers") installSignalTrap(app, runtime, state)
    else state.trap = "skipped"
  }
}
