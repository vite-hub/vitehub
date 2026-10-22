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

/** Time that a drain gets after the budget ends to finish its abort, such as a restart notice. */
const settleMs = 15_000
/** Time that the server gets to close HTTP and run Nitro `close` hooks after the drains. */
const closeMs = 10_000
const signals: ShutdownSignal[] = ["SIGTERM", "SIGINT"]

function currentProcess(): ShutdownRuntime | undefined {
  const candidate = globalThis.process
  if (!candidate || typeof candidate.on !== "function" || typeof candidate.listeners !== "function") return undefined
  // SAFETY: the check above proves the event methods, and Node calls signal listeners with the signal name.
  return candidate as unknown as ShutdownRuntime
}

/** State for a host without `process`, such as a Cloudflare Worker without Node compatibility. */
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
    result = { durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), name: entry.name, status: "failed" }
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
    // A Nitro app that closes without a stop signal, such as a development reload, does not run again.
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
      // The host installs its stop listener on the next turn. Wait for that handoff
      // before draining so an early signal cannot bypass the HTTP/Nitro close path.
      await setup
      if (!serverListeners.length) {
        state.status = "running"
        // `stop` consumed the signal while the host handoff was pending. Restore the
        // platform's normal signal behavior once the temporary listener is removed.
        if (runtime.kill && typeof process !== "undefined" && typeof process.pid === "number")
          runtime.kill(process.pid, signal)
        return
      }
      const results = await runShutdownDrains(undefined, runtime)
      console.info("[vitehub]", JSON.stringify({ durationMs: Date.now() - startedAt, event: "shutdown.drained", results, signal, timestamp: new Date().toISOString() }))
      // Hooks run in order, so a hook added now runs after every other close hook.
      const closed = new Promise<void>((resolve) => { app.hooks.hook("close", () => resolve()) })
      const listeners = serverListeners.filter(([name]) => name === signal)
      const closeServer = Promise.all(listeners.map(([, listener]) => Promise.resolve().then(() => listener(signal)))).then(
        () => listeners.length ? closed : undefined,
        (error: unknown) => console.error("[vitehub] Server shutdown failed.", error),
      )
      await Promise.race([
        closeServer,
        new Promise((resolve) => { setTimeout(resolve, closeMs).unref?.() }),
      ])
      state.status = "exited"
      const exited = JSON.stringify({ durationMs: Date.now() - startedAt, event: "shutdown.exited", signal, timestamp: new Date().toISOString() })
      // Write the final record through the stream itself, then wait for its callback. This
      // preserves the record when stdout is piped, while the bound keeps a broken adapter
      // from preventing termination.
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
        // Give the event loop one turn after the stream acknowledges the write so consumers
        // reading a piped stdout receive the final record before the process exits.
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
  // The Nitro server adds its own stop listeners after the plugins run. A server that owns
  // stop signals, such as the srvx server of the Node, Bun, and Deno presets, adds them now.
  // ViteHub holds them until the drains settle, so HTTP stays up for the drain.
  setTimeout(() => {
    for (const signal of signals) {
      // The host installs one stop listener after the ViteHub plugins. Keep that
      // first handoff listener for the delayed close; later listeners belong to
      // applications or integrations and must retain their normal ordering.
      const candidates = runtime.listeners(signal).filter((listener): listener is (signal: ShutdownSignal) => unknown =>
        typeof listener === "function" && listener !== stop && !existing.get(signal)?.has(listener))
      // srvx exposes its graceful stop callback as `shutdown` (older presets use `stop`).
      // Match only these exact host contracts; application callbacks are never classified
      // by broad names or source text, and unmatched listeners retain normal ordering.
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
    // No server handles stop signals here: development, prerender, serverless functions, or
    // a server with graceful shutdown turned off. Keep the default signal behavior.
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
    // Node, Bun, and Deno report a Node release. Cloudflare Workers can polyfill `process`,
    // but they own the isolate lifecycle and do not allow timers during startup.
    if ((runtime.release?.name === "node" || runtime.release?.name === "bun") && globalThis.navigator?.userAgent !== "Cloudflare-Workers") installSignalTrap(app, runtime, state)
    else state.trap = "skipped"
  }
}
