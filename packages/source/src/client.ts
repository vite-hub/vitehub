import { $fetch } from "ofetch"
import { computed, onScopeDispose, ref, toValue, watch } from "vue"

import type { ComputedRef, MaybeRefOrGetter, Ref } from "vue"
import type {
  AnyCollection,
  CollectionItem,
  CollectionPage,
  CollectionQuery,
} from "./core/collection.ts"

declare const __VITEHUB_APP_BASE_URL__: string

export interface CollectionRequestOptions {
  query?: Record<string, unknown>
  signal: AbortSignal
}

export type CollectionRequester = <T>(
  endpoint: string,
  options: CollectionRequestOptions,
) => Promise<T>

declare global {
  interface ViteHubCollectionMap {}
}

export type CollectionName = Extract<keyof ViteHubCollectionMap, string>

type RegisteredCollection<TName extends CollectionName> = Extract<
  ViteHubCollectionMap[TName],
  AnyCollection
>

export interface UseCollectionOptions<TCollection extends AnyCollection> {
  all?: boolean
  filter?: MaybeRefOrGetter<CollectionQuery<TCollection>>
  immediate?: boolean
  limit?: number
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

function collectionEndpoint(name: CollectionName): string {
  const path = `/api/${String(name).split("/").map(encodeURIComponent).join("/")}`
  const baseURL = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  return baseURL === "/" ? path : `${baseURL.replace(/\/+$/, "")}${path}`
}

export function useCollection<TName extends CollectionName>(
  name: TName,
  options: UseCollectionOptions<RegisteredCollection<TName>> = {},
): UseCollectionReturn<RegisteredCollection<TName>> {
  type TCollection = RegisteredCollection<TName>
  type TItem = CollectionItem<TCollection>
  type TPage = CollectionPage<TItem>

  const endpoint = collectionEndpoint(name)
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
      const filter = options.filter ? toValue(options.filter) : {}
      let cursor = reset ? undefined : nextCursor.value || undefined
      let loadedItems = reset ? [] : [...items.value]
      let response: TPage
      const seenCursors = new Set<string>()
      do {
        response = await request<TPage>(endpoint, {
          query: {
            ...filter,
            cursor,
            limit: options.limit,
          },
          signal: controller.signal,
        })
        if (active !== controller) return
        loadedItems = [...loadedItems, ...response.items]
        cursor = response.nextCursor || undefined
        if (cursor && seenCursors.has(cursor)) {
          throw new TypeError("[vitehub] Collection returned the same cursor twice.")
        }
        if (cursor) seenCursors.add(cursor)
      } while (options.all === true && cursor)

      items.value = loadedItems
      nextCursor.value = response.nextCursor
      loaded = true
      return { items: loadedItems, nextCursor: response.nextCursor }
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
    () => (options.filter ? toValue(options.filter) : undefined),
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
