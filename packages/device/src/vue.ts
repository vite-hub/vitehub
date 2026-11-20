import { computed, getCurrentInstance, getCurrentScope, onMounted, onScopeDispose, shallowRef, toValue, watch } from "vue"

import { checkAccount, checkKey, checkMaxAge, currentDevice } from "./device.ts"
import { deviceErrors } from "./errors.ts"

import type { MaybeRefOrGetter, Ref, ShallowRef } from "vue"
import type { Device } from "./device.ts"

/** `idle` on the server and before the loader starts, `pending` while the loader runs, then `success` or `error`. */
export type StoredDataStatus = "idle" | "pending" | "success" | "error"

export interface UseStoredDataOptions<TData, TDefault> {
  /** The value before the first answer, when the device has no copy. */
  default?: () => TDefault
  /** The age in milliseconds after which a stored copy does not show. 7 days by default. */
  maxAge?: number
  /**
   * The account that an answer belongs to, or `null` when nobody is signed in. Give it to the read that says who is
   * signed in, such as `/api/session`: each answer names its account, as `setDeviceAccount()` does, and is stored under
   * it. A stored copy and a failed call name nothing.
   */
  account?: (value: TData) => string | null
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

/** The query of `useStoredFetch()`. A `null` or `undefined` value is left out. */
export type StoredFetchQuery = Record<string, string | number | boolean | null | undefined>

export interface UseStoredFetchOptions<TData, TDefault> extends UseStoredDataOptions<TData, TDefault> {
  /** Joins the query of the URL. A ref or a getter makes it reactive: a new query is a new read. */
  query?: MaybeRefOrGetter<StoredFetchQuery>
}

type Loader = (context: StoredDataContext, key: string) => Promise<unknown>

interface SharedRead {
  key: string
  data: ShallowRef<unknown>
  status: ShallowRef<StoredDataStatus>
  error: ShallowRef<Error | undefined>
  storedAt: ShallowRef<Date | undefined>
  answered: boolean
  users: number
  controller: AbortController | undefined
  loaders: Map<object, Loader>
  loader: Loader
  fallback: () => unknown
  maxAge: number
  account: ((value: unknown) => string | null) | undefined
  heldUntil: { promise: Promise<void>, resolve: () => void } | undefined
}

const week = 7 * 24 * 60 * 60 * 1000
const reads = new Map<string, SharedRead>()
let watching = false
let claiming: { read: SharedRead, epoch: number } | undefined
const identifying = new Set<SharedRead>()
const held = new Set<SharedRead>()

function startHeld(device: Device): void {
  const waiting = [...held]
  for (const read of waiting) {
    if (identifying.size) return
    void load(read, read.loader, device)
  }
}

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
      if (read === claiming?.read && device.epoch() === claiming.epoch) continue
      if (event.type === "reset") {
        read.answered = false
        read.data.value = read.fallback()
        read.storedAt.value = undefined
        read.error.value = undefined
      }
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

async function load(read: SharedRead, loader: Loader, device: Device): Promise<void> {
  if (!read.users) return
  read.controller?.abort()
  read.loader = loader
  read.status.value = "pending"
  held.delete(read)
  if (!read.account && read.storedAt.value && identifying.size && !device.named()) {
    read.controller = undefined
    held.add(read)
    if (!read.heldUntil) {
      let resolve = () => undefined as void
      const promise = new Promise<void>(done => resolve = done)
      read.heldUntil = { promise, resolve }
    }
    return read.heldUntil.promise
  }
  const controller = new AbortController()
  read.controller = controller
  if (read.account) identifying.add(read)
  const since = device.epoch()
  try {
    const value = await loader({ signal: controller.signal }, read.key)
    if (controller.signal.aborted || device.epoch() !== since) return
    const account = read.account?.(value)
    if (account === undefined) {
      publish(read, value)
      return device.write(read.key, value, read.maxAge, since)
    }
    checkAccount(account)
    for (;;) {
      while (device.loading()) {
        await device.whenOpen()
        if (controller.signal.aborted || device.epoch() !== since) return
      }
      claiming = { read, epoch: since + 1 }
      let claimed: boolean
      try {
        claimed = device.claim(read.key, value, read.maxAge, since, account)
      }
      finally {
        claiming = undefined
      }
      if (claimed) break
      if (controller.signal.aborted || device.epoch() !== since || !device.loading()) return
    }
    if (controller.signal.aborted) return
    publish(read, value)
  }
  catch (error) {
    if (controller.signal.aborted || device.epoch() !== since) return
    read.error.value = error instanceof Error ? error : new Error(String(error), { cause: error })
    read.status.value = "error"
  }
  finally {
    if (read.controller === controller) {
      read.heldUntil?.resolve()
      read.heldUntil = undefined
      if (identifying.delete(read)) startHeld(device)
    }
  }
}

function publish(read: SharedRead, value: unknown): void {
  read.answered = true
  read.data.value = value
  read.storedAt.value = undefined
  read.error.value = undefined
  read.status.value = "success"
}

function acquire(key: string, loader: Loader, fallback: () => unknown, maxAge: number, account: SharedRead["account"], device: Device, owner: object, start = true): SharedRead {
  const existing = reads.get(key)
  if (existing) {
    existing.users++
    existing.loaders.set(owner, loader)
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
    loaders: new Map([[owner, loader]]),
    loader,
    fallback,
    maxAge,
    account,
    heldUntil: undefined,
  }
  read.data.value = fallback()
  show(read, device)
  reads.set(key, read)
  if (start) void load(read, loader, device)
  return read
}

function release(read: SharedRead, device: Device, owner: object): void {
  read.users--
  const gone = read.loaders.get(owner)
  read.loaders.delete(owner)
  if (read.users) {
    if (read.loader === gone) read.loader = [...read.loaders.values()].at(-1) ?? read.loader
    return
  }
  read.controller?.abort()
  held.delete(read)
  read.heldUntil?.resolve()
  read.heldUntil = undefined
  if (reads.get(read.key) === read) reads.delete(read.key)
  if (identifying.delete(read)) startHeld(device)
}

/**
 * Server data that shows the last answer at once from the device, then always asks the server again. The same shape as
 * Nuxt `useAsyncData()`. Reads of the same key share one state and one loader call.
 *
 * The first render shows the stored copy when `openDevice()` finished before the app mounted. On the server, it reads no
 * storage and calls no loader: `data` is the default and `status` is `idle`. In a component that hydrates server HTML,
 * the first render is the same as on the server, also when the device is open. The stored copy shows and the loader
 * starts when the component mounts.
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
  options: UseStoredDataOptions<TData, TDefault> = {},
): UseStoredDataReturn<TData, TDefault> {
  return useRead(key, context => loader(context), options)
}

/**
 * A GET request for JSON with `useStoredData()`: the last answer at once from the device, then the answer of the
 * server. The key of the read is the URL, so reads of the same URL and query share one state and one request. A
 * status that is not 2xx goes to `error` with `DEVICE_FETCH_FAILED`, and the device never stores it.
 *
 * ```vue
 * <script setup lang="ts">
 * import { useStoredFetch } from 'vite-hub/device/vue'
 *
 * const { data: projects } = useStoredFetch<Project[]>('/api/projects', { query: { team: 't1' }, default: () => [] })
 * </script>
 * ```
 */
export function useStoredFetch<TData = unknown>(
  url: MaybeRefOrGetter<string>,
  options: UseStoredFetchOptions<TData, TData> & { default: () => NoInfer<TData> },
): UseStoredDataReturn<TData, TData>
export function useStoredFetch<TData = unknown, TDefault = undefined>(
  url: MaybeRefOrGetter<string>,
  options?: UseStoredFetchOptions<TData, TDefault>,
): UseStoredDataReturn<TData, TDefault>
export function useStoredFetch<TData, TDefault>(
  url: MaybeRefOrGetter<string>,
  options: UseStoredFetchOptions<TData, TDefault> = {},
): UseStoredDataReturn<TData, TDefault> {
  const { query, ...read } = options
  return useRead(() => fetchKey(toValue(url), toValue(query)), fetchJSON, read)
}

function fetchKey(url: string, query: StoredFetchQuery | undefined): string {
  const page = typeof document === "undefined" ? "http://localhost/" : document.baseURI
  const target = new URL(url, page)
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) target.searchParams.append(name, String(value))
  }
  target.searchParams.sort()
  target.hash = ""
  return target.origin === new URL(page).origin ? target.pathname + target.search : target.href
}

