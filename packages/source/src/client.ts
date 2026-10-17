import { Diagnostic } from "nostics"
import { $fetch } from "ofetch"
import { computed, onScopeDispose, ref, toValue, watch } from "vue"

import type { ComputedRef, MaybeRefOrGetter, Ref } from "vue"
import type { AnyCollection, CollectionClientItem, CollectionFacets, CollectionPage, CollectionQuery } from "./core/collection.ts"
import { encodeCollectionRouteSegment } from "./internal/collection-route.ts"
import { sourceErrorDiagnostics } from "./error-diagnostics.ts"

declare const __VITEHUB_APP_BASE_URL__: string

export interface CollectionRequestOptions {
  query?: Record<string, unknown>
  signal: AbortSignal
}

export type CollectionRequester = (endpoint: string, options: CollectionRequestOptions) => Promise<unknown>

declare global {
  interface ViteHubCollectionMap {}
}

export type CollectionName = Extract<keyof ViteHubCollectionMap, string>

type RegisteredCollection<TName extends CollectionName> = Extract<ViteHubCollectionMap[TName], AnyCollection>

export interface UseCollectionOptions<TCollection extends AnyCollection> {
  all?: boolean
  filter?: MaybeRefOrGetter<CollectionQuery<TCollection>>
  immediate?: boolean
  limit?: number
  request?: CollectionRequester
}

export interface UseCollectionReturn<TCollection extends AnyCollection> {
  error: Ref<unknown>
  /** Facet counts from the latest page, when the Collection declares facets. */
  facets: Ref<CollectionFacets | undefined>
  hasMore: ComputedRef<boolean>
  items: Ref<Array<CollectionClientItem<TCollection>>>
  /** Matching items across every page, when the Collection counts them. */
  total: Ref<number | undefined>
  loadMore: () => Promise<CollectionPage<CollectionClientItem<TCollection>> | undefined>
  pending: Ref<boolean>
  refresh: () => Promise<CollectionPage<CollectionClientItem<TCollection>> | undefined>
}

const defaultRequester: CollectionRequester = async (endpoint: string, options: CollectionRequestOptions) => {
  return await $fetch<unknown>(endpoint, options)
}

/** A Collection route rejected the request: `401` without a session, `403` when `authorize` denied it. */
export class CollectionAccessError extends Diagnostic {
  readonly status: 401 | 403

  constructor(status: 401 | 403, options?: ErrorOptions) {
    super({
      cause: options?.cause,
      code: "SOURCE_R0026",
      docs: "https://vitehub.dev/docs/reference/diagnostics",
      why: status === 401
        ? "[vitehub] Collection requires a signed-in session."
        : "[vitehub] Collection access is forbidden.",
    }, CollectionAccessError)
    this.name = "CollectionAccessError"
    this.status = status
  }
}

function accessError(error: unknown): CollectionAccessError | undefined {
  if (Object(error) !== error) return
  const status: unknown = Reflect.get(Object(error), "status") ?? Reflect.get(Object(error), "statusCode")
  if (status === 401 || status === 403) return new CollectionAccessError(status, { cause: error })
}

function isAbortError(error: unknown): boolean {
  return Object(error) === error && Reflect.get(Object(error), "name") === "AbortError"
}

function parseCollectionPage(value: unknown): CollectionPage<unknown> {
  if (Object(value) !== value) {
    throw sourceErrorDiagnostics.SOURCE_R0001({ message: "[vitehub] Collection response must be an object." })
  }
  const items = Reflect.get(Object(value), "items")
  const nextCursor = Reflect.get(Object(value), "nextCursor")
  if (!Array.isArray(items) || !(nextCursor === null || String(nextCursor) === nextCursor)) {
    throw sourceErrorDiagnostics.SOURCE_R0002({ message: "[vitehub] Collection response must contain items and nextCursor." })
  }
  const page: CollectionPage<unknown> = { items, nextCursor }
  const total: unknown = Reflect.get(Object(value), "total")
  if (total !== undefined) {
    if (!Number.isSafeInteger(total) || Number(total) < 0) {
      throw sourceErrorDiagnostics.SOURCE_R0002({ message: "[vitehub] Collection response total must be a non-negative integer." })
    }
    page.total = Number(total)
  }
  const facets: unknown = Reflect.get(Object(value), "facets")
  if (facets !== undefined) {
    if (!isFacets(facets)) {
      throw sourceErrorDiagnostics.SOURCE_R0002({ message: "[vitehub] Collection response facets must map fields to { value, count } lists." })
    }
    page.facets = facets
  }
  return page
}

