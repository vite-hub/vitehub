import { hasRuntimeType, isRuntimeObject } from "./internal/runtime-type.ts"

/** Durable completion state for one observed version of a work item. */
export interface WorkCheckpoint {
  version: 1
  fingerprint: string
  disposition: "park" | "retry"
  attempt: number
  retryAt?: number
}
export interface WorkCheckpointStore {
  get(key: string): Promise<unknown>
  set(key: string, value: WorkCheckpoint): Promise<void>
}
export interface WorkOutcome {
  disposition: "park" | "retry"
  /** Use the newly observed version when the run changed the work item. */
  fingerprint?: string
}

/** Single-process ownership with durable park/retry state. Shared hosts need an external lease. */
export interface WorkTracker {
  readonly active: number
  has(key: string): boolean
  eligible(key: string, fingerprint: string): Promise<boolean>
  run(key: string, fingerprint: string, run: () => Promise<WorkOutcome>): Promise<boolean>
}

export function createWorkTracker(options: {
  store: WorkCheckpointStore
  retryMs?: number
  maxRetryMs?: number
  now?: () => number
}): WorkTracker {
  const retryMs = options.retryMs ?? 15 * 60_000
  const maxRetryMs = options.maxRetryMs ?? 6 * 60 * 60_000
  if (!Number.isFinite(retryMs) || retryMs <= 0 || !Number.isFinite(maxRetryMs) || maxRetryMs < retryMs) {
    throw new TypeError("Work retry intervals must be positive and maxRetryMs must be at least retryMs.")
  }
  const now = options.now ?? Date.now
  const active = new Set<string>()
  const fallback = new Map<string, WorkCheckpoint>()
  function checkpoint(value: unknown): WorkCheckpoint | undefined {
    if (!isRuntimeObject(value)) return
    // SAFETY: This untrusted checkpoint is returned only after validating every control field below.
    const state = value as WorkCheckpoint
    if (state.version !== 1 || !hasRuntimeType(state.fingerprint, "string")
      || !Number.isSafeInteger(state.attempt) || state.attempt < 0) return
    if (state.disposition === "park") return state
    if (state.disposition === "retry" && Number.isFinite(state.retryAt)) return state
  }
  async function read(key: string) {
    // A failed durable write must still cool down the job on this host.
    return fallback.get(key) ?? checkpoint(await options.store.get(key))
  }
  function eligible(state: WorkCheckpoint | undefined, fingerprint: string) {
    return !state || state.fingerprint !== fingerprint
      || state.disposition === "retry" && state.retryAt! <= now()
  }
  async function write(key: string, state: WorkCheckpoint) {
    fallback.set(key, state)
    await options.store.set(key, state)
    fallback.delete(key)
  }
  function retry(fingerprint: string, previous?: WorkCheckpoint): WorkCheckpoint {
    const attempt = previous?.fingerprint === fingerprint ? previous.attempt + 1 : 1
    return {
      version: 1, fingerprint, disposition: "retry", attempt,
      retryAt: now() + Math.min(retryMs * 2 ** Math.min(attempt - 1, 30), maxRetryMs),
    }
  }
  return {
    get active() { return active.size },
    has(key: string) { return active.has(key) },
    async eligible(key: string, fingerprint: string) {
      return !active.has(key) && eligible(await read(key), fingerprint)
    },
    async run(key: string, fingerprint: string, run: () => Promise<WorkOutcome>): Promise<boolean> {
      if (active.has(key)) return false
      active.add(key)
      try {
        const previous = await read(key)
        if (!eligible(previous, fingerprint)) return false
        let current = fingerprint
        try {
          const result = await run()
          if (result.disposition !== "park" && result.disposition !== "retry") throw new TypeError("Work must return a park or retry disposition.")
          current = result.fingerprint ?? fingerprint
          await write(key, result.disposition === "retry" ? retry(current, previous)
            : { version: 1, fingerprint: current, disposition: "park", attempt: 0 })
          return true
        }
        catch (error) {
          try { await write(key, retry(current, previous)) }
          catch (checkpointError) { throw new AggregateError([error, checkpointError], "Work failed and its retry checkpoint could not be persisted.") }
          throw error
        }
      }
      finally { active.delete(key) }
    },
  }
}
