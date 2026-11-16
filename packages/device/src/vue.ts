import { computed, getCurrentInstance, getCurrentScope, onMounted, onScopeDispose, shallowRef, toValue, watch } from "vue"

import { checkKey, checkMaxAge, currentDevice } from "./device.ts"

import type { MaybeRefOrGetter, Ref, ShallowRef } from "vue"
import type { Device } from "./device.ts"

/** `idle` on the server and before the loader starts, `pending` while the loader runs, then `success` or `error`. */
export type StoredDataStatus = "idle" | "pending" | "success" | "error"

export interface UseStoredDataOptions<TDefault> {
  /** The value before the first answer, when the device has no copy. */
  default?: () => TDefault
  /** The age in milliseconds after which a stored copy does not show. 7 days by default. */
  maxAge?: number
}

/**
 * What the loader gets. `signal` aborts when a newer call starts, when the last component of the read unmounts or
 * moves to another key, when another account, a sign-out, or a clear makes the answer old, and when the page names its
 * account, because the device stores only the answers of calls that start after that.
 */
export interface StoredDataContext {
  signal: AbortSignal
}

export interface UseStoredDataReturn<TData, TDefault> {
  /** The stored copy, then the answer of the loader. Before both, the default. */
  data: Ref<TData | TDefault>
  status: Readonly<Ref<StoredDataStatus>>
  /** What the last loader call threw. A stored copy stays in `data`. */
  error: Readonly<Ref<Error | undefined>>
  /** When the copy in `data` was stored. `undefined` once `data` is an answer of this page, or the default. */
  storedAt: Readonly<Ref<Date | undefined>>
  /** Runs the loader again. A newer call aborts an older one. It never throws: a failure goes to `error`. */
  refresh: () => Promise<void>
}

/** The state of one key, which every read of that key shares. */
interface SharedRead {
  key: string
  data: ShallowRef<unknown>
  status: ShallowRef<StoredDataStatus>
  error: ShallowRef<Error | undefined>
  storedAt: ShallowRef<Date | undefined>
  /** The loader answered in this page, so `data` is not a stored copy. */
  answered: boolean
  users: number
  controller: AbortController | undefined
  /** The loader of the last call, which a reset of the device or the naming of the account calls again. */
  loader: (context: StoredDataContext) => Promise<unknown>
  fallback: () => unknown
  maxAge: number
}

const week = 7 * 24 * 60 * 60 * 1000
const reads = new Map<string, SharedRead>()
let watching = false

/**
 * Follows the device: a copy that loads late shows, a naming of the account calls every loader again, and a reset starts
 * every read over.
 */
function watchDevice(device: Device): void {
  if (watching) return
  watching = true
  device.subscribe((event) => {
    if (event.type === "load") {
      for (const key of event.keys) {
        const read = reads.get(key)
        if (read && !read.answered) show(read, device)
      }
      return
    }
    for (const read of reads.values()) {
      // Another account, a sign-out, or a clear: the read shows its default, also when its loader answered.
      if (event.type === "reset") {
        read.answered = false
        read.data.value = read.fallback()
        read.storedAt.value = undefined
        read.error.value = undefined
      }
      // The answer of the older call never shows, and only the answer of the new call can be stored. A read that waits
      // for its component to mount calls its loader then.
      if (read.status.value !== "idle") void load(read, read.loader, device)
    }
  })
}

function show(read: SharedRead, device: Device): void {
  const stored = device.read(read.key, read.maxAge)
  if (!stored) return
  read.data.value = stored.value
  read.storedAt.value = new Date(stored.storedAt)
}

async function load(read: SharedRead, loader: (context: StoredDataContext) => Promise<unknown>, device: Device): Promise<void> {
  // No component shows a released read, and its answer must not replace the answer of a newer read of the key.
  if (!read.users) return
  read.controller?.abort()
  const controller = new AbortController()
  read.controller = controller
  read.loader = loader
  read.status.value = "pending"
  const since = device.epoch()
  try {
    const value = await loader({ signal: controller.signal })
    // A newer call, the release of the read, or a change of the epoch came first.
    if (controller.signal.aborted || device.epoch() !== since) return
    read.answered = true
    read.data.value = value
    read.storedAt.value = undefined
    read.error.value = undefined
    read.status.value = "success"
    device.write(read.key, value, read.maxAge, since)
  }
  catch (error) {
    if (controller.signal.aborted || device.epoch() !== since) return
    read.error.value = error instanceof Error ? error : new Error(String(error), { cause: error })
    read.status.value = "error"
  }
}