async function fetchJSON({ signal }: StoredDataContext, key: string): Promise<unknown> {
  const response = await fetch(key, { signal, headers: { accept: "application/json" } })
  if (!response.ok) throw deviceErrors.DEVICE_FETCH_FAILED({ url: key, status: response.status })
  const value: unknown = await response.json()
  return value
}

function useRead<TData, TDefault>(
  key: MaybeRefOrGetter<string>,
  loader: Loader,
  options: UseStoredDataOptions<TData, TDefault>,
): UseStoredDataReturn<TData, TDefault> {
  const maxAge = checkMaxAge(options.maxAge ?? week)
  const fallback: () => unknown = options.default ?? (() => undefined)
  // SAFETY: the loader of the read answers `TData`, and only its answers reach `account`.
  const account = options.account as SharedRead["account"]
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
  const hydrating = shallowRef(Boolean(getCurrentInstance()?.vnode.el))
  const rendered = shallowRef(hydrating.value ? fallback() : undefined)
  const owner = {}
  const current = shallowRef(acquire(checkKey(toValue(key)), loader, fallback, maxAge, account, device, owner, !hydrating.value))
  if (hydrating.value) {
    onMounted(() => {
      hydrating.value = false
      if (current.value.status.value === "idle") void load(current.value, loader, device)
    })
  }
  if (typeof key !== "string") {
    watch(() => toValue(key), (next) => {
      const previous = current.value
      current.value = acquire(checkKey(next), loader, fallback, maxAge, account, device, owner)
      release(previous, device, owner)
    })
  }
  if (getCurrentScope()) onScopeDispose(() => release(current.value, device, owner))
  return {
    // SAFETY: the shared read of a key holds the default, a stored copy, or an answer of the loader of that key.
    data: computed({
      get: () => (hydrating.value ? rendered.value : current.value.data.value) as TData | TDefault,
      set: (value) => {
        if (hydrating.value) rendered.value = value
        current.value.data.value = value
      },
    }),
    status: computed(() => hydrating.value ? "idle" : current.value.status.value),
    error: computed(() => hydrating.value ? undefined : current.value.error.value),
    storedAt: computed(() => hydrating.value ? undefined : current.value.storedAt.value),
    refresh: () => load(current.value, loader, device),
  }
}
