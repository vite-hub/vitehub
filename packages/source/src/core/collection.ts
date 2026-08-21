const defaultPageLimit = 50
const defaultMaxLimit = 100

export type CollectionRequestQuery = Record<string, string | string[] | undefined>

export type CollectionCursorValue =
  | boolean
  | null
  | number
  | string
  | readonly CollectionCursorValue[]
  | { readonly [key: string]: CollectionCursorValue }

export interface CollectionLoadOptions<
  TQuery extends object,
  TCursor extends CollectionCursorValue,
> {
  cursor?: TCursor
  limit: number
  query: TQuery
  signal?: AbortSignal
}

export interface CollectionPageOptions<TQuery extends object> {
  cursor?: string
  limit?: number
  query: TQuery
  signal?: AbortSignal
}

export interface CollectionPage<TItem> {
  items: TItem[]
  nextCursor: string | null
}

export interface Collection<TItem, TQuery extends object = CollectionRequestQuery> {
  page(options: CollectionPageOptions<TQuery>): Promise<CollectionPage<TItem>>
  parseQuery(input: CollectionRequestQuery): TQuery
}

export type AnyCollection = Collection<any, any>

export type CollectionItem<TCollection extends AnyCollection> =
  TCollection extends Collection<infer TItem, any> ? TItem : never

export type CollectionQuery<TCollection extends AnyCollection> =
  TCollection extends Collection<any, infer TQuery> ? TQuery : never

export type CollectionLoader<
  TSourceItem,
  TQuery extends object,
  TCursor extends CollectionCursorValue,
> = (options: CollectionLoadOptions<TQuery, TCursor>) => Promise<readonly TSourceItem[]>

export interface CollectionOptions<
  TSourceItem,
  TItem,
  TQuery extends object,
  TCursor extends CollectionCursorValue,
> {
  cursor(item: NoInfer<TSourceItem>): TCursor
  defaultLimit?: number
  maxLimit?: number
  parseCursor?: (input: CollectionCursorValue) => TCursor
  query?: (input: CollectionRequestQuery) => TQuery
  transform?: (item: NoInfer<TSourceItem>) => Promise<TItem> | TItem
}

export class CollectionCursorError extends TypeError {
  constructor(message = "[vitehub] Collection cursor is malformed.", options?: ErrorOptions) {
    super(message, options)
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`[vitehub] Collection ${label} must be a positive integer.`)
  }
}

function resolveLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (limit !== undefined) assertPositiveInteger(limit, "limit")
  return Math.min(limit ?? defaultLimit, maxLimit)
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

function isCursorValue(value: unknown): value is CollectionCursorValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isCursorValue)
  if (!value || typeof value !== "object") return false
  return Object.values(value).every(isCursorValue)
}

function encodeCursor(value: CollectionCursorValue): string {
  if (!isCursorValue(value)) {
    throw new TypeError("[vitehub] Collection cursor() must return a JSON-serializable value.")
  }
  return encodeBase64Url(JSON.stringify(value))
}

function decodeCursor<TCursor extends CollectionCursorValue>(
  value: string | undefined,
  parse: ((input: CollectionCursorValue) => TCursor) | undefined,
): TCursor | undefined {
  if (!value) return
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeBase64Url(value))
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
  if (!isCursorValue(decoded)) throw new CollectionCursorError()
  if (!parse) return decoded as TCursor
  try {
    return parse(decoded)
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
}

export function defineCollection<
  TSourceItem,
  const TCursor extends CollectionCursorValue,
  const TQuery extends object,
  TItem = TSourceItem,
>(
  load: CollectionLoader<TSourceItem, TQuery, TCursor>,
  options: CollectionOptions<TSourceItem, TItem, TQuery, TCursor> & {
    query: (input: CollectionRequestQuery) => TQuery
  },
): Collection<TItem, TQuery>
export function defineCollection<
  TSourceItem,
  const TCursor extends CollectionCursorValue,
  TItem = TSourceItem,
>(
  load: CollectionLoader<TSourceItem, CollectionRequestQuery, TCursor>,
  options: CollectionOptions<TSourceItem, TItem, CollectionRequestQuery, TCursor> & {
    query?: undefined
  },
): Collection<TItem, CollectionRequestQuery>
export function defineCollection<
  TSourceItem,
  const TCursor extends CollectionCursorValue,
  const TQuery extends object,
  TItem = TSourceItem,
>(
  load: CollectionLoader<TSourceItem, TQuery, TCursor>,
  definition: CollectionOptions<TSourceItem, TItem, TQuery, TCursor>,
): Collection<TItem, TQuery> {
  const defaultLimit = definition.defaultLimit ?? defaultPageLimit
  const maxLimit = definition.maxLimit ?? defaultMaxLimit
  assertPositiveInteger(defaultLimit, "defaultLimit")
  assertPositiveInteger(maxLimit, "maxLimit")
  if (defaultLimit > maxLimit) {
    throw new TypeError("[vitehub] Collection defaultLimit cannot exceed maxLimit.")
  }

  return {
    async page(request) {
      const limit = resolveLimit(request.limit, defaultLimit, maxLimit)
      const sourceItems = await load({
        cursor: decodeCursor(request.cursor, definition.parseCursor),
        limit: limit + 1,
        query: request.query,
        signal: request.signal,
      })
      if (!Array.isArray(sourceItems)) {
        throw new TypeError("[vitehub] Collection load() must return an array.")
      }
      const hasMore = sourceItems.length > limit
      const pageItems = sourceItems.slice(0, limit)
      const transform = definition.transform ?? ((item: TSourceItem) => item as unknown as TItem)
      return {
        items: await Promise.all(pageItems.map(transform)),
        nextCursor:
          hasMore && pageItems.length
            ? encodeCursor(definition.cursor(pageItems[pageItems.length - 1]!))
            : null,
      }
    },
    parseQuery(input) {
      return definition.query ? definition.query(input) : (input as TQuery)
    },
  }
}
