import { syncErrors } from "../errors.ts"
import { syncPushLimit } from "../protocol.ts"
import { readEvents } from "./live.ts"
import { applyQueueChange, applyRowChange } from "./storage.ts"
import { SyncError } from "./types.ts"
import { backoffDelay, buildView, clientError, generationOf, isActive, isOwnFailure, keyColumnOf, mergeTarget, pullChange, pushChange, randomUUID, readError, toMutation, toWireError, whereKey } from "./view.ts"

import type { SyncKey, SyncPullResponse, SyncPushRequest, SyncPushResponse, SyncRow, SyncValues } from "../protocol.ts"
import type { SyncEnvironment } from "./environment.ts"
import type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorage, SyncStorageChange } from "./storage.ts"
import type { SyncActionCalls, SyncFailure, SyncLocal, SyncState, SyncStatus, SyncStore, SyncWrite } from "./types.ts"
import type { SyncView } from "./view.ts"

/** An optimistic function of an action, with the arguments as JSON. */
type SyncOptimisticAction = (local: SyncLocal<SyncRow>, args: unknown) => void

interface SyncStoreOptions {
  /** The Sync route, such as `/api/_vitehub/sync/todos`. */
  url: string
  /** The subset of the store. Its rows and its outbox are stored apart from the other subsets. */
  where?: SyncValues
  /** The optimistic functions of actions, by name. */
  actions?: Record<string, SyncOptimisticAction | undefined>
  fetch: typeof fetch
  storage: SyncStorage
  environment: SyncEnvironment
  interval: number | false
}

/** A store that `clearSync()` can empty. */
interface SyncStoreWithReset<TRow, TArgs = Record<string, unknown>> extends SyncStore<TRow, TArgs> {
  /** Forgets the rows and the queue in memory, and rejects the writes that wait. */
  forget: () => void
  /** Adds the optimistic functions of a later `createSync()` call that the store does not have yet. */
  addActions: (actions: Record<string, SyncOptimisticAction | undefined>) => void
}

type Answer = { ok: true, body: unknown, response: Response } | { ok: false, error: SyncError }

interface PendingWrite {
  key: SyncKey
  op: SyncNewWrite["op"]
  settle: (state: "applied" | "rejected", value: unknown) => void
}

/** A pull of the live stream, with the generation of the rows that the stream opened with. */
interface LivePull {
  base: number
  generation: string
  pull: SyncPullResponse
}

/** How a live stream ended. `stale` means that its pulls belong to rows that the store does not show now. */
type StreamEnd = "ended" | "failed" | "refused" | "aborted" | "stale"

/** Milliseconds between pulls while the live stream is open. The stream brings the changes, so this is a fallback. */
const livePullInterval = 300_000

/** A stream that ends sooner than this counts as a failure, so a proxy that closes it at once gets backoff. */
const shortestStream = 1000

const actionName = /^[a-z]\w*$/i

function isRetryable(error: SyncError): boolean {
  return error.code === "SYNC_NETWORK" || error.code === "SYNC_SERVER_ERROR"
}

function isPull(value: unknown): value is SyncPullResponse {
  if (!value || typeof value !== "object") return false
  const scope: unknown = Reflect.get(value, "scope")
  return typeof Reflect.get(value, "key") === "string"
    && typeof Reflect.get(value, "cursor") === "number"
    && typeof Reflect.get(value, "account") === "string"
    && typeof Reflect.get(value, "version") === "string"
    && Array.isArray(Reflect.get(value, "rows"))
    && Array.isArray(Reflect.get(value, "deleted"))
    && Boolean(scope) && typeof scope === "object" && typeof Reflect.get(scope as object, "id") === "string"
}

function isPush(value: unknown): value is SyncPushResponse {
  return Boolean(value) && typeof value === "object" && Array.isArray(Reflect.get(value as object, "results")) && isPull(Reflect.get(value as object, "pull"))
}

/** A short text that changes when the stored meta or outbox differs from the copy in memory. */
function queueSignature(meta: SyncMeta | undefined, writes: readonly SyncQueuedWrite[]): string {
  return `${meta?.account}:${meta?.scope.id}:${meta?.version}:${meta?.cursor}:${writes.map(write => `${write.seq}${write.account ?? ""}${write.error ? "!" : ""}`).join(",")}`
}

