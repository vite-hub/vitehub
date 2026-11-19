/**
 * The wire contract between the Sync client and the Sync server. Both sides import these types, and nothing else
 * crosses the network. Each Sync definition `server/sync/<name>.ts` has one route: `/_vitehub/sync/<name>`.
 *
 * - `GET ?cursor&scope&version&where` pulls changes (`SyncPullQuery`). Leave out `cursor` for a full snapshot.
 * - `POST` with a `SyncPushRequest` body applies writes in order and answers with the results and a pull.
 *
 * One more route, `/_vitehub/sync`, streams the pulls of several stores in one connection: `POST` a
 * `SyncLiveRequest`, and the answer is Server-Sent Events (`SyncLiveEvent`) while the connection is open. The server
 * ends the stream after a while, and the client opens a new one.
 *
 * Every response has `Cache-Control: private, no-store`. Errors use the ViteHub error body with a `SYNC_*` code.
 */

/** The value of a primary key on the wire. Sync tables use one text primary key column. */
export type SyncKey = string

/** One row as JSON. Column names are the Drizzle property names, not the SQL names. */
export type SyncRow = Record<string, unknown>

/**
 * Equality filters on columns, by Drizzle property name. A value matches the column. An array matches any of its
 * values, such as the teams of the caller: `{ teamId: ["a", "b"] }`. `null` matches `NULL`.
 */
export type SyncValues = Record<string, unknown>

/**
 * The rows that the caller may see, as the server resolved them from `where` and the client's subset. `values` holds
 * the column values that every visible row has. The client writes the single values (not the arrays) into an
 * optimistic insert, so the row shows at once with the values that the server will store. `id` is a stable
 * fingerprint of `values`. A different `id` means that the rows are different, such as after the caller joined a
 * team, and the client then gets a full snapshot.
 */
export interface SyncScope {
  id: string
  values: SyncValues
}

/** The query of a pull. All fields are optional. */
export interface SyncPullQuery {
  /** The `cursor` of the last pull. Without it, the server answers with a full snapshot. */
  cursor?: number
  /** The `scope.id` that the client holds. A different scope gets a full snapshot. */
  scope?: string
  /** The `version` that the client holds. A different version gets a full snapshot. */
  version?: string
  /**
   * A subset of the rows, as JSON `SyncValues` with single values only, such as `{"issueId":"i1"}`. The server adds
   * it to `where`, so a subset can only narrow what the caller may see. A column that `where` sets must keep a value
   * that `where` allows, else the pull is refused with `SYNC_OUT_OF_SCOPE`.
   */
  where?: string
}

/** One store of a live stream: a Sync name, its subset, and what the client holds, as in a pull. */
export interface SyncLivePull {
  name: string
  /** The subset, as in `SyncPushRequest.where`. */
  where?: SyncValues
  cursor?: number
  scope?: string
  version?: string
}

/** The body of `POST /_vitehub/sync`: the stores that one live stream sends pulls for. */
export interface SyncLiveRequest {
  pulls: SyncLivePull[]
}

/** The answer to a pull. */
export interface SyncPullResponse {
  /** The name of the primary key column, such as `id`. The client fills it with `crypto.randomUUID()` on insert. */
  key: string
  scope: SyncScope
  /**
   * The account that the writes of the client belong to: a fingerprint of `user.id` when the caller has a user
   * (from `identify` or ViteHub Auth), else of the scope. Writes carry it, and the server refuses writes of another account with `SYNC_ACCOUNT_CHANGED`.
   * The client keeps such writes for when that account comes back.
   */
  account: string
  /**
   * A fingerprint of the table: its name, key and columns. It changes when the table changes, and the client then
   * drops the rows that it stored (the server also answers with a full snapshot).
   */
  version: string
  /**
   * The static column defaults of the table, such as `{ done: false, note: null }`. The client puts them into an
   * optimistic insert, under the caller's values, so the new row has every column at once. Defaults that the server
   * computes, such as `$defaultFn()` or SQL defaults, are not in it: they arrive with the confirmed row.
   */
  defaults: SyncRow
  /** Pass it back as `cursor` on the next pull. */
  cursor: number
  /**
   * `true` when `rows` is a full snapshot of the scope: the first pull, a scope or version change, or a cursor older
   * than the oldest change the server still keeps. The client then replaces its rows instead of merging them.
   */
  reset: boolean
  /** Rows that were inserted or changed since `cursor`, or every row when `reset` is `true`. */
  rows: SyncRow[]
  /**
   * Keys of rows that left the scope since `cursor`: rows that were deleted, and rows that moved out of the scope, such
   * as to a team the caller is not in. The server sends a key only to callers whose scope held the row. Always empty
   * when `reset` is `true`.
   */
  deleted: SyncKey[]
  /** `true` when the server has more changes than one response holds. Pull again with the new `cursor`. */
  more: boolean
}

/**
 * A write that the client made. `id` is a `crypto.randomUUID()` from the client. The server applies each `id` once.
 * `action` runs a named action of the definition (`defineSync({ actions })`) with `args` as JSON.
 */
