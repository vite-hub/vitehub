import { syncErrors } from "../errors.ts"
import { syncPushLimit } from "../protocol.ts"
import { addedWrites, applyQueueChange, applyRowChange } from "./storage.ts"
import { SyncError } from "./types.ts"
import { backoffDelay, buildView, clientError, generationOf, isActive, isOwnFailure, isPull, keyColumnOf, linkWrite, linkWrites, mergeTarget, pullChange, pushChange, randomUUID, readError, toMutation, toWireError, whereKey } from "./view.ts"

import type { SyncKey, SyncPullResponse, SyncPushRequest, SyncPushResponse, SyncRow, SyncValues } from "../protocol.ts"
import type { SyncEnvironment } from "./environment.ts"
import type { SyncLive, SyncLiveEntry } from "./live.ts"
import type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorage, SyncStorageChange } from "./storage.ts"
import type { SyncActionCalls, SyncFailure, SyncLocal, SyncState, SyncStatus, SyncStore, SyncWrite } from "./types.ts"
import type { SyncLinkedWrite, SyncView, SyncViewPage } from "./view.ts"

/** An optimistic function of an action, with the arguments as JSON. */
type SyncOptimisticAction = (local: SyncLocal<SyncRow>, args: unknown) => void

/** The open stores of one page, so the optimistic function of an action can change a store of another Sync name. */
interface SyncPage {
  stores: Set<SyncPageStore>
  /** Goes up each time a store of the page changes, so the other stores build their views again. */
  version: number
}

/** What a store shows to the other stores of its page. */
interface SyncPageStore {
  name: string
  /** The primary key column, once the store pulled. */
  key: () => string | undefined
  /** The row with this key, without the writes that the actions of other stores make in this store. */
  row: (key: SyncKey) => SyncRow | undefined
  /** The writes that the optimistic functions of this store make in the stores of `name`. */
  writes: (name: string) => readonly SyncLinkedWrite[]
  /** Another store of the page changed. */
  changed: () => void
  /**
   * Keeps writes of actions that the server applied, until a pull brings the rows of the server. The store that calls
   * it tells the page after.
   */
  hold: (writes: readonly SyncLinkedWrite[]) => void
}

