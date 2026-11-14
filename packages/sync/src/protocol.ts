/**
 * The wire contract between the Sync client and the Sync server. Both sides import these types, and nothing else
 * crosses the network. Each Sync definition `server/sync/<name>.ts` has one route: `/api/_vitehub/sync/<name>`.
 *
 * - `GET ?cursor=<n>&scope=<id>` pulls changes. Leave out `cursor` for a full snapshot.
 * - `POST` with a `SyncPushRequest` body applies writes in order and answers with the results and a pull.
 *
 * Every response has `Cache-Control: private, no-store`. Errors use the ViteHub error body with a `SYNC_*` code.
 */

/** The value of a primary key on the wire. Sync tables use one text primary key column. */
export type SyncKey = string

/** One row as JSON. Column names are the Drizzle property names, not the SQL names. */
export type SyncRow = Record<string, unknown>

/**
 * The rows that the caller may see, as the server resolved them from `where`. `values` holds the column values that
 * every visible row has. The client writes them into an optimistic insert, so the row shows at once with the values
 * that the server will store. `id` is a stable fingerprint of `values`. A different `id` means a different caller, such
 * as after a sign-in as another user, and the client must drop what it holds for the old one.
 */
export interface SyncScope {
  id: string
  values: Record<string, unknown>
}

/** The answer to a pull. */
export interface SyncPullResponse {
  /** The name of the primary key column, such as `id`. The client fills it with `crypto.randomUUID()` on insert. */
  key: string
  scope: SyncScope
  /** Pass it back as `cursor` on the next pull. */
  cursor: number
  /**
   * `true` when `rows` is a full snapshot of the scope: the first pull, a scope change, or a cursor older than the
   * oldest change the server still keeps. The client then replaces its rows instead of merging them.
   */
  reset: boolean
  /** Rows that were inserted or changed since `cursor`, or every row when `reset` is `true`. */
  rows: SyncRow[]
  /** Keys of rows that were deleted since `cursor`. Always empty when `reset` is `true`. */
  deleted: SyncKey[]
  /** `true` when the server has more changes than one response holds. Pull again with the new `cursor`. */
  more: boolean
}

/** A write that the client made. `id` is a `crypto.randomUUID()` from the client. The server applies each `id` once. */
export type SyncMutation =
  | { id: string, op: "insert", value: SyncRow }
  | { id: string, op: "update", key: SyncKey, patch: SyncRow }
  | { id: string, op: "delete", key: SyncKey }

/** The body of a push. */
export interface SyncPushRequest {
  /** The `scope.id` that the client held when it made the writes. */
  scope: string
  /** The client's cursor. The server answers with the changes since it. */
  cursor?: number
  /** Applied in order, one after the other. At most 100. */
  mutations: SyncMutation[]
}

/** What happened to one mutation. */
export type SyncMutationResult =
  | { id: string, status: "applied" }
  /** The server applied this `id` before, for example when the client did not get the first answer. */
  | { id: string, status: "duplicate" }
  /** The server refused the write. The other mutations of the push still apply. */
  | { id: string, status: "rejected", error: SyncWireError }

/** The answer to a push with status 200. */
export interface SyncPushResponse {
  results: SyncMutationResult[]
  pull: SyncPullResponse
}

/** An error on the wire. `code` is a `SYNC_*` diagnostic code. */
export interface SyncWireError {
  code: SyncErrorCode
  message: string
  /** Per-field problems from the definition's `schema`. */
  issues?: { path?: string, message: string }[]
}

/**
 * The codes that the client acts on.
 *
 * - `SYNC_UNAUTHORIZED` (401) and `SYNC_FORBIDDEN` (403): `where` returned `false` for this caller.
 * - `SYNC_SCOPE_CHANGED` (409): the push was made for another scope. The client must not send these writes again.
 * - `SYNC_READ_ONLY`, `SYNC_INVALID`, `SYNC_NOT_FOUND`, `SYNC_KEY_EXISTS`, `SYNC_OUT_OF_SCOPE`: one mutation was refused.
 * - `SYNC_TOO_MANY_MUTATIONS` (413) and `SYNC_BAD_REQUEST` (400): the request itself is wrong.
 */
export type SyncErrorCode =
  | "SYNC_UNAUTHORIZED"
  | "SYNC_FORBIDDEN"
  | "SYNC_SCOPE_CHANGED"
  | "SYNC_READ_ONLY"
  | "SYNC_INVALID"
  | "SYNC_NOT_FOUND"
  | "SYNC_KEY_EXISTS"
  | "SYNC_OUT_OF_SCOPE"
  | "SYNC_TOO_MANY_MUTATIONS"
  | "SYNC_BAD_REQUEST"

/** The route of a Sync definition, below the app's base URL. */
export function syncRoute(name: string): string {
  return `/api/_vitehub/sync/${encodeURIComponent(name)}`
}

/** The most mutations in one push. */
export const syncPushLimit = 100
