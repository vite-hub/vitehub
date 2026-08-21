import { $fetch } from "ofetch"
import { computed, onScopeDispose, ref, toValue, watch } from "vue"

import type { ComputedRef, MaybeRefOrGetter, Ref } from "vue"
import type {
  AnyCollection,
  CollectionItem,
  CollectionPage,
  CollectionQuery,
} from "./core/collection.ts"

export interface CollectionRequestOptions {
  query?: Record<string, unknown>
  signal: AbortSignal
}

export type CollectionRequester = <T>(
  endpoint: string,
  options: CollectionRequestOptions,
) => Promise<T>

export interface UseCollectionOptions<TCollection extends AnyCollection> {
  immediate?: boolean
  limit?: number
  query?: MaybeRefOrGetter<CollectionQuery<TCollection>>
  request?: CollectionRequester
}

export interface UseCollectionReturn<TCollection extends AnyCollection> {
  error: Ref<unknown>
  hasMore: ComputedRef<boolean>
  items: Ref<Array<CollectionItem<TCollection>>>
  loadMore: () => Promise<CollectionPage<CollectionItem<TCollection>> | undefined>
  pending: Ref<boolean>
  refresh: () => Promise<CollectionPage<CollectionItem<TCollection>> | undefined>
}

const defaultRequester: CollectionRequester = async <T>(
  endpoint: string,
  options: CollectionRequestOptions,
) => {
  return await $fetch<T>(endpoint, options)
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "name" in error && error.name === "AbortError",
  )
}

export function useCollection<TCollection extends AnyCollection>(
  endpoint: string,
  options: UseCollectionOptions<TCollection> = {},
): UseCollectionReturn<TCollection> {
  type TItem = CollectionItem<TCollection>
  type TPage = CollectionPage<TItem>

  const items = ref<TItem[]>([]) as Ref<TItem[]>
  const nextCursor = ref<string | null>(null)
  const pending = ref(false)
  const error = ref<unknown>(null)
  const request = options.request || defaultRequester
  let active: AbortController | undefined
  let loaded = false

  async function load(reset: boolean): Promise<TPage | undefined> {
    if (!reset && (pending.value || (loaded && !nextCursor.value))) return

    active?.abort()
    const controller = new AbortController()
    active = controller
    pending.value = true
    error.value = null
    try {
      const response = await request<TPage>(endpoint, {
        query: {
          ...(options.query ? toValue(options.query) : {}),
          cursor: reset ? undefined : nextCursor.value || undefined,
          limit: options.limit,
        },
        signal: controller.signal,
      })
      if (active !== controller) return
      items.value = reset ? response.items : [...items.value, ...response.items]
      nextCursor.value = response.nextCursor
      loaded = true
      return response
    } catch (cause) {
      if (active !== controller || isAbortError(cause)) return
      error.value = cause
    } finally {
      if (active === controller) {
        active = undefined
        pending.value = false
      }
    }
  }

  const stop = watch(
    () => (options.query ? toValue(options.query) : undefined),
    () => {
      void load(true)
    },
    {
      deep: true,
      immediate:
        options.immediate !== false && (options.request !== undefined || "window" in globalThis),
    },
  )
  onScopeDispose(() => {
    stop()
    active?.abort()
    active = undefined
    pending.value = false
  })

  return {
    error,
    hasMore: computed(() => Boolean(nextCursor.value)),
    items,
    loadMore: () => load(false),
    pending,
    refresh: () => load(true),
  }
}
