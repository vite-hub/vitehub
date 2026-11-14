import { computed, getCurrentScope, markRaw, onScopeDispose, reactive, shallowRef, toValue, triggerRef, watch } from "vue"

import { createSync } from "./client.ts"
import { whereKey } from "./client/view.ts"

import type { MaybeRefOrGetter } from "vue"
import type { SyncKey } from "./protocol.ts"
import type { SyncActionCalls, SyncOptions, SyncState, SyncStore } from "./client/types.ts"
import type { SyncActionsOf, SyncName, SyncRowOf } from "./types.ts"

/**
 * Options of `useSync()`: the options of `createSync()`, with a `where` that may be a ref or a getter. When its value
 * changes, `useSync()` moves to the store of the new subset.
 * @experimental
 */
interface UseSyncOptions<TRow, TArgs> extends Omit<SyncOptions<TRow, TArgs>, "where"> {
  where?: MaybeRefOrGetter<Partial<TRow> | undefined>
}

/**
 * What `useSync()` returns: the state of the store as reactive fields, and its actions.
 * @experimental
 */
interface UseSyncReturn<TRow, TArgs = Record<string, never>> extends Readonly<SyncState<TRow>>, Pick<SyncStore<TRow, TArgs>, "get" | "pending" | "insert" | "update" | "delete" | "refresh" | "retry" | "dismiss"> {
  readonly actions: SyncActionCalls<TArgs>
}

/**
 * The local copy of the Sync table `server/sync/<name>.ts`, as a reactive object: `todos.rows` in a template,
 * `todos.insert({ title })` in a handler. Components with one name and subset share one store, which stops with the
 * last of them. On the server, `rows` is empty and `status` is `idle`.
 *
 * ```vue
 * <script setup lang="ts">
 * const todos = useSync("todos")
 * const comments = useSync("comments", { where: () => ({ issueId: props.issueId }) })
 * </script>
 *
 * <template>
 *   <li v-for="todo in todos.rows" :key="todo.id">{{ todo.title }}</li>
 * </template>
 * ```
 * @experimental
 */
function useSync<TName extends SyncName>(name: TName, options: UseSyncOptions<SyncRowOf<TName>, SyncActionsOf<TName>> = {}): UseSyncReturn<SyncRowOf<TName>, SyncActionsOf<TName>> {
  const open = () => createSync(name, { ...options, where: toValue(options.where) })
  const store = shallowRef(open())
  // A change only marks the state. The store builds it when a render or a script reads it, once for many writes.
  const changed = shallowRef(0)
  const state = computed(() => {
    void changed.value
    return store.value.getState()
  })
  const mark = () => triggerRef(changed)
  let stop = store.value.subscribe(mark)
  function close(): void {
    stop()
    store.value.destroy()
  }
  if (options.where !== undefined) {
    // A ref, a getter or a reactive object can change, and the store follows the subset. Equal values keep the store.
    watch(() => whereKey(toValue(options.where)), () => {
      const next = open()
      close()
      store.value = next
      stop = next.subscribe(mark)
    })
  }
  if (getCurrentScope()) onScopeDispose(close)
  // SAFETY: `reactive()` unwraps each computed ref to its value, which is the field of `SyncState`. The rows are frozen,
  // so Vue keeps them as they are.
  return reactive({
    rows: computed(() => state.value.rows),
    status: computed(() => state.value.status),
    error: computed(() => state.value.error),
    queued: computed(() => state.value.queued),
    failures: computed(() => state.value.failures),
    persisted: computed(() => state.value.persisted),
    live: computed(() => state.value.live),
    get: (key: SyncKey) => {
      // Reads the state, so a template that calls `get()` renders again after a change.
      void state.value
      return store.value.get(key)
    },
    pending: (key: SyncKey) => {
      void state.value
      return store.value.pending(key)
    },
    insert: (value: Parameters<SyncStore<SyncRowOf<TName>>["insert"]>[0]) => store.value.insert(value),
    update: (key: SyncKey, patch: Parameters<SyncStore<SyncRowOf<TName>>["update"]>[1]) => store.value.update(key, patch),
    delete: (key: SyncKey) => store.value.delete(key),
    actions: computed(() => markRaw(store.value.actions)),
    refresh: () => store.value.refresh(),
    retry: (failure: Parameters<SyncStore<SyncRowOf<TName>>["retry"]>[0]) => store.value.retry(failure),
    dismiss: (failure: Parameters<SyncStore<SyncRowOf<TName>>["dismiss"]>[0]) => store.value.dismiss(failure),
  }) as UseSyncReturn<SyncRowOf<TName>, SyncActionsOf<TName>>
}

export { useSync }
export type { UseSyncOptions, UseSyncReturn }
export type { SyncActionCalls, SyncFailure, SyncLocal, SyncOptions, SyncState, SyncStatus, SyncWrite } from "./client/types.ts"
