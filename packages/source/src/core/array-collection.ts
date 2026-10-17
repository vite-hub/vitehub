import type { StandardSchemaV1 } from "@standard-schema/spec"

import { sourceErrorDiagnostics } from "../error-diagnostics.ts"
import { CollectionCursorError, createCollectionCursorCodec } from "./collection-cursor.ts"
import { parseCollectionSchema } from "./schema.ts"

import type { CollectionFacets, CollectionFacetValue, ProviderCollectionPage, ProviderCollectionSource } from "./collection.ts"

const defaultMaxLimit = 100
const reservedQueryKeys = new Set(["cursor", "empty", "limit", "search"])

export interface ArrayCollectionSort {
  direction?: "asc" | "desc"
  /** Field path to sort by. Numbers sort numerically; other values sort as strings. */
  field: string
}

export interface ArrayCollectionOptions<TFilter extends string = string> {
  /**
   * Field paths clients may filter by. `?category=guide` matches case-insensitively, a repeated key matches any of
   * its values, and `?empty=category` matches items with no value at that path. Dot paths read nested objects and
   * every element of nested arrays.
   */
  filters?: readonly TFilter[]
  /** Field paths that the `search` query matches as a case-insensitive substring. Omit to reject `search`. */
  search?: readonly string[]
  /** Order of every page. Omit to keep the array order. */
  sort?: ArrayCollectionSort
  /** Field paths counted into `page.facets` over every matching item. */
  facets?: readonly string[]
  /** Field path that `collection.get(key)` matches. Omit to leave the Collection without `get()`. */
  key?: string
  /** Page size when the caller omits `limit` (default `50`). */
  defaultLimit?: number
  /** Largest accepted `limit` and the most values kept per facet (default `100`). */
  maxLimit?: number
}

/** Items plus an optional content digest. Without `digest`, the Collection hashes the items to bind its cursors. */
export interface ArrayCollectionSnapshot<TItem> {
  digest?: string
  items: readonly TItem[]
}

export type ArrayCollectionLoader<TItem> = (options: { signal?: AbortSignal }) =>
  | Promise<readonly TItem[] | ArrayCollectionSnapshot<TItem>>
  | readonly TItem[]
  | ArrayCollectionSnapshot<TItem>

/** Request query accepted by an array Collection route and by `useCollection({ filter })`. */
export type ArrayCollectionQueryInput<TFilter extends string = string> = {
  [TKey in TFilter]?: string | readonly string[]
} & {
  empty?: TFilter | readonly TFilter[]
  search?: string
}

/** Parsed query that an array Collection evaluates. Values match case-insensitively. */
export type ArrayCollectionQuery<TFilter extends string = string> = {
  [TKey in TFilter]?: readonly string[]
} & {
  empty?: readonly TFilter[]
  search?: string
}

interface NormalizedQuery {
  empty: string[]
  filters: Record<string, string[]>
  search: string
}

type ArrayCursor = {
  digest: string
  offset: number
  query: string
}

const arrayCursorSchema: StandardSchemaV1<ArrayCursor, ArrayCursor> = {
  "~standard": {
    version: 1,
    vendor: "vite-hub",
    validate(value) {
      const cursor = Object(value)
      const digest: unknown = Reflect.get(cursor, "digest")
      const offset: unknown = Reflect.get(cursor, "offset")
      const query: unknown = Reflect.get(cursor, "query")
      if (Object(value) !== value || String(digest) !== digest || String(query) !== query
        || !Number.isSafeInteger(offset) || Number(offset) < 0 || Reflect.ownKeys(cursor).length !== 3) {
        return { issues: [{ message: "Array Collection cursor is malformed." }] }
      }
      return { value: { digest: String(digest), offset: Number(offset), query: String(query) } }
    },
  },
}

const cursorCodec = createCollectionCursorCodec(arrayCursorSchema)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

