import { syncErrors } from "../errors.ts"
import { syncPushLimit } from "../protocol.ts"
import { applyQueueChange, applyRowChange } from "./storage.ts"
import { SyncError } from "./types.ts"
import { backoffDelay, clientError, failScope, keyColumnOf, pullChange, pushChange, randomUUID, readError, replayWrites, toMutation, toWireError } from "./view.ts"

import type { SyncKey, SyncPullResponse, SyncPushRequest, SyncPushResponse, SyncRow } from "../protocol.ts"
import type { SyncEnvironment } from "./environment.ts"
import type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorage, SyncStorageChange } from "./storage.ts"
import type { SyncFailure, SyncState, SyncStatus, SyncStore, SyncWrite } from "./types.ts"

interface SyncStoreOptions {
  /** The Sync route, such as `/api/_vitehub/sync/todos`. It also names the stored copy. */
  url: string
  fetch: typeof fetch
  storage: SyncStorage
  environment: SyncEnvironment
  interval: number | false
}

/** A store that `clearSync()` can empty. */
interface SyncStoreWithReset<TRow> extends SyncStore<TRow> {
  /** Forgets the rows and the queue in memory, and rejects the writes that wait. */
  forget: () => void
}

type Answer = { ok: true, body: unknown } | { ok: false, error: SyncError }

interface PendingWrite {
  key: SyncKey
  settle: (state: "applied" | "rejected", value: unknown) => void
}

function isRetryable(error: SyncError): boolean {
  return error.code === "SYNC_NETWORK" || error.code === "SYNC_SERVER_ERROR"
}

function isPull(value: unknown): value is SyncPullResponse {
  if (!value || typeof value !== "object") return false
  const scope: unknown = Reflect.get(value, "scope")
  return typeof Reflect.get(value, "key") === "string"
    && typeof Reflect.get(value, "cursor") === "number"
    && Array.isArray(Reflect.get(value, "rows"))
    && Array.isArray(Reflect.get(value, "deleted"))
    && Boolean(scope) && typeof scope === "object" && typeof Reflect.get(scope as object, "id") === "string"
}

function isPush(value: unknown): value is SyncPushResponse {
  return Boolean(value) && typeof value === "object" && Array.isArray(Reflect.get(value as object, "results")) && isPull(Reflect.get(value as object, "pull"))
}

/** A short text that changes when the stored meta or outbox differs from the copy in memory. */
function queueSignature(meta: SyncMeta | undefined, writes: readonly SyncQueuedWrite[]): string {
  return `${meta?.scope.id}:${meta?.cursor}:${writes.map(write => `${write.seq}${write.scope ?? ""}${write.error ? "!" : ""}`).join(",")}`
}

function isUnchanged(meta: SyncMeta | undefined, change: SyncStorageChange): boolean {
  return Boolean(meta && change.meta)
    && meta!.cursor === change.meta!.cursor
    && meta!.key === change.meta!.key
    && meta!.scope.id === change.meta!.scope.id
    && !change.reset
    && !change.put?.length && !change.delete?.length && !change.add?.length && !change.update?.length && !change.remove?.length
}

/** Thrown inside a round that `forget()` ended, so it writes nothing more. */
const cancelled = new Error("The Sync round was cancelled.")

/** A `SyncWrite` over `promise`. A write that nobody awaits must not report an unhandled rejection. */
function thenable<TRow>(key: SyncKey, promise: Promise<TRow | undefined>, state: () => SyncWrite<TRow>["state"]): SyncWrite<TRow> {
  promise.catch(() => undefined)
  return {
    key,
    get state() {
      return state()
    },
    // oxlint-disable-next-line unicorn/no-thenable -- A write is awaitable by design, and awaiting it is optional.
    then: (onfulfilled, onrejected) => promise.then(onfulfilled, onrejected),
  }
}

function freezeRow(row: SyncRow): SyncRow {
  return Object.isFrozen(row) ? row : Object.freeze(row)
}

/**
 * The Sync client of one route. It reads the stored copy, pulls, and sends the outbox in order, one push at a time.
 * Every write goes to storage before it is sent.
 */