interface SyncStoreOptions {
  /** The Sync route, such as `/_vitehub/sync/todos`. */
  url: string
  /** The key for storage and coordination, independent of the request URL. */
  id?: string
  /** The subset of the store. Its rows and its outbox are stored apart from the other subsets. */
  where?: SyncValues
  /** The optimistic functions of actions, by name. */
  actions?: Record<string, SyncOptimisticAction | undefined>
  fetch: typeof fetch
  storage: SyncStorage
  environment: SyncEnvironment
  /** The live stream of the tab. Without it, the store only pulls. */
  live?: SyncLive
  interval: number | false
  /** Called once when a destroyed store stopped, after it sent its writes. */
  onStop?: () => void
  /** The open stores of the page. `local.sync(name)` of an optimistic function changes the stores of `name` in it. */
  page?: SyncPage
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

/** Milliseconds between pulls while the live stream is open. The stream brings the changes, so this is a fallback. */
const livePullInterval = 300_000

const actionName = /^[a-z]\w*$/i

function isRetryable(error: SyncError): boolean {
  return error.code === "SYNC_NETWORK" || error.code === "SYNC_SERVER_ERROR"
}

/**
 * `true` when a server answered the next page of a snapshot with changes instead, as a server without paged snapshots
 * does. The rows after the page then never come, so the client starts the snapshot again.
 */
function ignoredPage(sentAfter: string | undefined, pull: SyncPullResponse): boolean {
  return sentAfter !== undefined && !pull.reset && pull.after === undefined
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
    && meta!.after === change.meta!.after
    && !change.reset
    && !change.put?.length && !change.delete?.length && !change.add?.length && !change.update?.length && !change.remove?.length
    && !change.results?.length
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
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Internal action dispatch retains the argument and result types of the owning store's generated registry.
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
 * a time. Every write goes to storage before it is sent. One visible tab leads its live changes, in the live stream
 * that every store of that tab shares.
 */
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Internal transport boundary: openSync supplies the route's row and action types from the generated registry.
function createSyncStore<TRow, TArgs = Record<string, unknown>>(name: string, options: SyncStoreOptions): SyncStoreWithReset<TRow, TArgs> {
  const { url, storage, environment } = options
  const where = options.where ?? {}
  const subset = whereKey(where)
  // The name of the stored copy and of the locks. A subset has its own.
  const id = options.id ?? (subset ? `${url}?${subset}` : url)
  const listeners = new Set<() => void>()
  const pending = new Map<string, PendingWrite[]>()
  const failureCache = new WeakMap<SyncQueuedWrite, SyncFailure>()
  const optimistic = new Map<string, SyncOptimisticAction>()
  const reported = new Set<string>()
  // Results of the actions of this tab that this tab sent, until their write settles. The storage keeps the results of
  // actions that another tab made.
  const results = new Map<string, unknown>()
  // Ids of writes on their way to storage. A new update does not merge into them.
  const storing = new Set<string>()
  // A server ignored the page of a snapshot, so the next pull starts a new snapshot.
  let freshSnapshot = false

  let meta: SyncMeta | undefined
  let confirmed = new Map<SyncKey, SyncRow>()
  let writes: SyncQueuedWrite[] = []
  // Writes that wait for the storage. They show in the rows, and the next pass sends them once they are stored.
  let local: SyncNewWrite[] = []
  // Stored writes that a retry replaced. The next flush removes them from storage.
  let removals: number[] = []
  let flushQueued = false
  // The last write of a flush to storage. A pass waits for it, so it sends the writes made before it started.
  let flushed: Promise<void> = Promise.resolve()
  // The rows with the writes of this store, and the view, which adds the writes of the actions of other stores.
  let base: SyncView = { rows: confirmed, pending: new Set(), outgoing: new Map() }
  let view = base
  // `idle` until the stored copy is read, as on the server, so a server-rendered page hydrates without a mismatch.
  let status: SyncStatus = "idle"
  let loaded = false
  let error: SyncError | null = null
  let live = false
  let state!: SyncState<SyncRow>
  // `true` once a pull answered, and once a destroyed store stopped.
  let pulled = false
  let stopped = false
  // `true` once the first read of the stored copy ended, also when it failed.
  let started = false

  // Each change in memory moves `version`, so a storage read that started before it does not overwrite it.
  let version = 0
  // `forget()` moves `generation`, so a write that was stored before it does not come back.
  let generation = 0
  let passGeneration = 0
  let destroyed = false
  let paused = false
  let wantPull = true
  let attempt = 0
  let cancelRetry: (() => void) | undefined
  let cancelTick: (() => void) | undefined
  let running: Promise<void> | undefined
  let again = false
  // Live changes: the leader lock, the end of the lead, a server that has no stream, and pulls of the stream that wait
  // for the lock.
  let stopLeader: (() => void) | undefined
  let endLead: (() => void) | undefined
  let liveRefused = false
  let livePulls: LivePull[] = []
  // The generation of the rows when the stream of the tab opened with this store.
  let streamGeneration: string | undefined
  // Writes of the actions of other stores of the page: the writes of applied actions until the next pull, the actions
  // of this store whose writes other stores hold now, and the writes that the view shows.
  const { page } = options
  let held: { mark: number, write: SyncLinkedWrite }[] = []
  let holdMark = 0
  const handed = new Set<string>()
  let incomingText = "[]"
  let building = false
  // `base` is built again after a change of this store, or of the page when its optimistic functions read other stores.
  let baseDirty = true
  let basing = false
  let readsPage = false
  let baseAt = 0
  // The page version and the base of the view.
  let viewAt = 0
  let viewBase = base

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

  /** The writes that the actions of the other stores of the page make in this store. */
  function incoming(): SyncLinkedWrite[] {
    const found: SyncLinkedWrite[] = []
    for (const other of page?.stores ?? []) {
      if (other !== link) found.push(...other.writes(name))
    }
    return found
  }

  /**
   * The rows with the writes of this store, built again when they changed. The other stores of the page read them, and
   * the optimistic functions of this store read theirs. A read during the build gets the last base.
   */
  function ensureBase(): SyncView {
    const at = page?.version ?? 0
    if (basing || (!baseDirty && !(readsPage && baseAt !== at))) return base
    basing = true
    baseDirty = false
    baseAt = at
    readsPage = false
    try {
      base = buildView(confirmed, [...writes, ...local], { meta, where, actions: optimistic, report, page: pageReader, held: held.map(item => item.write), handed })
    }
    finally {
      basing = false
    }
    if (handed.size) {
      const queued = new Set([...writes, ...local].map(write => write.id))
      for (const id of handed) {
        if (!queued.has(id)) handed.delete(id)
      }
    }
    return base
  }

  /**
   * Builds the view and the state after a change, once. A build reads the writes of the other stores of the page. A
   * read of this store during its own build gets the last state.
   */
  function current(): SyncState<SyncRow> {
    if (building) return state
    building = true
    try {
      return build()
    }
    finally {
      building = false
    }
  }

  function build(): SyncState<SyncRow> {
    const at = page?.version ?? 0
    if (!dirty && viewAt === at) return state
    viewAt = at
    const own = ensureBase()
    // The writes of the actions of this store in its own name show in it as in the other stores of the name.
    const linked = [...incoming(), ...own.outgoing.get(name) ?? []]
    const text = JSON.stringify(linked)
    if (!dirty && own === viewBase && text === incomingText) return state
    dirty = false
    viewBase = own
    incomingText = text
    const previous = view
    view = linkWrites(own, linked, where, meta)
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
    baseDirty = true
    settlePending()
    for (const listener of listeners) listener()
    changePage()
  }

  /** Tells the other stores of the page: they may show writes of the actions of this store, or read its rows. */
  function changePage(): void {
    if (!page) return
    page.version++
    for (const other of page.stores) {
      if (other !== link) other.changed()
    }
  }

  /** The other stores of the page, as an optimistic function of this store reads them. */
  const pageReader: SyncViewPage = {
    get(target, key) {
      readsPage = true
      for (const other of page?.stores ?? []) {
        const row = other.name === target ? other.row(key) : undefined
        if (row) return row
      }
      return undefined
    },
    key(target) {
      for (const other of page?.stores ?? []) {
        const column = other.name === target ? other.key() : undefined
        if (column) return column
      }
      return "id"
    },
  }

  /**
   * Gives the writes that applied actions made in the stores of the page to those stores, also to this store for its
   * own name. They keep them until they pull, so a row does not go away between this answer and their pull. The
   * optimistic functions of these actions stop writing other stores, so no store gets the writes twice.
   */
  function handOver(applied: ReadonlySet<string>): void {
    if (!page || !applied.size) return
    // The writes as this store makes them now. A store that holds them changes what a later function reads.
    const done = [...ensureBase().outgoing].map(([target, list]) => [target, list.filter(write => applied.has(write.id))] as const)
    for (const [target, list] of done) {
      if (!list.length) continue
      for (const other of page.stores) {
        if (other.name === target) other.hold(list)
      }
    }
    for (const id of applied) handed.add(id)
    publish()
  }

  /** Drops the held writes up to `mark`, after a pull that started after them. Returns `true` when it dropped one. */
  function release(mark: number | undefined): boolean {
    if (mark === undefined) return false
    const kept = held.filter(item => item.mark > mark)
    if (kept.length === held.length) return false
    held = kept
    return true
  }

  function settlePending(): void {
    if (!pending.size) return
    const stored = new Map(writes.map(write => [write.id, write]))
    const waiting = new Set(local.map(write => write.id))
    // Actions that another tab sent. Their results wait in storage.
    const sentElsewhere: [string, PendingWrite[]][] = []
    for (const [mutationId, handles] of pending) {
      if (waiting.has(mutationId)) continue
      const queued = stored.get(mutationId)
      if (queued?.error) {
        pending.delete(mutationId)
        for (const handle of handles) handle.settle("rejected", new SyncError(queued.error.code, queued.error.message, queued.error.issues ? { issues: queued.error.issues } : {}))
      }
      else if (!queued) {
        pending.delete(mutationId)
        const actions = handles.filter(handle => handle.op === "action")
        for (const handle of handles) {
          if (handle.op !== "action") handle.settle("applied", confirmed.get(handle.key))
        }
        if (!actions.length) continue
        if (!results.has(mutationId)) {
          sentElsewhere.push([mutationId, actions])
          continue
        }
        const result = results.get(mutationId)
        results.delete(mutationId)
        for (const handle of actions) handle.settle("applied", result)
      }
    }
    if (!sentElsewhere.length) return
    void storage.takeResults(sentElsewhere.map(([mutationId]) => mutationId)).catch(() => new Map<string, unknown>()).then((found) => {
      for (const [mutationId, handles] of sentElsewhere) {
        for (const handle of handles) handle.settle("applied", found.get(mutationId))
      }
    })
  }

  function rejectPending(reason: SyncError): void {
    for (const handles of pending.values()) {
      for (const handle of handles) handle.settle("rejected", reason)
    }
    pending.clear()
  }

  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The owning store selects its row or action result type for this queued write handle.
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

  /** Takes a stored write out of the queue in memory, and out of storage with the next flush. */
  function drop(write: SyncQueuedWrite): void {
    writes = writes.filter(item => item !== write)
    removals.push(write.seq)
  }

  /** Moves the handles of the write `from` to the write `to`. */
  function moveHandles(from: string, to: string): void {
    const handles = pending.get(from)
    if (!handles) return
    pending.delete(from)
    pending.set(to, [...pending.get(to) ?? [], ...handles])
  }

  /** `true` while the store has writes that it may send: writes not stored yet, or stored writes of the account. */
  /**
   * Whether a destroyed store still has work. With queued writes, it pulls once first: the stored account can be
   * another one than the account of the session now, and only a pull tells which writes the session may send.
   */
  function hasWork(): boolean {
    return local.length > 0 || writes.some(write => isActive(write, meta?.account)) || (!pulled && writes.some(write => !write.error))
  }

  /** Shows `write` at once. It goes to storage at the end of the tick, with the other writes of the tick. */
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Internal queue preserves the owning store method's row or action result type through track().
  function enqueue<TValue>(write: SyncNewWrite, replaces?: SyncQueuedWrite): SyncWrite<TValue> {
    assertOpen()
    if (replaces) {
      drop(replaces)
      moveHandles(replaces.id, write.id)
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

  /**
   * Stores the writes of this tick in one change, then sends them in one push. It runs also after `destroy()`, so each
   * write that the store took reaches storage and the server.
   */
  function flush(): void {
    flushQueued = false
    if (paused || (!local.length && !removals.length)) return
    // A write made before the stored copy was read gets its account from that copy, not from the next pull, which can
    // come from another account.
    if (!started) {
      flushQueued = true
      void loading.then(flush)
      return
    }
    const batch = local.filter(write => !storing.has(write.id)).map(write => write.account === null && meta ? { ...write, account: meta.account } : write)
    const removed = removals
    removals = []
    for (const write of batch) storing.add(write.id)
    const at = generation
    const change: SyncStorageChange = { add: batch, remove: removed }
    flushed = storage.write(id, change).then((result) => {
      for (const write of batch) storing.delete(write.id)
      if (at !== generation) return
      // A reload may have read these writes from storage already.
      const known = new Set(writes.map(write => write.id))
      const stored = addedWrites(change, result)
      const ids = new Set(batch.map(write => write.id))
      local = local.filter(write => !ids.has(write.id))
      writes = [...writes, ...stored.filter(write => !known.has(write.id))]
      version++
      publish()
      environment.post({ type: "change", id })
      void schedule(false)
    }, (cause: unknown) => {
      for (const write of batch) storing.delete(write.id)
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

  /**
   * Writes `change` to storage, then to memory, and tells the other tabs. A round that `forget()` ended stops here.
   * `released` drops the held writes up to that mark, in the same state change.
   */
  async function commit(change: SyncStorageChange, released?: number): Promise<void> {
    if (passGeneration !== generation) throw cancelled
    // A pull that brought nothing keeps the same state object, so a view does not render again for it.
    if (isUnchanged(meta, change)) {
      if (release(released)) {
        publish()
        return
      }
      const shown = current()
      if (shown.status !== status || shown.error !== error) publish()
      return
    }
    const result = await storage.write(id, change)
    if (passGeneration !== generation) throw cancelled
    meta = change.meta ?? meta
    confirmed = applyRowChange(confirmed, change)
    release(released)
    if (!change.reset) changedKeys.push(...change.put?.map(([key]) => key) ?? [])
    writes = applyQueueChange(writes, change, result)
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
      if (paused) return
      if (at !== version) continue
      // Another tab sent the actions that left the queue without an error: the server applied them.
      const kept = new Set(stored.writes.map(write => write.id))
      handOver(new Set(writes.filter(write => write.op === "action" && !write.error && !kept.has(write.id)).map(write => write.id)))
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

  /** The query of a pull: where the client is, and its subset. */
  function pullQuery(): string {
    const query = new URLSearchParams()
    if (meta && !freshSnapshot) {
      query.set("cursor", String(meta.cursor))
      query.set("scope", meta.scope.id)
      query.set("version", meta.version)
      if (meta.after !== undefined) query.set("after", meta.after)
    }
    if (subset) query.set("where", subset)
    query.set("paged", "1")
    return `?${query.toString()}`
  }

  async function pull(): Promise<boolean> {
    // The writes held before the pull started are in its answer.
    const mark = holdMark
    for (;;) {
      const sentAfter = freshSnapshot ? undefined : meta?.after
      const answer = await request(`${url}${pullQuery()}`, { method: "GET", headers: { accept: "application/json" } })
      if (!answer.ok) return fail(answer.error)
      if (!isPull(answer.body)) return fail(clientError(syncErrors.SYNC_SERVER_ERROR({ message: "The Sync route answered without a pull." })))
      if (ignoredPage(sentAfter, answer.body)) {
        freshSnapshot = true
        continue
      }
      if (answer.body.reset) freshSnapshot = false
      recover()
      await commit(pullChange(meta, answer.body, writes), answer.body.more ? undefined : mark)
      pulled = true
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
      paged: true,
      ...(sentMeta.after === undefined ? {} : { after: sentMeta.after }),
      mutations: sent.map(write => toMutation(write, sentMeta)),
    }
    const answer = await request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
    if (!answer.ok) {
      const reason = answer.error
      if (reason.code === "SYNC_ACCOUNT_CHANGED") {
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
    handOver(new Set(settled.results.keys()))
    // The tab that made an action reads its result. When it is another tab, the result goes to storage with the
    // removal of the write.
    const stored: [string, unknown][] = []
    for (const [mutationId, result] of settled.results) {
      if (pending.has(mutationId)) results.set(mutationId, result)
      else if (result !== undefined) stored.push([mutationId, result])
    }
    const sentIds = new Set(sent.map(write => write.id))
    const pulled = pullChange(meta, answer.body.pull, writes.filter(write => !sentIds.has(write.id)))
    const done: SyncStorageChange = { remove: settled.remove, ...(stored.length ? { results: stored } : {}) }
    if (ignoredPage(sentMeta.after, answer.body.pull)) {
      await commit({ update: settled.update })
      freshSnapshot = true
      if (!(await pull())) return false
      await commit(done)
      return true
    }
    if (!answer.body.pull.more) {
      await commit({ ...pulled, ...done, update: [...settled.update, ...pulled.update ?? []] })
      return true
    }
    // The rows of the applied writes can be on a later page. The writes stay in the outbox, and show, until the pulls
    // bring their rows. A pull that fails leaves them sent, and the next push gets `duplicate` for them.
    await commit({ ...pulled, update: [...settled.update, ...pulled.update ?? []] })
    if (!(await pull())) return false
    await commit(done)
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
      if (paused) return
      const at = version
      const queue = await storage.readQueue(id)
      // Another tab changed the stored copy since this tab read it.
      if (at === version && queueSignature(queue.meta, queue.writes) !== queueSignature(meta, writes)) await reload()
      // A destroyed store sends its writes, then stops.
      if (destroyed && !hasWork()) return
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
        while (again && !cancelRetry && !(destroyed && !hasWork())) {
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
        // A destroyed store stops when its writes are sent, or a failure that is not retried stopped them.
        if (destroyed && !cancelRetry && !stopped) {
          stopped = true
          stopMessages()
          page?.stores.delete(link)
          options.onStop?.()
        }
      }
    })()
    return running
  }

  /** Starts a round. Without `force`, a round waits for the backoff timer. */
  function schedule(force: boolean): Promise<void> {
    if (paused) return Promise.resolve()
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

  /** This store in the live stream of its tab. */
  const liveEntry: SyncLiveEntry = {
    name,
    where,
    held() {
      if (!meta) return undefined
      streamGeneration = generationOf(meta, subset)
      return { cursor: meta.cursor, scope: meta.scope.id, version: meta.version, paged: true }
    },
    live: setLive,
    pull(next, base) {
      const opened = streamGeneration
      if (opened === undefined) return
      if (generationOf(next, subset) === opened && meta && generationOf(meta, subset) === opened) {
        livePulls.push({ base, generation: opened, pull: next })
        void schedule(false)
        return
      }
      // A pull of another account, scope or table version: the stream gives nothing more to this store. The store pulls,
      // then opens the stream again. When the pull keeps the generation, the stream is wrong, such as a proxy that mixed
      // two sessions, and the next stream waits for the backoff.
      streamGeneration = undefined
      wantPull = true
      void schedule(false).then(() => {
        if (stopLeader && meta) options.live?.reopen(generationOf(meta, subset) === opened)
      })
    },
    stop(end) {
      endLead?.()
      if (end === "refused") {
        liveRefused = true
        return
      }
      // A pull shows what went wrong, and the round that succeeds joins the stream again.
      wantPull = true
      void schedule(false)
    },
  }

  /**
   * After a pull of another account, scope or table version, the stream has the old one. Its pulls that wait are
   * dropped, and the stream of the tab opens again with the new one.
   */
  function followGeneration(): void {
    const open = streamGeneration
    if (open === undefined || (meta && generationOf(meta, subset) === open)) return
    livePulls = livePulls.filter(item => meta && item.generation === generationOf(meta, subset))
    streamGeneration = undefined
    if (meta) options.live?.reopen()
    else stopLive()
  }

  function canLive(): boolean {
    return !destroyed && !liveRefused && meta !== undefined && environment.isVisible() && environment.isOnline()
  }

  /** Leads the live changes of this store, in one tab at a time, through the stream of the tab. */
  function startLive(): void {
    const live = options.live
    if (!live || stopLeader || !canLive()) return
    stopLeader = environment.lead(`vitehub-sync-live:${id}`, signal => new Promise<void>((resolve) => {
      const leave = live.join(liveEntry)
      const done = () => {
        signal.removeEventListener("abort", done)
        endLead = undefined
        stopLeader = undefined
        leave()
        streamGeneration = undefined
        setLive(false)
        resolve()
      }
      endLead = done
      signal.addEventListener("abort", done)
    }))
  }

  function stopLive(): void {
    stopLeader?.()
    stopLeader = undefined
    setLive(false)
  }

  // A destroyed store stays on the page until it stopped, so its queued actions still show in the other stores.
  const link: SyncPageStore = {
    name,
    key: () => meta?.key,
    row: key => ensureBase().rows.get(key),
    writes: target => ensureBase().outgoing.get(target) ?? [],
    changed() {
      for (const listener of listeners) listener()
    },
    hold(list) {
      // Only the writes that change what this store shows, such as a row that comes into its subset or leaves it.
      const rows = new Map(ensureBase().rows)
      const shown = list.filter(write => linkWrite(rows, write, where, meta))
      if (!shown.length) return
      const mark = ++holdMark
      held = [...held, ...shown.map(write => ({ mark, write }))]
      // The store that hands the writes over tells the page once, after every store holds them.
      dirty = true
      baseDirty = true
      wantPull = true
      void schedule(true)
    },
  }
  page?.stores.add(link)

  publish()
  const loading = reload().catch(() => undefined).then(() => {
    started = true
  })
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
    paused = true
    cancelRetry?.()
    cancelRetry = undefined
    version++
    rejectPending(new SyncError("SYNC_CLEARED", "The Sync data was cleared before the server confirmed this write."))
    meta = undefined
    confirmed = new Map()
    writes = []
    local = []
    removals = []
    livePulls = []
    held = []
    handed.clear()
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
      assertOpen()
      // A later patch of the same row in the same tick merges into the update that waits, so one push sends one update.
      const target = mergeTarget(local, key, meta?.account, storing)
      const write: SyncNewWrite = { id: randomUUID(), account: meta?.account ?? null, key, op: "update", patch: { ...target?.patch, ...patch } }
      if (target) {
        local = local.filter(item => item !== target)
        moveHandles(target.id, write.id)
      }
      return enqueue(write)
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
      paused = false
      wantPull = true
      return schedule(true)
    },
    retry(failure) {
      assertOpen()
      const failed = findFailure(failure)
      if (!failed) throw syncErrors.SYNC_UNKNOWN_FAILURE()
      // The retry is a new write with a new id, since the server refused the old one.
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
      // The writes of this tick go to storage now. The store keeps sending its queue, and stops when it is empty.
      if (flushQueued) flush()
      stopEvents()
      stopLive()
      cancelTick?.()
      listeners.clear()
      void schedule(false)
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
export type { SyncOptimisticAction, SyncPage, SyncStoreOptions, SyncStoreWithReset }