/** Read a dot path through own properties. Arrays fan out to every element. */
function collectionValueAt(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean)
  function visit(current: unknown, remaining: string[]): unknown {
    if (!remaining.length) return current
    if (Array.isArray(current)) return current.map(item => visit(item, remaining)).filter(item => item !== undefined)
    if (!isRecord(current)) return
    const segment = remaining[0]!
    if (!Object.hasOwn(current, segment)) return
    return visit(current[segment], remaining.slice(1))
  }
  return visit(value, segments)
}

// Validated items often carry Dates (`z.coerce.date()`). Treat a valid Date as its ISO string for filters, search,
// and facets, and as its timestamp for sorting.
function dateTime(value: unknown): number | undefined {
  if (Object.prototype.toString.call(value) !== "[object Date]") return
  const time = Date.prototype.getTime.call(value)
  return Number.isNaN(time) ? undefined : time
}

function scalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues)
  const time = dateTime(value)
  if (time !== undefined) return [new Date(time).toISOString()]
  if (value === null || value === undefined || Object(value) === value) return []
  return [String(value)]
}

function firstScalar(value: unknown): unknown {
  const entry = Array.isArray(value)
    ? value.flat(Infinity).find(item => item !== null && item !== undefined && (Object(item) !== item || dateTime(item) !== undefined))
    : value
  return dateTime(entry) ?? entry
}

function isString(value: unknown): value is string {
  return String(value) === value
}

function stringList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((entry): entry is string => String(entry) === entry)
}

async function sha256(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function assertFieldList(label: string, fields: readonly string[] | undefined): void {
  if (fields === undefined) return
  if (!Array.isArray(fields) || fields.some(field => String(field) !== field || !field)) {
    throw sourceErrorDiagnostics.SOURCE_R0028({ message: `[vitehub] array() ${label} must be a list of field paths.` })
  }
}

// Server code may filter on any field path; parseQuery() limits HTTP callers to the declared filters.
function normalizeQuery(query: Readonly<Record<string, unknown>>): NormalizedQuery {
  const filters: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  const normalized: NormalizedQuery = { empty: [], filters, search: "" }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (key === "search") {
      normalized.search = String(value).trim().toLocaleLowerCase()
      continue
    }
    if (key === "empty") {
      normalized.empty = [...new Set(stringList(value))].sort()
      continue
    }
    const values = stringList(value).map(entry => entry.toLocaleLowerCase())
    if (values.length) filters[key] = [...new Set(values)].sort()
  }
  normalized.filters = Object.fromEntries(Object.keys(filters).sort().map(key => [key, filters[key]!]))
  return normalized
}

function matches(item: unknown, query: NormalizedQuery, searchFields: readonly string[]): boolean {
  for (const [field, expected] of Object.entries(query.filters)) {
    const values = scalarValues(collectionValueAt(item, field)).map(value => value.toLocaleLowerCase())
    if (!expected.some(candidate => values.includes(candidate))) return false
  }
  for (const field of query.empty) {
    if (scalarValues(collectionValueAt(item, field)).length) return false
  }
  if (query.search) {
    return searchFields.some(field => scalarValues(collectionValueAt(item, field))
      .some(value => value.toLocaleLowerCase().includes(query.search)))
  }
  return true
}

function sortItems<TItem>(items: TItem[], sort: ArrayCollectionSort | undefined): TItem[] {
  if (!sort) return items
  const direction = sort.direction === "desc" ? -1 : 1
  return items.sort((left, right) => {
    const leftValue = firstScalar(collectionValueAt(left, sort.field))
    const rightValue = firstScalar(collectionValueAt(right, sort.field))
    if (Number(leftValue) === leftValue && Number(rightValue) === rightValue) return (leftValue - rightValue) * direction
    return String(leftValue ?? "").localeCompare(String(rightValue ?? "")) * direction
  })
}

