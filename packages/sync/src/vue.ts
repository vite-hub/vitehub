import { computed, getCurrentScope, onScopeDispose, reactive, shallowRef } from "vue"

import { createSync } from "./client.ts"

import type { SyncKey } from "./protocol.ts"
import type { SyncOptions, SyncState, SyncStore } from "./client/types.ts"
import type { SyncName, SyncRowOf } from "./types.ts"

/**
 * What `useSync()` returns: the state of the store as reactive fields, and its actions.
 * @experimental
 */
interface UseSyncReturn<TRow> extends Readonly<SyncState<TRow>>, Pick<SyncStore<TRow>, "get" | "insert" | "update" | "delete" | "refresh" | "retry" | "dismiss"> {}

/**
 * The local copy of the Sync table `server/sync/<name>.ts`, as a reactive object: `todos.rows` in a template,
 * `todos.insert({ title })` in a handler. Components with one name share one store, which stops with the last of
 * them. On the server, `rows` is empty and `status` is `idle`.
 *
 * ```vue
 * <script setup lang="ts">
 * const todos = useSync("todos")
 * </script>
 *
 * <template>
 *   <li v-for="todo in todos.rows" :key="todo.id">{{ todo.title }}</li>
 * </template>
 * ```
 * @experimental
 */
function useSync<TName extends SyncName>(name: TName, options?: SyncOptions): UseSyncReturn<SyncRowOf<TName>> {
  const store = createSync(name, options)
  const state = shallowRef(store.getState())
  const stop = store.subscribe(() => {
    state.value = store.getState()
  })
  if (getCurrentScope()) {
    onScopeDispose(() => {
      stop()
      store.destroy()
    })
  }
  // SAFETY: `reactive()` unwraps each computed ref to its value, which is the field of `SyncState`. The rows are frozen,
  // so Vue keeps them as they are.
  return reactive({
    rows: computed(() => state.value.rows),
    status: computed(() => state.value.status),
    error: computed(() => state.value.error),
    queued: computed(() => state.value.queued),
    failures: computed(() => state.value.failures),
    persisted: computed(() => state.value.persisted),
    get: (key: SyncKey) => {
      // Reads the state, so a template that calls `get()` renders again after a change.
      void state.value
      return store.get(key)
    },
    insert: store.insert,
    update: store.update,
    delete: store.delete,
    refresh: store.refresh,
    retry: store.retry,
    dismiss: store.dismiss,
  }) as UseSyncReturn<SyncRowOf<TName>>
}

export { useSync }
export type { UseSyncReturn }
export type { SyncFailure, SyncOptions, SyncState, SyncStatus, SyncWrite } from "./client/types.ts"
