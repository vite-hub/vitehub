import { Diagnostic } from "nostics"

import { syncDocsPage } from "../errors.ts"

import type { SyncErrorCode, SyncKey, SyncMutation, SyncRow, SyncWireError } from "../protocol.ts"

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
class SyncError extends Diagnostic {
  /** What went wrong, such as `SYNC_UNAUTHORIZED`. `docs` links to its page. */
  declare code: SyncClientErrorCode
  /** The HTTP status, when the server answered. */
  readonly status: number | undefined
  /** Per-field problems from the definition's `schema` or the arguments of an action. */
  readonly issues: { path?: string, message: string }[] | undefined

  /** `fix` is the fix that the server sent, or the fix of the catalog for a code that the client makes. */
  constructor(code: SyncClientErrorCode, message: string, options: { status?: number, issues?: { path?: string, message: string }[], fix?: string } = {}) {
    super({ code, why: message, docs: syncDocsPage(code), ...(options.fix ? { fix: options.fix } : {}) }, SyncError)
    this.name = "SyncError"
    this.status = options.status
    this.issues = options.issues
  }
}

/**
 * A write that the server refused. It is not sent again until `retry()`.
 * @experimental
 */
interface SyncFailure {
  /** The key of the row that the write changed. For an action, the id of the call, as in `SyncWrite.key`. */
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
  /** The number of writes of the current account that the server did not confirm yet. */
  queued: number
  /** Refused writes, oldest first. */
  failures: readonly SyncFailure[]
  /** `true` when the rows and the queue are in IndexedDB and survive a reload. */
  persisted: boolean
  /**
   * `true` while this tab holds the live stream, so changes of other people show within a second. One visible tab of
   * the app holds it, and the other tabs get the changes from that tab.
   */
  live: boolean
}

/**
 * One write. It shows in `rows` at once. Await it to know that the server stored it: it resolves with the row as the
 * server stored it (`undefined` after a delete), or with the result of an action. It rejects with a `SyncError` when
 * the server refused it. Awaiting it is optional.
 * @experimental
 */
interface SyncWrite<TValue> extends PromiseLike<TValue | undefined> {
  /**
   * The key of the row, also the new key that `insert()` made. For an action, the id of the call, which is also the key
   * of the first row that its optimistic function inserts without a key.
   */
  readonly key: SyncKey
  readonly state: "queued" | "applied" | "rejected"
}

/**
 * The view that an optimistic action changes. The changes show at once and go away when the server answers, since the
 * answer has the rows as the server wrote them.
 * @experimental
 */
interface SyncLocal<TRow> {
  get: (key: SyncKey) => TRow | undefined
  /**
   * Adds a row and returns its key. Without a key in `value`, the key comes from the id of the call, so it is the same
   * each time the function runs. Pass the key in the arguments of the action when the server must use it too.
   */
  insert: (value: Partial<TRow>) => SyncKey
  update: (key: SyncKey, patch: Partial<TRow>) => void
  delete: (key: SyncKey) => void
}

/**
 * Optimistic functions of actions, by action name. Each one changes `local` as the server action will, so the change
 * shows before the server answers. They run again on each change of the rows, so they must be pure: no requests, no
 * random values, no clock.
 * @experimental
 */
type SyncOptimisticActions<TRow, TArgs> = { [TName in keyof TArgs]?: (local: SyncLocal<TRow>, args: TArgs[TName]) => void }

/**
 * The actions of a Sync definition, by name. A call queues the action like a write and returns a `SyncWrite` that
 * resolves with the result of the server action.
 * @experimental
 */
type SyncActionCalls<TArgs> = { readonly [TName in keyof TArgs]: (args: TArgs[TName]) => SyncWrite<unknown> }

/**
 * The local copy of one Sync table. Reads are synchronous. Writes apply at once, wait in a durable queue, and go to the
 * server in order.
 * @experimental
 */
interface SyncStore<TRow, TArgs = Record<string, never>> {
  getState: () => SyncState<TRow>
  /** Calls `listener` after each change of the state. Returns a function that stops it. */
  subscribe: (listener: () => void) => () => void
  /** The row with this key, with the queued writes applied. */
  get: (key: SyncKey) => TRow | undefined
  /** `true` while a queued write changes the row with this key. */
  pending: (key: SyncKey) => boolean
  /** Adds a row. The store makes the key with `crypto.randomUUID()` unless `value` has one, and adds the scope values. */
  insert: (value: Partial<TRow>) => SyncWrite<TRow>
  /** Changes the columns in `patch`. The server keeps the other columns as they are. */
  update: (key: SyncKey, patch: Partial<TRow>) => SyncWrite<TRow>
  delete: (key: SyncKey) => SyncWrite<TRow>
  /** The named actions of `defineSync({ actions })`: `store.actions.complete({ id })`. */
  actions: SyncActionCalls<TArgs>
  /** Pulls now and sends the queue. Resolves when that is done, also when it failed: read `status` and `error`. */
  refresh: () => Promise<void>
  /** Sends a refused write again, on top of the latest rows. */
  retry: (failure: SyncFailure) => SyncWrite<TRow>
  /** Drops a refused write. */
  dismiss: (failure: SyncFailure) => void
  /** Stops this user of the store. The store stops with its last user. */
  destroy: () => void
}

/**
 * Options of `createSync()`. The first call for a name and subset sets them, later calls share that store.
 * @experimental
 */
interface SyncOptions<TRow = SyncRow, TArgs = Record<string, never>> {
  /**
   * A subset of the rows, such as `{ issueId }`: column values that each row of the subset has. Each subset is its own
   * store, with its own rows in IndexedDB, so a subset that the browser saw before shows at once. The server adds it to
   * its own `where`, so a subset can only narrow what the caller may see.
   */
  where?: Partial<TRow>
  /** Optimistic functions of actions, by action name. Without one, the action changes the rows when the server answers. */
  actions?: SyncOptimisticActions<TRow, TArgs>
  /** The app base URL. Default: the Vite or Nuxt base, else `/`. */
  baseURL?: string
  /** `false` keeps the rows and the queue in memory only. Default `true`: IndexedDB when the browser has it. */
  persist?: boolean
  /**
   * Milliseconds between pulls while the page is visible. `false` turns it off. Default `30000`. While the live stream
   * is open, the store pulls every 5 minutes at most.
   */
  interval?: number | false
  fetch?: typeof fetch
}

export { SyncError }
export type { SyncActionCalls, SyncClientErrorCode, SyncFailure, SyncLocal, SyncOptimisticActions, SyncOptions, SyncState, SyncStatus, SyncStore, SyncWrite }