function buildFacets(items: readonly unknown[], fields: readonly string[], maxValues: number): CollectionFacets {
  return Object.fromEntries(fields.map((field) => {
    const counts = new Map<string, number>()
    for (const item of items) {
      for (const value of new Set(scalarValues(collectionValueAt(item, field)))) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    const values: CollectionFacetValue[] = [...counts].map(([value, count]) => ({ count, value }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, maxValues)
    return [field, values]
  }))
}

/**
 * A Collection source that filters, searches, sorts, counts, and pages an array in memory.
 *
 * `load` runs on every request, so keep the array bounded. Cursors are bound to the data digest and the query:
 * a cursor from changed data or another query is rejected as stale (`409` on the generated route).
 *
 * Pass `schema` to validate every item on load and type the items from its output.
 *
 * @example
 * export const articles = defineCollection({
 *   source: array(() => loadArticles(), { filters: ['category'], search: ['title'], facets: ['category'] }),
 * })
 */
export function array<TSchema extends StandardSchemaV1, const TFilter extends string = never>(
  load: readonly unknown[] | ArrayCollectionLoader<unknown>,
  options: ArrayCollectionOptions<TFilter> & { schema: TSchema },
): ProviderCollectionSource<StandardSchemaV1.InferOutput<TSchema>, ArrayCollectionQuery<TFilter>, ArrayCollectionQueryInput<TFilter>>
export function array<TItem, const TFilter extends string = never>(
  load: readonly TItem[] | ArrayCollectionLoader<TItem>,
  options?: ArrayCollectionOptions<TFilter> & { schema?: undefined },
): ProviderCollectionSource<TItem, ArrayCollectionQuery<TFilter>, ArrayCollectionQueryInput<TFilter>>
export function array<TItem, const TFilter extends string = never>(
  load: readonly TItem[] | ArrayCollectionLoader<TItem>,
  options: ArrayCollectionOptions<TFilter> & { schema?: StandardSchemaV1<unknown, TItem> } = {},
): ProviderCollectionSource<TItem, ArrayCollectionQuery<TFilter>, ArrayCollectionQueryInput<TFilter>> {
  assertFieldList("filters", options.filters)
  assertFieldList("search", options.search)
  assertFieldList("facets", options.facets)
  const reserved = options.filters?.find(field => reservedQueryKeys.has(field))
  if (reserved) {
    throw sourceErrorDiagnostics.SOURCE_R0028({ message: `[vitehub] array() filter ${JSON.stringify(reserved)} collides with a reserved query key.` })
  }
  if (options.sort !== undefined && (!isRecord(options.sort) || String(options.sort.field) !== options.sort.field || !options.sort.field)) {
    throw sourceErrorDiagnostics.SOURCE_R0028({ message: "[vitehub] array() sort must name a field." })
  }
  const filters = new Set<string>(options.filters ?? [])
  // options.filters is the TFilter list, so membership proves the literal type.
  const isFilter = (key: string): key is TFilter => filters.has(key)
  const searchFields = options.search ?? []
  const facetFields = options.facets ?? []
  const maxValues = options.maxLimit ?? defaultMaxLimit
  const signatureFields = JSON.stringify({ search: [...searchFields].sort(), sort: options.sort ? { direction: options.sort.direction ?? "asc", field: options.sort.field } : null })

  async function snapshot(signal: AbortSignal | undefined): Promise<{ digest: string, items: readonly TItem[] }> {
    const result = typeof load === "function" ? await load({ signal }) : load
    signal?.throwIfAborted()
    const items: unknown = Array.isArray(result) ? result : Reflect.get(Object(result), "items")
    if (!Array.isArray(items)) {
      throw sourceErrorDiagnostics.SOURCE_R0009({ message: "[vitehub] array() load must return an array or { items, digest }." })
    }
    const digest: unknown = Array.isArray(result) ? undefined : Reflect.get(Object(result), "digest")
    if (digest !== undefined && (String(digest) !== digest || !digest)) {
      throw sourceErrorDiagnostics.SOURCE_R0009({ message: "[vitehub] array() digest must be a non-empty string." })
    }
    const contentDigest = String(digest ?? await sha256(JSON.stringify(items)))
    const schema = options.schema
    if (schema) {
      const parsed = await Promise.all(items.map(async (item, index) => {
        try {
          return await parseCollectionSchema(schema, item)
        }
        catch (cause) {
          throw sourceErrorDiagnostics.SOURCE_R0006({ cause, message: `[vitehub] array() item ${index} does not match its schema: ${cause instanceof Error ? cause.message : String(cause)}` })
        }
      }))
      return { digest: contentDigest, items: parsed }
    }
    // SAFETY: Without a schema, the loader's declared element type is the item contract.
    return { digest: contentDigest, items: items as readonly TItem[] }
  }

  const querySchema: StandardSchemaV1<ArrayCollectionQueryInput<TFilter>, ArrayCollectionQuery<TFilter>> = {
    "~standard": {
      version: 1,
      vendor: "vite-hub",
      validate(value) {
        if (!isRecord(value)) return { issues: [{ message: "Collection query must be an object." }] }
        const filterValues: { [TKey in TFilter]?: string[] } = Object.create(null) as { [TKey in TFilter]?: string[] }
        let empty: TFilter[] | undefined
        let search: string | undefined
        for (const [key, raw] of Object.entries(value)) {
          if (raw === undefined || raw === null) continue
          const values: unknown[] = Array.isArray(raw) ? raw : [raw]
          if (!values.every(isString)) return { issues: [{ message: `Collection query ${JSON.stringify(key)} must be a string.` }] }
          if (key === "search") {
            if (values.length !== 1) return { issues: [{ message: "Collection search must have one value." }] }
            if (values[0] && !searchFields.length) return { issues: [{ message: "Collection search is not enabled." }] }
            search = values[0]
            continue
          }
          if (key === "empty") {
            const unknown = values.find(field => !isFilter(field))
            if (unknown !== undefined) return { issues: [{ message: `Collection filter ${JSON.stringify(unknown)} is not allowed.` }] }
            empty = values.filter(isFilter)
            continue
          }
          if (!isFilter(key)) return { issues: [{ message: `Collection query parameter ${JSON.stringify(key)} is not allowed.` }] }
          filterValues[key] = values.map(entry => entry.trim())
        }
        const parsed: ArrayCollectionQuery<TFilter> = { ...filterValues }
        if (empty) parsed.empty = empty
        if (search !== undefined) parsed.search = search
        return { value: parsed }
      },
    },
  }

  const source: ProviderCollectionSource<TItem, ArrayCollectionQuery<TFilter>, ArrayCollectionQueryInput<TFilter>> = {
    defaultLimit: options.defaultLimit,
    maxLimit: options.maxLimit,
    pagination: "provider",
    querySchema,
    async load({ cursor, limit, query, signal }) {
      const { digest, items } = await snapshot(signal)
      const normalized = normalizeQuery(query)
      const matching = sortItems(items.filter(item => matches(item, normalized, searchFields)), options.sort)
      const signature = await sha256(`${signatureFields}\n${JSON.stringify(normalized)}`)
      const decoded = await cursorCodec.decode(cursor)
      if (decoded && (decoded.digest !== digest || decoded.query !== signature)) throw new CollectionCursorError(undefined, { reason: "stale" })
      const offset = decoded?.offset ?? 0
      if (offset > matching.length) throw new CollectionCursorError()
      const pageItems = matching.slice(offset, offset + limit)
      const nextOffset = offset + pageItems.length
      const page: ProviderCollectionPage<TItem> = {
        items: pageItems,
        nextCursor: nextOffset < matching.length ? cursorCodec.encode({ digest, offset: nextOffset, query: signature }) : null,
        total: matching.length,
      }
      if (facetFields.length) page.facets = buildFacets(matching, facetFields, maxValues)
      return page
    },
  }
  const key = options.key
  if (key !== undefined) {
    if (String(key) !== key || !key) throw sourceErrorDiagnostics.SOURCE_R0028({ message: "[vitehub] array() key must be a field path." })
    source.get = async (value, { signal }) => {
      const { items } = await snapshot(signal)
      return items.find(item => scalarValues(collectionValueAt(item, key)).includes(value)) ?? null
    }
  }
  return source
}
