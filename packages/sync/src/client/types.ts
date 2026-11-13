import type { SyncErrorCode, SyncKey, SyncMutation, SyncWireError } from "../protocol.ts"

/**
 * Where the store is. `idle` on the server and until the stored rows are read, `loading` until the first pull, `ready`
 * after it, `offline` when the network failed, and `error` when the server refused the caller or failed.
 * @experimental
 */
type SyncStatus = "idle" | "loading" | "ready" | "offline" | "error"

/**
 * The codes of a `SyncError`: the `SYNC_*` codes of the server, plus `SYNC_NETWORK` when no answer came, and
 * `SYNC_SERVER_ERROR` for a status of 500 or more.
 * @experimental
 */
type SyncClientErrorCode = SyncErrorCode | "SYNC_NETWORK" | "SYNC_SERVER_ERROR"

/**
 * An error of a pull, a push, or one write. A refused write rejects with it.
 * @experimental
 */
class SyncError extends Error {
  /** What went wrong, such as `SYNC_UNAUTHORIZED`. */
  readonly code: SyncClientErrorCode
  /** The HTTP status, when the server answered. */
  readonly status: number | undefined
  /** Per-field problems from the definition's `schema`. */
  readonly issues: { path?: string, message: string }[] | undefined

  constructor(code: SyncClientErrorCode, message: string, options: { status?: number, issues?: { path?: string, message: string }[] } = {}) {
    super(message)
    this.name = "SyncError"
    this.code = code
    this.status = options.status
    this.issues = options.issues
  }
}

/**
 * A write that the server refused, or that was made for another scope. It is not sent again until `retry()`.
 * @experimental
 */
interface SyncFailure {
  /** The key of the row that the write changed. */
  key: SyncKey
  /** The write as it was sent, with its id. */
  mutation: SyncMutation
  error: SyncWireError
}

/**
 * A snapshot of a Sync store. `getState()` returns the same object until something changes.
 * @experimental
 */
interface SyncState<TRow> {
  /** The confirmed rows with the queued writes applied on top: server rows first, then local inserts. */
  rows: readonly TRow[]
  status: SyncStatus
  /** The error of the last pull or push. `null` after a success. */
  error: SyncError | null
  /** The number of writes that the server did not confirm yet. */
  queued: number
  /** Refused writes, oldest first. */
  failures: readonly SyncFailure[]
  /** `true` when the rows and the queue are in IndexedDB and survive a reload. */
  persisted: boolean
}

/**
 * One write. It shows in `rows` at once. Await it to know that the server stored it: it resolves with the row as the
 * server stored it (`undefined` after a delete), and rejects with a `SyncError` when the server refused it. Awaiting
 * it is optional.
 * @experimental
 */
interface SyncWrite<TRow> extends PromiseLike<TRow | undefined> {
  /** The key of the row, also the new key that `insert()` made. */
  readonly key: SyncKey
  readonly state: "queued" | "applied" | "rejected"
}

/**
 * The local copy of one Sync table. Reads are synchronous. Writes apply at once, wait in a durable queue, and go to the
 * server in order.
 * @experimental
 */
interface SyncStore<TRow> {
  getState: () => SyncState<TRow>
  /** Calls `listener` after each change of the state. Returns a function that stops it. */
  subscribe: (listener: () => void) => () => void
  /** The row with this key, with the queued writes applied. */
  get: (key: SyncKey) => TRow | undefined
  /** Adds a row. The store makes the key with `crypto.randomUUID()` unless `value` has one, and adds the scope values. */
  insert: (value: Partial<TRow>) => SyncWrite<TRow>
  /** Changes the columns in `patch`. The server keeps the other columns as they are. */
  update: (key: SyncKey, patch: Partial<TRow>) => SyncWrite<TRow>
  delete: (key: SyncKey) => SyncWrite<TRow>
  /** Pulls now and sends the queue. Resolves when that is done, also when it failed: read `status` and `error`. */
  refresh: () => Promise<void>
  /** Sends a refused write again, on top of the latest rows. A write made for another scope stays refused. */
  retry: (failure: SyncFailure) => SyncWrite<TRow>
  /** Drops a refused write. */
  dismiss: (failure: SyncFailure) => void
  /** Stops this user of the store. The store stops with its last user. */
  destroy: () => void
}

/**
 * Options of `createSync()`. The first call for a name sets them, later calls share that store.
 * @experimental
 */
interface SyncOptions {
  /** The app base URL. Default: the Vite or Nuxt base, else `/`. */
  baseURL?: string
  /** `false` keeps the rows and the queue in memory only. Default `true`: IndexedDB when the browser has it. */
  persist?: boolean
  /** Milliseconds between pulls while the page is visible. `false` turns it off. Default `30000`. */
  interval?: number | false
  fetch?: typeof fetch
}

export { SyncError }
export type { SyncClientErrorCode, SyncFailure, SyncOptions, SyncState, SyncStatus, SyncStore, SyncWrite }