function createSyncStore<TRow>(name: string, options: SyncStoreOptions): SyncStoreWithReset<TRow> {
  const { url: id, storage, environment } = options
  const listeners = new Set<() => void>()
  const pending = new Map<string, PendingWrite>()
  const failureCache = new WeakMap<SyncQueuedWrite, SyncFailure>()

  let meta: SyncMeta | undefined
  let confirmed = new Map<SyncKey, SyncRow>()
  let writes: SyncQueuedWrite[] = []
  // Writes that wait for the storage. They show in the rows, and the next pass sends them once they are stored.
  let local: SyncNewWrite[] = []
  let view: ReadonlyMap<SyncKey, SyncRow> = confirmed
  // `idle` until the stored copy is read, as on the server, so a server-rendered page hydrates without a mismatch.
  let status: SyncStatus = "idle"
  let loaded = false
  let error: SyncError | null = null
  let state: SyncState<SyncRow>

  // Each change in memory moves `version`, so a storage read that started before it does not overwrite it.
  let version = 0
  // `forget()` moves `generation`, so a write that was stored before it does not come back.
  let generation = 0
  let passGeneration = 0
  let destroyed = false
  let wantPull = true
  let attempt = 0
  let cancelRetry: (() => void) | undefined
  let cancelTick: (() => void) | undefined
  let running: Promise<void> | undefined
  let again = false

  function publish(): void {
    view = replayWrites(confirmed, [...writes, ...local], meta)
    const failures: SyncFailure[] = []
    let queued = local.length
    for (const write of writes) {
      if (!write.error) {
        queued++
        continue
      }
      let failure = failureCache.get(write)
      if (!failure) failureCache.set(write, failure = Object.freeze({ key: write.key, mutation: toMutation(write, meta), error: write.error }))
      failures.push(failure)
    }
    state = Object.freeze({
      rows: Object.freeze([...view.values()].map(freezeRow)),
      status,
      error,
      queued,
      failures: Object.freeze(failures),
      persisted: loaded && storage.persisted,
    })
    settlePending()
    for (const listener of listeners) listener()
  }

  function settlePending(): void {
    if (!pending.size) return
    const stored = new Map(writes.map(write => [write.id, write]))
    const waiting = new Set(local.map(write => write.id))
    for (const [mutationId, write] of pending) {
      if (waiting.has(mutationId)) continue
      const queued = stored.get(mutationId)
      if (queued?.error) {
        pending.delete(mutationId)
        write.settle("rejected", new SyncError(queued.error.code, queued.error.message, queued.error.issues ? { issues: queued.error.issues } : {}))
      }
      else if (!queued) {
        pending.delete(mutationId)
        write.settle("applied", confirmed.get(write.key))
      }
    }
  }

  function rejectPending(reason: SyncError): void {
    for (const write of pending.values()) write.settle("rejected", reason)
    pending.clear()
  }

  function track(write: SyncNewWrite): SyncWrite<TRow> {
    let current: SyncWrite<TRow>["state"] = "queued"
    let settle!: PendingWrite["settle"]
    const promise = new Promise<TRow | undefined>((resolve, reject) => {
      settle = (next, value) => {
        current = next
        // SAFETY: the store holds rows of `TRow` as plain JSON rows.
        if (next === "applied") resolve(value as TRow | undefined)
        else reject(value)
      }
    })
    pending.set(write.id, { key: write.key, settle })
    return thenable(write.key, promise, () => current)
  }

  function refused(key: SyncKey, reason: SyncError): SyncWrite<TRow> {
    return thenable(key, Promise.reject(reason), () => "rejected")
  }

  function assertOpen(): void {
    if (destroyed) throw syncErrors.SYNC_STORE_DESTROYED({ name })
  }

  /** Shows `write` at once, stores it, then sends it. `replaces` is a refused write that it takes the place of. */
  function enqueue(write: SyncNewWrite, replaces?: SyncQueuedWrite): SyncWrite<TRow> {
    assertOpen()
    const handle = track(write)
    if (replaces) writes = writes.filter(item => item !== replaces)
    local.push(write)
    version++
    publish()
    const at = generation
    storage.write(id, { add: [write], ...(replaces ? { remove: [replaces.seq] } : {}) }).then(([seq]) => {
      if (at !== generation) return
      local = local.filter(item => item !== write)
      if (!writes.some(item => item.id === write.id)) writes = [...writes, { ...write, seq: seq! }]
      version++
      publish()
      environment.post({ type: "change", id })
      void schedule(false)
    }, (cause: unknown) => {
      if (at !== generation) return
      local = local.filter(item => item !== write)
      version++
      const reason = new SyncError("SYNC_BAD_REQUEST", `The browser could not store the write: ${cause instanceof Error ? cause.message : String(cause)}`)
      pending.get(write.id)?.settle("rejected", reason)
      pending.delete(write.id)
      publish()
    })
    return handle
  }

  /** Writes `change` to storage, then to memory, and tells the other tabs. A round that `forget()` ended stops here. */
  async function commit(change: SyncStorageChange): Promise<void> {
    if (passGeneration !== generation) throw cancelled
    // A pull that brought nothing keeps the same state object, so a view does not render again for it.
    if (isUnchanged(meta, change)) {
      if (state.status !== status || state.error !== error) publish()
      return
    }
    await storage.write(id, change)
    if (passGeneration !== generation) throw cancelled
    meta = change.meta ?? meta
    confirmed = applyRowChange(confirmed, change)
    writes = applyQueueChange(writes, change, [])
    version++
    publish()
    environment.post({ type: "change", id })
  }

  /** Reads the stored copy again, such as after another tab changed it. */
  async function reload(): Promise<void> {
    for (;;) {
      const at = version
      const stored = await storage.read(id)
      if (destroyed) return
      if (at !== version) continue
      meta = stored.meta
      confirmed = new Map(stored.rows)
      writes = stored.writes
      local = local.filter(write => !writes.some(item => item.id === write.id))
      loaded = true
      if (status === "idle") status = "loading"
      version++
      publish()
      return
    }
  }

  function fail(reason: SyncError): false {
    error = reason
    status = reason.code === "SYNC_NETWORK" ? "offline" : "error"
    wantPull = true
    if (isRetryable(reason)) {
      cancelRetry?.()
      cancelRetry = environment.schedule(() => {
        cancelRetry = undefined
        void schedule(true)
      }, backoffDelay(attempt++, environment.random()))
    }
    publish()
    return false
  }

  function recover(): void {
    status = "ready"
    error = null
    attempt = 0
  }

  async function request(input: string, init: RequestInit): Promise<Answer> {
    let response: Response
    try {
      response = await options.fetch(input, { ...init, cache: "no-store" })
    }
    catch {
      return { ok: false, error: clientError(syncErrors.SYNC_NETWORK()) }
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) return { ok: false, error: readError(response.status, body) }
    return { ok: true, body }
  }

  async function pull(): Promise<boolean> {
    for (;;) {
      const query = meta ? `?${new URLSearchParams({ cursor: String(meta.cursor), scope: meta.scope.id })}` : ""
      const answer = await request(`${id}${query}`, { method: "GET", headers: { accept: "application/json" } })
      if (!answer.ok) return fail(answer.error)
      if (!isPull(answer.body)) return fail(clientError(syncErrors.SYNC_SERVER_ERROR({ message: "The Sync route answered without a pull." })))
      recover()
      await commit(pullChange(meta, answer.body, writes))
      if (!answer.body.more) return true
    }
  }

  async function push(scopeMeta: SyncMeta, sent: SyncQueuedWrite[]): Promise<boolean> {
    const body: SyncPushRequest = { scope: scopeMeta.scope.id, cursor: scopeMeta.cursor, mutations: sent.map(write => toMutation(write, scopeMeta)) }
    const answer = await request(id, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
    if (!answer.ok) {
      const reason = answer.error
      if (reason.code === "SYNC_SCOPE_CHANGED") {
        // The session belongs to someone else now. These writes must never reach the server with it.
        await commit({ update: failScope(writes.filter(write => !write.error && write.scope === body.scope)) })
        wantPull = true
        return true
      }
      if (isRetryable(reason) || reason.code === "SYNC_UNAUTHORIZED" || reason.code === "SYNC_FORBIDDEN") return fail(reason)
      // The server refused the request itself, so sending it again gives the same answer.
      await commit({ update: sent.map(write => ({ ...write, error: toWireError(reason) })) })
      return true
    }
    if (!isPush(answer.body)) return fail(clientError(syncErrors.SYNC_SERVER_ERROR({ message: "The Sync route answered without results." })))
    const settled = pushChange(sent, answer.body.results)
    if (!settled.remove.length && !settled.update.length) return fail(clientError(syncErrors.SYNC_SERVER_ERROR({ message: "The Sync route answered without a result for the writes." })))
    recover()
    const sentIds = new Set(sent.map(write => write.id))
    const pulled = pullChange(meta, answer.body.pull, writes.filter(write => !sentIds.has(write.id)))
    await commit({ ...pulled, remove: settled.remove, update: [...settled.update, ...pulled.update ?? []] })
    if (answer.body.pull.more) wantPull = true
    return true
  }

  /** One round inside the lock: pull when asked, then send the outbox in chunks. */
  async function pass(): Promise<void> {
    passGeneration = generation
    for (;;) {
      if (destroyed) return
      const at = version
      const queue = await storage.readQueue(id)
      // Another tab changed the stored copy since this tab read it.
      if (at === version && queueSignature(queue.meta, queue.writes) !== queueSignature(meta, writes)) await reload()
      if (destroyed) return
      if (!meta || wantPull) {
        wantPull = false
        if (!(await pull())) return
        continue
      }
      const scopeMeta = meta
      const sendable = writes.filter(write => !write.error && write.scope === scopeMeta.scope.id)
      if (!sendable.length) {
        if (status !== "ready") {
          recover()
          publish()
        }
        return
      }
      if (!(await push(scopeMeta, sendable.slice(0, syncPushLimit)))) return
    }
  }

  function sync(): Promise<void> {
    again = true
    running ??= (async () => {
      try {
        await loading
        while (again && !destroyed) {
          again = false
          await environment.lock(`vitehub-sync:${id}`, pass).catch((cause: unknown) => {
            if (cause === cancelled) return
            fail(new SyncError("SYNC_SERVER_ERROR", cause instanceof Error ? cause.message : String(cause)))
          })
        }
      }
      finally {
        running = undefined
      }
    })()
    return running
  }

  /** Starts a round. Without `force`, a round waits for the backoff timer. */
  function schedule(force: boolean): Promise<void> {
    if (destroyed) return Promise.resolve()
    if (!force && cancelRetry) return Promise.resolve()
    if (force) {
      cancelRetry?.()
      cancelRetry = undefined
    }
    return sync()
  }

  function tick(): void {
    if (options.interval === false) return
    cancelTick = environment.schedule(() => {
      tick()
      if (!environment.isVisible()) return
      wantPull = true
      void schedule(false)
    }, options.interval)
  }

  publish()
  const loading = reload().catch(() => undefined)
  const stopEvents = environment.listen((event) => {
    if (event === "offline") {
      status = "offline"
      publish()
      return
    }
    wantPull = true
    void schedule(true)
  })
  const stopMessages = environment.receive((message) => {
    if (message.type === "clear") forget()
    else if (message.id === id) void reload()
  })
  tick()
  void schedule(true)

  function forget(): void {
    generation++
    version++
    rejectPending(new SyncError("SYNC_SCOPE_CHANGED", "The Sync data was cleared before the server confirmed this write."))
    meta = undefined
    confirmed = new Map()
    writes = []
    local = []
    status = "loading"
    error = null
    wantPull = true
    publish()
  }

  function findFailure(failure: SyncFailure): SyncQueuedWrite | undefined {
    return writes.find(write => write.error && write.id === failure.mutation.id)
  }

  return {
    getState: () => state as SyncState<TRow>,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // SAFETY: the rows are the JSON rows of the table of `TRow`.
    get: key => view.get(key) as TRow | undefined,
    insert(value) {
      const fields: SyncRow = { ...value }
      const given = fields[keyColumnOf(meta)]
      const key = typeof given === "string" && given ? given : randomUUID()
      return enqueue({ id: randomUUID(), scope: meta?.scope.id ?? null, key, op: "insert", value: fields })
    },
    update(key, patch) {
      return enqueue({ id: randomUUID(), scope: meta?.scope.id ?? null, key, op: "update", patch: { ...patch } })
    },
    delete(key) {
      return enqueue({ id: randomUUID(), scope: meta?.scope.id ?? null, key, op: "delete" })
    },
    refresh() {
      wantPull = true
      return schedule(true)
    },
    retry(failure) {
      assertOpen()
      const failed = findFailure(failure)
      if (!failed) throw syncErrors.SYNC_UNKNOWN_FAILURE()
      // A write stays with the scope it was made for, so it never reaches another account.
      if (meta && failed.scope !== meta.scope.id) return refused(failed.key, new SyncError("SYNC_SCOPE_CHANGED", failed.error!.message))
      const { seq: _seq, error: _error, ...write } = failed
      return enqueue({ ...write, id: randomUUID() }, failed)
    },
    dismiss(failure) {
      assertOpen()
      const failed = findFailure(failure)
      if (!failed) return
      writes = writes.filter(write => write !== failed)
      version++
      publish()
      storage.write(id, { remove: [failed.seq] }).then(() => environment.post({ type: "change", id }), () => undefined)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      stopEvents()
      stopMessages()
      cancelRetry?.()
      cancelTick?.()
      listeners.clear()
    },
    forget,
  }
}

export { createSyncStore }
export type { SyncStoreOptions, SyncStoreWithReset }
