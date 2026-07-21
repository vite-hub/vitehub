import { $fetch } from "ofetch"
import { computed, onScopeDispose, ref, toValue, watch } from "vue"

import type { ComputedRef, MaybeRefOrGetter, Ref } from "vue"
import type { WorkspaceCollectionItem, WorkspaceCollectionPage } from "../collections.ts"

export interface WorkspaceCollectionRequestOptions {
  query?: Record<string, unknown>
  signal: AbortSignal
}

export type WorkspaceCollectionRequester = <T>(endpoint: string, options: WorkspaceCollectionRequestOptions) => Promise<T>

export interface UseWorkspaceCollectionOptions {
  immediate?: boolean
  limit?: number
  query?: MaybeRefOrGetter<Record<string, unknown>>
  request?: WorkspaceCollectionRequester
}

export interface UseWorkspaceCollectionReturn<T> {
  error: Ref<unknown>
  facets: Ref<WorkspaceCollectionPage<T>["facets"]>
  hasMore: ComputedRef<boolean>
  items: Ref<T[]>
  loadMore: () => Promise<WorkspaceCollectionPage<T> | undefined>
  pending: Ref<boolean>
  refresh: () => Promise<WorkspaceCollectionPage<T> | undefined>
  total: Ref<number>
}

export interface UseWorkspaceCollectionItemOptions {
  immediate?: boolean
  request?: WorkspaceCollectionRequester
}

export interface UseWorkspaceCollectionItemReturn<T> {
  data: Ref<T | null>
  error: Ref<unknown>
  pending: Ref<boolean>
  refresh: () => Promise<WorkspaceCollectionItem<T> | undefined>
}

const defaultRequester: WorkspaceCollectionRequester = async <T>(endpoint: string, options: WorkspaceCollectionRequestOptions) => {
  return await $fetch<T>(endpoint, options)
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError")
}

function isStaleCursorError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const status = "statusCode" in error ? error.statusCode : "status" in error ? error.status : undefined
  return status === 409
}

export function useWorkspaceCollection<T = Record<string, unknown>>(
  endpoint: string,
  options: UseWorkspaceCollectionOptions = {},
): UseWorkspaceCollectionReturn<T> {
  const items = ref<T[]>([]) as Ref<T[]>
  const facets = ref<WorkspaceCollectionPage<T>["facets"]>({})
  const total = ref(0)
  const nextCursor = ref<string | null>(null)
  const pending = ref(false)
  const error = ref<unknown>(null)
  const request = options.request || defaultRequester
  let active: AbortController | undefined
  let loaded = false

  async function load(reset: boolean): Promise<WorkspaceCollectionPage<T> | undefined> {
    if (!reset && (pending.value || (loaded && !nextCursor.value))) return

    active?.abort()
    const controller = new AbortController()
    active = controller
    pending.value = true
    error.value = null
    try {
      const response = await request<WorkspaceCollectionPage<T>>(endpoint, {
        query: {
          ...(options.query ? toValue(options.query) : {}),
          cursor: reset ? undefined : nextCursor.value || undefined,
          limit: options.limit,
        },
        signal: controller.signal,
      })
      if (active !== controller) return
      items.value = reset ? response.items : [...items.value, ...response.items]
      facets.value = response.facets
      total.value = response.total
      nextCursor.value = response.nextCursor
      loaded = true
      return response
    }
    catch (cause) {
      if (active !== controller || isAbortError(cause)) return
      if (!reset && isStaleCursorError(cause)) return await load(true)
      error.value = cause
    }
    finally {
      if (active === controller) {
        active = undefined
        pending.value = false
      }
    }
  }

  const stop = watch(
    () => options.query ? toValue(options.query) : undefined,
    () => { void load(true) },
    { deep: true, immediate: options.immediate !== false },
  )
  onScopeDispose(() => {
    stop()
    active?.abort()
    active = undefined
    pending.value = false
  })

  return {
    error,
    facets,
    hasMore: computed(() => Boolean(nextCursor.value)),
    items,
    loadMore: () => load(false),
    pending,
    refresh: () => load(true),
    total,
  }
}

export function useWorkspaceCollectionItem<T = Record<string, unknown>>(
  endpoint: string,
  value: MaybeRefOrGetter<string | undefined>,
  options: UseWorkspaceCollectionItemOptions = {},
): UseWorkspaceCollectionItemReturn<T> {
  const data = ref<T | null>(null) as Ref<T | null>
  const pending = ref(false)
  const error = ref<unknown>(null)
  const request = options.request || defaultRequester
  let active: AbortController | undefined

  async function refresh(): Promise<WorkspaceCollectionItem<T> | undefined> {
    const resolvedValue = toValue(value)
    if (resolvedValue === undefined) {
      active?.abort()
      active = undefined
      data.value = null
      error.value = null
      pending.value = false
      return
    }

    active?.abort()
    const controller = new AbortController()
    active = controller
    pending.value = true
    error.value = null
    try {
      const response = await request<WorkspaceCollectionItem<T>>(endpoint, {
        query: { value: resolvedValue },
        signal: controller.signal,
      })
      if (active !== controller) return
      data.value = response.item
      return response
    }
    catch (cause) {
      if (active !== controller || isAbortError(cause)) return
      error.value = cause
    }
    finally {
      if (active === controller) {
        active = undefined
        pending.value = false
      }
    }
  }

  const stop = watch(() => toValue(value), () => { void refresh() }, { immediate: options.immediate !== false })
  onScopeDispose(() => {
    stop()
    active?.abort()
    active = undefined
    pending.value = false
  })

  return { data, error, pending, refresh }
}