/** Returns the shared read of `key`. A new read calls its loader at once, unless `start` is `false`: then it stays `idle`. */
function acquire(key: string, loader: (context: StoredDataContext) => Promise<unknown>, fallback: () => unknown, maxAge: number, device: Device, start = true): SharedRead {
  const existing = reads.get(key)
  if (existing) {
    existing.users++
    return existing
  }
  const read: SharedRead = {
    key,
    data: shallowRef(),
    status: shallowRef("idle"),
    error: shallowRef(),
    storedAt: shallowRef(),
    answered: false,
    users: 1,
    controller: undefined,
    loader,
    fallback,
    maxAge,
  }
  read.data.value = fallback()
  show(read, device)
  reads.set(key, read)
  if (start) void load(read, loader, device)
  return read
}

/** When the last component of a read goes, its loader call stops, so a late answer cannot replace a newer one. */
function release(read: SharedRead): void {
  read.users--
  if (read.users) return
  read.controller?.abort()
  if (reads.get(read.key) === read) reads.delete(read.key)
}

/**
 * Server data that shows the last answer at once from the device, then always asks the server again. The same shape as
 * Nuxt `useAsyncData()`. Reads of the same key share one state and one loader call.
 *
 * The first render shows the stored copy when `openDevice()` finished before the app mounted. On the server, it reads no
 * storage and calls no loader: `data` is the default and `status` is `idle`. In a component that renders before
 * `openDevice()`, such as during hydration, the first render is the same as on the server, and the loader starts when
 * the component mounts.
 *
 * ```vue
 * <script setup lang="ts">
 * import { useStoredData } from 'vite-hub/device/vue'
 *
 * const { data: projects, storedAt } = useStoredData('projects', () =>
 *   fetch('/api/projects').then(response => response.json() as Promise<Project[]>), { default: () => [] })
 * </script>
 * ```
 */
export function useStoredData<TData, TDefault = undefined>(
  key: MaybeRefOrGetter<string>,
  loader: (context: StoredDataContext) => Promise<TData>,
  options: UseStoredDataOptions<TDefault> = {},
): UseStoredDataReturn<TData, TDefault> {
  const maxAge = checkMaxAge(options.maxAge ?? week)
  const fallback: () => unknown = options.default ?? (() => undefined)
  const device = currentDevice()
  if (!device) {
    checkKey(toValue(key))
    return {
      data: shallowRef(fallback() as TDefault),
      status: shallowRef("idle"),
      error: shallowRef(),
      storedAt: shallowRef(),
      refresh: async () => undefined,
    }
  }
  watchDevice(device)
  // Before `openDevice()`, the first render must match a server render: the default, and `idle`.
  const deferred = !device.opened() && getCurrentInstance() !== null
  const current = shallowRef(acquire(checkKey(toValue(key)), loader, fallback, maxAge, device, !deferred))
  if (deferred) {
    onMounted(() => {
      if (current.value.status.value === "idle") void load(current.value, loader, device)
    })
  }
  if (typeof key !== "string") {
    watch(() => toValue(key), (next) => {
      const previous = current.value
      current.value = acquire(checkKey(next), loader, fallback, maxAge, device)
      release(previous)
    })
  }
  if (getCurrentScope()) onScopeDispose(() => release(current.value))
  return {
    // SAFETY: the shared read of a key holds the default, a stored copy, or an answer of the loader of that key.
    data: computed({ get: () => current.value.data.value as TData | TDefault, set: (value) => { current.value.data.value = value } }),
    status: computed(() => current.value.status.value),
    error: computed(() => current.value.error.value),
    storedAt: computed(() => current.value.storedAt.value),
    refresh: () => load(current.value, loader, device),
  }
}