function isUnchanged(meta: SyncMeta | undefined, change: SyncStorageChange): boolean {
  return Boolean(meta && change.meta)
    && meta!.cursor === change.meta!.cursor
    && meta!.key === change.meta!.key
    && meta!.scope.id === change.meta!.scope.id
    && meta!.account === change.meta!.account
    && meta!.version === change.meta!.version
    && !change.reset
    && !change.put?.length && !change.delete?.length && !change.add?.length && !change.update?.length && !change.remove?.length
}

/** Thrown inside a round that `forget()` ended, so it writes nothing more. */
const cancelled = new Error("The Sync round was cancelled.")

/** A `SyncWrite` over `promise`. A write that nobody awaits must not report an unhandled rejection. */
function thenable<TValue>(key: SyncKey, promise: Promise<TValue | undefined>, state: () => SyncWrite<TValue>["state"]): SyncWrite<TValue> {
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

function sameRow(a: SyncRow, b: SyncRow): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]) && Object.hasOwn(b, key))
}

/**
 * Keeps the row objects of `previous` where a row has the same fields, so a view that compares rows by identity, such
 * as a Vue child component, renders only the rows that changed. Only rows that a write or a pull touched can differ.
 */
function stabilize(next: SyncView, previous: SyncView, put: readonly SyncKey[]): void {
  // SAFETY: `buildView` returns a map that this store owns, either a copy or the confirmed rows.
  const rows = next.rows as Map<SyncKey, SyncRow>
  for (const keys of [next.pending, previous.pending, put]) {
    for (const key of keys) {
      const row = rows.get(key)
      const old = previous.rows.get(key)
      if (row && old && row !== old && sameRow(row, old)) rows.set(key, old)
    }
  }
}

function freezeRow(row: SyncRow): SyncRow {
  return Object.isFrozen(row) ? row : Object.freeze(row)
}

/**
 * The `actions` object of a store: `actions.complete(args)` calls `call("complete", args)`. Any name that can be an
 * action works, since the browser does not know the names of the server. `then` is not one, so the object is not
 * awaitable by mistake. Each name gives the same function each time.
 */
function actionCalls<TArgs>(call: (name: string, args: unknown) => SyncWrite<unknown>): SyncActionCalls<TArgs> {
  const calls = new Map<string, (args: unknown) => SyncWrite<unknown>>()
  // SAFETY: the proxy answers every action name with a function that takes the arguments of that action.
  return new Proxy(Object.create(null) as SyncActionCalls<TArgs>, {
    get(target, name) {
      if (typeof name !== "string" || name === "then" || !actionName.test(name) || Object.hasOwn(target, name)) return Reflect.get(target, name)
      let action = calls.get(name)
      if (!action) calls.set(name, action = args => call(name, args))
      return action
    },
  })
}

/**
 * The Sync client of one route and subset. It reads the stored copy, pulls, and sends the outbox in order, one push at
 * a time. Every write goes to storage before it is sent. One visible tab keeps a live stream open.
 */
