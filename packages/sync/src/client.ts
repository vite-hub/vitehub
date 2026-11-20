import { clearSync, openSync, setSyncUser } from "./client/open.ts"
import { SyncError } from "./client/types.ts"

import type { SyncOptions, SyncStore } from "./client/types.ts"
import type { SyncActionsOf, SyncExactWhere, SyncName, SyncRowOf, SyncSubsetOf } from "./types.ts"

/**
 * The local copy of the Sync table `server/sync/<name>.ts`. It shows the stored rows at once, pulls, and keeps them
 * fresh, live while the page shows. Writes and actions apply at once, survive a reload in IndexedDB, and go to the
 * server in order. Calls with one name and subset share one store; `destroy()` ends one call, and the store stops with
 * the last one, once its queued writes are sent. On the server it does nothing.
 *
 * ```ts
 * const todos = createSync("todos")
 * todos.subscribe(() => render(todos.getState().rows))
 * todos.insert({ title: "Milk" })
 * todos.actions.complete({ id })
 *
 * const comments = createSync("comments", { where: { issueId } })
 * ```
 * @experimental
 */
function createSync<TName extends SyncName, TWhere extends SyncSubsetOf<TName> = SyncSubsetOf<TName>>(name: TName, options?: SyncOptions<SyncRowOf<TName>, SyncActionsOf<TName>, TWhere> & SyncExactWhere<TWhere, SyncSubsetOf<TName>>): SyncStore<SyncRowOf<TName>, SyncActionsOf<TName>> {
  return openSync(name, options ?? {})
}

export { clearSync, createSync, setSyncUser, SyncError }
export type { ClearSyncOptions } from "./client/open.ts"
export { syncRoute } from "./protocol.ts"
export type { SyncErrorCode, SyncKey, SyncMutation, SyncRow, SyncScope, SyncValues, SyncWireError } from "./protocol.ts"
export type { SyncActionCalls, SyncClientErrorCode, SyncFailure, SyncLocal, SyncOptimisticActions, SyncOptions, SyncState, SyncStatus, SyncStore, SyncWrite } from "./client/types.ts"
export type { SyncActionsOf, SyncJsonRow, SyncName, SyncRowOf, SyncSubsetOf } from "./types.ts"