function isFacets(value: unknown): value is CollectionFacets {
  return Object(value) === value && !Array.isArray(value) && Object.values(Object(value)).every(entries =>
    Array.isArray(entries) && entries.every(entry => Object(entry) === entry
      && String(Reflect.get(entry, "value")) === Reflect.get(entry, "value")
      && Number.isSafeInteger(Reflect.get(entry, "count"))))
}

function appBaseURL(): string {
  try {
    return __VITEHUB_APP_BASE_URL__
  } catch {
    return "/"
  }
}

function collectionEndpoint(name: CollectionName): string {
  const path = `/api/${String(name).split("/").map(encodeCollectionRouteSegment).join("/")}`
  const baseURL = appBaseURL()
  return baseURL.startsWith("/") && !baseURL.startsWith("//") && baseURL !== "/"
    ? `${baseURL.replace(/\/+$/, "")}${path}`
    : path
}

export function useCollection<TName extends CollectionName>(
  name: TName,
  options: UseCollectionOptions<RegisteredCollection<TName>> = {},
): UseCollectionReturn<RegisteredCollection<TName>> {
  type TCollection = RegisteredCollection<TName>
  type TItem = CollectionClientItem<TCollection>
  type TPage = CollectionPage<TItem>

  const endpoint = collectionEndpoint(name)
  // SAFETY: Vue unwraps array values but preserves the Collection item contract exposed by this Ref.
  const items = ref<TItem[]>([]) as Ref<TItem[]>
  const nextCursor = ref<string | null>(null)
  const total = ref<number>()
  const facets = ref<CollectionFacets>()
  const pending = ref(false)
  const error = ref<unknown>(null)
  const request = options.request || defaultRequester
  let active: AbortController | undefined
  let cursors = new Set<string>()
  let loaded = false

  async function load(reset: boolean): Promise<TPage | undefined> {
    if (!reset && (pending.value || (loaded && !nextCursor.value))) return

    if (reset) {
      cursors = new Set()
      nextCursor.value = null
      loaded = true
    }
    active?.abort()
    const controller = new AbortController()
    active = controller
    pending.value = true
    error.value = null
    try {
      const filter = options.filter ? toValue(options.filter) : {}
      let cursor = reset ? undefined : nextCursor.value || undefined
      let loadedItems = reset ? [] : [...items.value]
      let loadedTotal = reset ? undefined : total.value
      let loadedFacets = reset ? undefined : facets.value
      let response: TPage
      const seenCursors = new Set(cursors)
      if (cursor) seenCursors.add(cursor)
      do {
        const parsed = parseCollectionPage(
          await request(endpoint, {
            query: {
              ...filter,
              cursor,
              limit: options.limit,
            },
            signal: controller.signal,
          }),
        )
        // SAFETY: The generated endpoint derives its item contract from this registered Collection.
        response = { ...parsed, items: parsed.items as TItem[] }
        if (active !== controller) return
        if (response.total !== undefined) loadedTotal = response.total
        if (response.facets !== undefined) loadedFacets = response.facets
        loadedItems = [...loadedItems, ...response.items]
        cursor = response.nextCursor || undefined
        if (cursor && seenCursors.has(cursor)) {
          throw sourceErrorDiagnostics.SOURCE_R0003({ message: "[vitehub] Collection returned the same cursor twice." })
        }
        if (cursor) seenCursors.add(cursor)
      } while (options.all === true && cursor)

      items.value = loadedItems
      cursors = seenCursors
      nextCursor.value = response.nextCursor
      total.value = response.total
      facets.value = response.facets
      loaded = true
      return { ...response, items: loadedItems }
    } catch (cause) {
      if (active !== controller || isAbortError(cause)) return
      error.value = accessError(cause) ?? cause
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
      immediate: options.immediate !== false && (options.request !== undefined || "window" in globalThis),
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
    facets,
    hasMore: computed(() => Boolean(nextCursor.value)),
    items,
    loadMore: () => load(false),
    pending,
    refresh: () => load(true),
    total,
  }
}