function createSyncStore<TRow, TArgs = Record<string, unknown>>(name: string, options: SyncStoreOptions): SyncStoreWithReset<TRow, TArgs> {
  const { url, storage, environment } = options
  const where = options.where ?? {}
  const subset = whereKey(where)
  // The name of the stored copy and of the locks. A subset has its own.
  const id = subset ? `${url}?${subset}` : url
  const listeners = new Set<() => void>()
  const pending = new Map<string, PendingWrite[]>()
  const failureCache = new WeakMap<SyncQueuedWrite, SyncFailure>()
  const optimistic = new Map<string, SyncOptimisticAction>()
  const reported = new Set<string>()
  // Results of actions that the server applied, until their write settles.
  const results = new Map<string, unknown>()
  // Ids of writes in a push of this tab, or on their way to storage. A new update does not merge into them.
  const busy = new Set<string>()

  let meta: SyncMeta | undefined
  let confirmed = new Map<SyncKey, SyncRow>()
  let writes: SyncQueuedWrite[] = []
  // Writes that wait for the storage. They show in the rows, and the next pass sends them once they are stored.
  let local: SyncNewWrite[] = []
  // Stored writes that a merge or a retry replaced. The next flush removes them from storage.
  let removals: number[] = []
  let flushQueued = false
  // The last write of a flush to storage. A pass waits for it, so it sends the writes made before it started.
  let flushed: Promise<void> = Promise.resolve()
  let view: SyncView = { rows: confirmed, pending: new Set() }
  // `idle` until the stored copy is read, as on the server, so a server-rendered page hydrates without a mismatch.
  let status: SyncStatus = "idle"
  let loaded = false
  let error: SyncError | null = null
  let live = false
  let state!: SyncState<SyncRow>

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
  // Live stream: the leader lock, a server that has no stream, and pulls of the stream that wait for the lock.
  let stopLeader: (() => void) | undefined
  let liveRefused = false
  // Live streams that failed or ended at once in a row. The next stream waits for the backoff of this count.
  let liveFailures = 0
  let livePulls: LivePull[] = []
  // The generation of the open live stream. An object, so a stream that ended late does not clear the next one.
  let streamGeneration: { value: string } | undefined

  function addActions(actions: Record<string, SyncOptimisticAction | undefined> | undefined): void {
    for (const [action, run] of Object.entries(actions ?? {})) {
      if (run && !optimistic.has(action)) optimistic.set(action, run)
    }
  }
  addActions(options.actions)

  function report(write: SyncNewWrite, cause: unknown): void {
    if (reported.has(write.id)) return
    reported.add(write.id)
    console.error(`The optimistic function of the Sync action ${JSON.stringify(write.op === "action" ? write.name : write.op)} of ${JSON.stringify(name)} failed. The server still runs the action.`, cause)
  }

  // Keys that storage changes put since the last view. Their rows get new objects, and the view keeps the old ones
  // when equal.
  let changedKeys: SyncKey[] = []
  // The view and the state are built when read, so many writes in one tick build them once.
  let dirty = true

  /** Builds the view and the state after a change, once. */
  function current(): SyncState<SyncRow> {
    if (!dirty) return state
    dirty = false
    const previous = view
    view = buildView(confirmed, [...writes, ...local], { meta, where, actions: optimistic, report })
    stabilize(view, previous, changedKeys)
    changedKeys = []
    const account = meta?.account
    const failures: SyncFailure[] = []
    let queued = 0
    for (const write of [...writes, ...local]) {
      if (isActive(write, account)) queued++
    }
    for (const write of writes) {
      if (!isOwnFailure(write, account)) continue
      let failure = failureCache.get(write)
      if (!failure) failureCache.set(write, failure = Object.freeze({ key: write.key, mutation: toMutation(write, meta), error: write.error! }))
      failures.push(failure)
    }
    state = Object.freeze({
      rows: Object.freeze([...view.rows.values()].map(freezeRow)),
      status,
      error,
      queued,
      failures: Object.freeze(failures),
      persisted: loaded && storage.persisted,
      live,
    })
    return state
  }

  function publish(): void {
    dirty = true
    settlePending()
    for (const listener of listeners) listener()
  }

  function settlePending(): void {
    if (!pending.size) return
    const stored = new Map(writes.map(write => [write.id, write]))
    const waiting = new Set(local.map(write => write.id))
    for (const [mutationId, handles] of pending) {
      if (waiting.has(mutationId)) continue
      const queued = stored.get(mutationId)
      if (queued?.error) {
        pending.delete(mutationId)
        for (const handle of handles) handle.settle("rejected", new SyncError(queued.error.code, queued.error.message, queued.error.issues ? { issues: queued.error.issues } : {}))
      }
      else if (!queued) {
        pending.delete(mutationId)
        const result = results.get(mutationId)
        results.delete(mutationId)
        for (const handle of handles) handle.settle("applied", handle.op === "action" ? result : confirmed.get(handle.key))
      }
    }
  }

  function rejectPending(reason: SyncError): void {
    for (const handles of pending.values()) {
      for (const handle of handles) handle.settle("rejected", reason)
    }
    pending.clear()
  }

  function track<TValue>(write: SyncNewWrite): SyncWrite<TValue> {
    let current: SyncWrite<TValue>["state"] = "queued"
    let settle!: PendingWrite["settle"]
    const promise = new Promise<TValue | undefined>((resolve, reject) => {
      settle = (next, value) => {
        current = next
        // SAFETY: the store holds rows of `TRow` as plain JSON rows, and action results as JSON.
        if (next === "applied") resolve(value as TValue | undefined)
        else reject(value)
      }
    })
    pending.set(write.id, [...pending.get(write.id) ?? [], { key: write.key, op: write.op, settle }])
    return thenable(write.key, promise, () => current)
  }

  function assertOpen(): void {
    if (destroyed) throw syncErrors.SYNC_STORE_DESTROYED({ name })
  }

  /** Takes a write out of the queue in memory, and out of storage with the next flush. */
  function drop(write: SyncNewWrite | SyncQueuedWrite): void {
    if ("seq" in write) {
      writes = writes.filter(item => item !== write)
      removals.push(write.seq)
    }
    else {
      local = local.filter(item => item !== write)
    }
  }

  /** Shows `write` at once. It goes to storage at the end of the tick, with the other writes of the tick. */
  function enqueue<TValue>(write: SyncNewWrite, replaces?: SyncQueuedWrite | SyncNewWrite): SyncWrite<TValue> {
    assertOpen()
    if (replaces) {
      drop(replaces)
      // The handles of the replaced write now wait for this one.
      const handles = pending.get(replaces.id)
      if (handles) {
        pending.delete(replaces.id)
        pending.set(write.id, handles)
      }
    }
    const handle = track<TValue>(write)
    local.push(write)
    version++
    publish()
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flush)
    }
    return handle
  }

  /** Stores the writes of this tick in one change, then sends them in one push. */
  function flush(): void {
    flushQueued = false
    if (destroyed || (!local.length && !removals.length)) return
    const batch = local.filter(write => !busy.has(write.id)).map(write => write.account === null && meta ? { ...write, account: meta.account } : write)
    const removed = removals
    removals = []
    for (const write of batch) busy.add(write.id)
    const at = generation
    flushed = storage.write(id, { add: batch, remove: removed }).then((seqs) => {
      for (const write of batch) busy.delete(write.id)
      if (at !== generation) return
      // A reload may have read these writes from storage already.
      const known = new Set(writes.map(write => write.id))
      const stored = batch.map((write, index): SyncQueuedWrite => ({ ...write, seq: seqs[index]! }))
      const ids = new Set(batch.map(write => write.id))
      local = local.filter(write => !ids.has(write.id))
      writes = [...writes, ...stored.filter(write => !known.has(write.id))]
      version++
      publish()
      environment.post({ type: "change", id })
      void schedule(false)
    }, (cause: unknown) => {
      for (const write of batch) busy.delete(write.id)
      if (at !== generation) return
      const ids = new Set(batch.map(write => write.id))
      local = local.filter(write => !ids.has(write.id))
      version++
      const reason = new SyncError("SYNC_BAD_REQUEST", `The browser could not store the write: ${cause instanceof Error ? cause.message : String(cause)}`)
      for (const write of batch) {
        for (const handle of pending.get(write.id) ?? []) handle.settle("rejected", reason)
        pending.delete(write.id)
      }
      // The replaced writes are still in storage, so memory reads them again.
      void reload()
    })
  }

  /** Writes `change` to storage, then to memory, and tells the other tabs. A round that `forget()` ended stops here. */
  async function commit(change: SyncStorageChange): Promise<void> {
    if (passGeneration !== generation) throw cancelled
    // A pull that brought nothing keeps the same state object, so a view does not render again for it.
    if (isUnchanged(meta, change)) {
      const shown = current()
      if (shown.status !== status || shown.error !== error) publish()
      return
    }
    await storage.write(id, change)
    if (passGeneration !== generation) throw cancelled
    meta = change.meta ?? meta
    confirmed = applyRowChange(confirmed, change)
    if (!change.reset) changedKeys.push(...change.put?.map(([key]) => key) ?? [])
    writes = applyQueueChange(writes, change, [])
    version++
    followGeneration()
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
      const removed = new Set(removals)
      writes = stored.writes.filter(write => !removed.has(write.seq))
      local = local.filter(write => !stored.writes.some(item => item.id === write.id))
      loaded = true
      if (status === "idle") status = "loading"
      version++
      followGeneration()
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
    return { ok: true, body, response }
  }

  /** The query of a pull or a stream: where the client is, and its subset. */
  function pullQuery(extra: Record<string, string> = {}): string {
    const query = new URLSearchParams(extra)
    if (meta) {
      query.set("cursor", String(meta.cursor))
      query.set("scope", meta.scope.id)
      query.set("version", meta.version)
    }
    if (subset) query.set("where", subset)
    const text = query.toString()
    return text ? `?${text}` : ""
  }

  async function pull(): Promise<boolean> {
    for (;;) {
      const answer = await request(`${url}${pullQuery()}`, { method: "GET", headers: { accept: "application/json" } })
      if (!answer.ok) return fail(answer.error)
      if (!isPull(answer.body)) return fail(clientError(syncErrors.SYNC_SERVER_ERROR({ message: "The Sync route answered without a pull." })))
      recover()
      await commit(pullChange(meta, answer.body, writes))
      if (!answer.body.more) return true
    }
  }

  async function push(sentMeta: SyncMeta, sent: SyncQueuedWrite[]): Promise<boolean> {
    const body: SyncPushRequest = {
      account: sentMeta.account,
      cursor: sentMeta.cursor,
      scope: sentMeta.scope.id,
      version: sentMeta.version,
      ...(subset ? { where } : {}),
      mutations: sent.map(write => toMutation(write, sentMeta)),
    }
    for (const write of sent) busy.add(write.id)
    let answer: Answer
    try {
      answer = await request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
    }
    finally {
      for (const write of sent) busy.delete(write.id)
    }
    if (!answer.ok) {
      const reason = answer.error
      if (reason.code === "SYNC_SCOPE_CHANGED") {
        // The session belongs to another account now. The writes wait in the outbox for their account, and the pull
        // shows the rows of the new one.
        if (!(await pull())) return false
        return meta?.account === sentMeta.account ? fail(reason) : true
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
    for (const [mutationId, result] of settled.results) results.set(mutationId, result)
    const sentIds = new Set(sent.map(write => write.id))
    const pulled = pullChange(meta, answer.body.pull, writes.filter(write => !sentIds.has(write.id)))
    await commit({ ...pulled, remove: settled.remove, update: [...settled.update, ...pulled.update ?? []] })
    if (answer.body.pull.more) wantPull = true
    return true
  }

  /**
   * Applies the pulls of the live stream that waited for the lock, in order. A pull applies only on top of the cursor
   * that it started from. A pull that ends at or before the local cursor brings nothing new, since a push answer had it
   * already. Any other pull may be older than the rows, so the store pulls instead.
   */
  async function applyLivePulls(): Promise<void> {
    while (livePulls.length) {
      const { base, generation: from, pull: next } = livePulls.shift()!
      // A stream of another account, scope or table version. A new stream follows the rows that the store shows.
      if (!meta || from !== generationOf(meta, subset)) continue
      if (!next.reset && next.cursor <= meta.cursor) continue
      if (next.reset ? next.cursor < meta.cursor : base !== meta.cursor) {
        livePulls = []
        wantPull = true
        return
      }
      recover()
      await commit(pullChange(meta, next, writes))
      if (next.more) wantPull = true
    }
  }

  /** One round inside the lock: pull when asked, then send the outbox in chunks. */
  async function pass(): Promise<void> {
    passGeneration = generation
    for (;;) {
      if (flushQueued) flush()
      await flushed
      if (destroyed) return
      const at = version
      const queue = await storage.readQueue(id)
      // Another tab changed the stored copy since this tab read it.
      if (at === version && queueSignature(queue.meta, queue.writes) !== queueSignature(meta, writes)) await reload()
      if (destroyed) return
      await applyLivePulls()
      if (!meta || wantPull) {
        wantPull = false
        if (!(await pull())) return
        continue
      }
      const sentMeta = meta
      const sendable = writes.filter(write => isActive(write, sentMeta.account))
      if (!sendable.length) {
        if (status !== "ready") {
          recover()
          publish()
        }
        return
      }
      if (!(await push(sentMeta, sendable.slice(0, syncPushLimit)))) return
    }
  }

  function sync(): Promise<void> {
    again = true
    running ??= (async () => {
      try {
        await loading
        // A round that failed waits for its backoff timer, also when a write asked for another round meanwhile.
        while (again && !destroyed && !cancelRetry) {
          again = false
          await environment.lock(`vitehub-sync:${id}`, pass).catch((cause: unknown) => {
            if (cause === cancelled) return
            fail(new SyncError("SYNC_SERVER_ERROR", cause instanceof Error ? cause.message : String(cause)))
          })
        }
        if (status === "ready") startLive()
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
    cancelTick?.()
    cancelTick = undefined
    if (options.interval === false || destroyed) return
    cancelTick = environment.schedule(() => {
      tick()
      if (!environment.isVisible()) return
      wantPull = true
      void schedule(false)
    }, live ? Math.max(options.interval, livePullInterval) : options.interval)
  }

  function setLive(value: boolean): void {
    if (live === value) return
    live = value
    tick()
    publish()
  }

  /** Waits `ms`, or until `signal` aborts. */
  function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const stop = environment.schedule(done, ms)
      signal.addEventListener("abort", done, { once: true })
      function done() {
        stop()
        signal.removeEventListener("abort", done)
        resolve()
      }
    })
  }

  /**
   * Opens one live stream and queues its pulls until it ends. The stream belongs to the generation of the rows when it
   * opens. A pull of another generation ends it, such as after the session changed on the server.
   */
  async function stream(signal: AbortSignal): Promise<StreamEnd> {
    let cursor = meta!.cursor
    const opened = generationOf(meta!, subset)
    let response: Response
    try {
      response = await options.fetch(`${url}${pullQuery({ live: "1" })}`, { method: "GET", headers: { accept: "text/event-stream" }, cache: "no-store", signal })
    }
    catch {
      return signal.aborted ? "aborted" : "failed"
    }
    if (!response.ok) {
      const reason = readError(response.status, await response.json().catch(() => undefined))
      // `live: false` in the definition, or a server without live streams.
      return reason.code === "SYNC_BAD_REQUEST" ? "refused" : "failed"
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined)
      return "refused"
    }
    const own = { value: opened }
    streamGeneration = own
    setLive(true)
    try {
      for await (const event of readEvents(response.body)) {
        if (signal.aborted) return "aborted"
        if (event.type === "error") return "failed"
        if (event.type !== "pull") continue
        const data: unknown = JSON.parse(event.data)
        const next: unknown = data && typeof data === "object" ? Reflect.get(data, "pull") : undefined
        if (!isPull(next)) continue
        if (generationOf(next, subset) !== opened || !meta || generationOf(meta, subset) !== opened) return "stale"
        livePulls.push({ base: cursor, generation: opened, pull: next })
        cursor = next.cursor
        void schedule(false)
      }
    }
    catch {
      return signal.aborted ? "aborted" : "failed"
    }
    finally {
      if (streamGeneration === own) streamGeneration = undefined
    }
    return signal.aborted ? "aborted" : "ended"
  }

  /**
   * Ends a live stream whose generation is not the one of the stored rows, such as after a pull of another account or
   * scope, and opens one for the new generation. Its pulls that wait are dropped.
   */
  function followGeneration(): void {
    const open = streamGeneration?.value
    if (open === undefined || (meta && generationOf(meta, subset) === open)) return
    livePulls = livePulls.filter(item => meta && item.generation === generationOf(meta, subset))
    streamGeneration = undefined
    stopLive()
    startLive()
  }

  /**
   * The live loop of the leader tab: a stream, then the next one. After a failure, a pull shows what went wrong, and the
   * round that succeeds opens the next stream, after backoff.
   */
  async function runLive(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && canLive()) {
      if (liveFailures) await wait(backoffDelay(liveFailures - 1, environment.random()), signal)
      if (signal.aborted) return
      const opened = Date.now()
      const from = meta && generationOf(meta, subset)
      const end = await stream(signal)
      setLive(false)
      if (end === "aborted") return
      if (end === "stale") {
        // A pull shows the rows of the new generation, then the next stream opens for them.
        wantPull = true
        await schedule(false)
        if (!meta || generationOf(meta, subset) === from) liveFailures++
        continue
      }
      if (end === "refused") {
        liveRefused = true
        return
      }
      liveFailures = end === "ended" && Date.now() - opened >= shortestStream ? 0 : liveFailures + 1
      if (end === "failed") {
        wantPull = true
        void schedule(false)
        return
      }
    }
  }

  function canLive(): boolean {
    return !destroyed && !liveRefused && meta !== undefined && environment.isVisible() && environment.isOnline()
  }

  function startLive(): void {
    if (stopLeader || !canLive()) return
    const stop = environment.lead(`vitehub-sync-live:${id}`, signal => runLive(signal).finally(() => {
      if (stopLeader === stop) stopLeader = undefined
    }))
    stopLeader = stop
  }

  function stopLive(): void {
    stopLeader?.()
    stopLeader = undefined
    setLive(false)
  }

  publish()
  const loading = reload().catch(() => undefined)
  const stopEvents = environment.listen((event) => {
    if (event === "hidden") {
      stopLive()
      return
    }
    if (event === "offline") {
      stopLive()
      status = "offline"
      publish()
      return
    }
    // The network or the page is back, so a stream may work again at once.
    liveFailures = 0
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
    removals = []
    livePulls = []
    results.clear()
    status = "loading"
    error = null
    wantPull = true
    stopLive()
    publish()
  }

  function findFailure(failure: SyncFailure): SyncQueuedWrite | undefined {
    return writes.find(write => write.error && write.id === failure.mutation.id)
  }


  return {
    // SAFETY: the rows are the JSON rows of the table of `TRow`.
    getState: () => current() as SyncState<TRow>,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: key => (current(), view.rows.get(key) as TRow | undefined),
    pending: key => (current(), view.pending.has(key)),
    insert(value) {
      const fields: SyncRow = { ...value }
      const given = fields[keyColumnOf(meta)]
      const key = typeof given === "string" && given ? given : randomUUID()
      return enqueue({ id: randomUUID(), account: meta?.account ?? null, key, op: "insert", value: fields })
    },
    update(key, patch) {
      const fields = { id: randomUUID(), account: meta?.account ?? null, key, op: "update" as const }
      // A later patch of the same row merges into the update that waits for it, so one push sends one update.
      const target = mergeTarget([...writes, ...local], key, meta?.account, busy)
      if (target?.op !== "update") return enqueue({ ...fields, patch: { ...patch } })
      return enqueue({ ...fields, patch: { ...target.patch, ...patch } }, target)
    },
    delete(key) {
      return enqueue({ id: randomUUID(), account: meta?.account ?? null, key, op: "delete" })
    },
    actions: actionCalls<TArgs>((action, args) => {
      // The key of an action is its id, so the rows that its optimistic function inserts keep their keys on a replay.
      const mutationId = randomUUID()
      return enqueue({ id: mutationId, account: meta?.account ?? null, key: mutationId, op: "action", name: action, args: structuredClone(args) })
    }),
    refresh() {
      wantPull = true
      return schedule(true)
    },
    retry(failure) {
      assertOpen()
      const failed = findFailure(failure)
      if (!failed) throw syncErrors.SYNC_UNKNOWN_FAILURE()
      const { seq: _seq, error: _error, ...write } = failed
      const id = randomUUID()
      return enqueue({ ...write, id, ...(write.op === "action" ? { key: id } : {}) }, failed)
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
      stopLive()
      cancelRetry?.()
      cancelTick?.()
      listeners.clear()
    },
    forget,
    addActions(actions) {
      const before = optimistic.size
      addActions(actions)
      if (optimistic.size !== before) publish()
    },
  }
}

export { actionCalls, createSyncStore }
export type { SyncOptimisticAction, SyncStoreOptions, SyncStoreWithReset }