export type SyncMutation =
  | { id: string, op: "insert", value: SyncRow }
  | { id: string, op: "update", key: SyncKey, patch: SyncRow }
  | { id: string, op: "delete", key: SyncKey }
  | { id: string, op: "action", name: string, args: unknown }

/** The body of a push. */
export interface SyncPushRequest {
  /** The `account` of the pull that the client held when it made the writes. */
  account: string
  /** The client's cursor. The server answers with the changes since it. */
  cursor?: number
  /** The `scope.id` that the client holds, so that the pull in the answer can continue from `cursor`. */
  scope?: string
  /** The `version` that the client holds. */
  version?: string
  /** The subset of the client, as in `SyncPullQuery.where`, but as an object. */
  where?: SyncValues
  /** Applied in order, one after the other. At most 100. The answer can stop early, see `SyncPushResponse.results`. */
  mutations: SyncMutation[]
}

/** What happened to one mutation. */
export type SyncMutationResult =
  /** `result` is the JSON return value of an action, when it returned one. */
  | { id: string, status: "applied", result?: unknown }
  /**
   * The server applied this `id` before, for example when the client did not get the first answer. `result` is the
   * result of the first run of an action, when it returned one. The server keeps it for 7 days.
   */
  | { id: string, status: "duplicate", result?: unknown }
  /** The server refused the write. The other mutations of the push still apply. */
  | { id: string, status: "rejected", error: SyncWireError }

/** The answer to a push with status 200. */
export interface SyncPushResponse {
  /**
   * The results of the first mutations of the push, in order. The server stops before a mutation that could pass its
   * Database call budget, so a long push can get results for its first mutations only. The client sends the others
   * again in its next push.
   */
  results: SyncMutationResult[]
  pull: SyncPullResponse
}

/**
 * One event of a live stream (`POST /_vitehub/sync`), as Server-Sent Events. The event name is the `type`, and
 * the data is the JSON of the rest. `name` and `where` tell the store of the event, as the `SyncLivePull` had them.
 *
 * - `error`: the server refused this store, such as a caller without a session or a subset outside `where`. The
 *   stream goes on for the other stores, and ends when no store is left. These come first.
 * - `open`: the stream is open for every store that the server did not refuse.
 * - `pull`: the changes since the client's cursor, as a normal pull. The server sends one when the stream opens if
 *   anything changed, then one after each change that the caller can see. A pull with `reset: true` replaces the rows.
 *
 * The server sends a comment line (`: open`) when the stream opens, so the headers reach the client at once, and
 * `: ping` every 15 seconds, so proxies keep the connection open.
 */
export type SyncLiveEvent =
  | { type: "error", name: string, where?: SyncValues, error: SyncWireError }
  | { type: "open" }
  | { type: "pull", name: string, where?: SyncValues, pull: SyncPullResponse }

/** An error on the wire. `code` is a `SYNC_*` diagnostic code. */
export interface SyncWireError {
  code: SyncErrorCode
  message: string
  /** Per-field problems from the definition's `schema` or an action's `args` schema. */
  issues?: { path?: string, message: string }[]
}

/**
 * The codes that the client acts on.
 *
 * - `SYNC_UNAUTHORIZED` (401) and `SYNC_FORBIDDEN` (403): `where` returned `false` for this caller.
 * - `SYNC_ACCOUNT_CHANGED` (409): the push was made for another account. The client must not send these writes with
 *   this caller's session. It keeps them for when that account signs in again.
 * - `SYNC_READ_ONLY`, `SYNC_INVALID`, `SYNC_NOT_FOUND`, `SYNC_KEY_EXISTS`, `SYNC_OUT_OF_SCOPE`, `SYNC_ACTION_REFUSED`:
 *   one mutation was refused. `SYNC_OUT_OF_SCOPE` also refuses a pull whose subset is outside `where`.
 * - `SYNC_TOO_MANY_MUTATIONS` (413) and `SYNC_BAD_REQUEST` (400): the request itself is wrong.
 */
export type SyncErrorCode =
  | "SYNC_UNAUTHORIZED"
  | "SYNC_FORBIDDEN"
  | "SYNC_ACCOUNT_CHANGED"
  | "SYNC_READ_ONLY"
  | "SYNC_INVALID"
  | "SYNC_NOT_FOUND"
  | "SYNC_KEY_EXISTS"
  | "SYNC_OUT_OF_SCOPE"
  | "SYNC_ACTION_REFUSED"
  | "SYNC_TOO_MANY_MUTATIONS"
  | "SYNC_BAD_REQUEST"

/** The route of the live stream of every Sync definition, below the app's base URL. */
export const syncLiveRoute = "/_vitehub/sync"

/** The route of a Sync definition, below the app's base URL. */
export function syncRoute(name: string): string {
  return `${syncLiveRoute}/${encodeURIComponent(name)}`
}

/** The most mutations in one push. */
export const syncPushLimit = 100
