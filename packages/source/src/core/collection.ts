import type { StandardSchemaV1 } from "@standard-schema/spec"

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
  parseQuery(input: CollectionRequestQuery): Promise<TQuery>
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

export type CollectionTransform<TSourceItem> = (item: NoInfer<TSourceItem>) => unknown

export interface CollectionOptions<
  TSourceItem,
  TQuery extends object,
  TCursor extends CollectionCursorValue,
> {
  cursor(item: NoInfer<TSourceItem>): Readonly<TCursor>
  cursorSchema: StandardSchemaV1<unknown, TCursor>
  defaultLimit?: number
  maxLimit?: number
  querySchema?: StandardSchemaV1<unknown, TQuery>
  transform?: CollectionTransform<TSourceItem>
}

type CollectionDefinition<
  TSourceItem,
  TQuery extends object,
  TCursor extends CollectionCursorValue,
> = Omit<
  CollectionOptions<TSourceItem, TQuery, TCursor>,
  "cursorSchema" | "querySchema" | "transform"
>

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

async function parseSchema<TOutput>(
  schema: StandardSchemaV1<unknown, TOutput>,
  value: unknown,
): Promise<TOutput> {
  const result = await schema["~standard"].validate(value)
  if (result.issues)
    throw new TypeError(result.issues[0]?.message ?? "Collection value is invalid.")
  return result.value
}

async function decodeCursor<TCursor extends CollectionCursorValue>(
  value: string | undefined,
  schema: StandardSchemaV1<unknown, TCursor>,
): Promise<TCursor | undefined> {
  if (!value) return
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeBase64Url(value))
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
  if (!isCursorValue(decoded)) throw new CollectionCursorError()
  try {
    return await parseSchema(schema, decoded)
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
}

export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1<unknown, CollectionCursorValue>,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: CollectionLoader<
    TSourceItem,
    StandardSchemaV1.InferOutput<TQuerySchema>,
    StandardSchemaV1.InferOutput<TCursorSchema>
  >,
  options: CollectionDefinition<
    TSourceItem,
    StandardSchemaV1.InferOutput<TQuerySchema>,
    StandardSchemaV1.InferOutput<TCursorSchema>
  > & {
    cursorSchema: TCursorSchema
    querySchema: TQuerySchema
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, StandardSchemaV1.InferOutput<TQuerySchema>>
export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1<unknown, CollectionCursorValue>,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
>(
  load: CollectionLoader<
    TSourceItem,
    StandardSchemaV1.InferOutput<TQuerySchema>,
    StandardSchemaV1.InferOutput<TCursorSchema>
  >,
  options: CollectionDefinition<
    TSourceItem,
    StandardSchemaV1.InferOutput<TQuerySchema>,
    StandardSchemaV1.InferOutput<TCursorSchema>
  > & {
    cursorSchema: TCursorSchema
    querySchema: TQuerySchema
    transform?: undefined
  },
): Collection<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>>
export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1<unknown, CollectionCursorValue>,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: CollectionLoader<
    TSourceItem,
    CollectionRequestQuery,
    StandardSchemaV1.InferOutput<TCursorSchema>
  >,
  options: CollectionDefinition<
    TSourceItem,
    CollectionRequestQuery,
    StandardSchemaV1.InferOutput<TCursorSchema>
  > & {
    cursorSchema: TCursorSchema
    querySchema?: undefined
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, CollectionRequestQuery>
export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1<unknown, CollectionCursorValue>,
>(
  load: CollectionLoader<
    TSourceItem,
    CollectionRequestQuery,
    StandardSchemaV1.InferOutput<TCursorSchema>
  >,
  options: CollectionDefinition<
    TSourceItem,
    CollectionRequestQuery,
    StandardSchemaV1.InferOutput<TCursorSchema>
  > & {
    cursorSchema: TCursorSchema
    querySchema?: undefined
    transform?: undefined
  },
): Collection<TSourceItem, CollectionRequestQuery>
export function defineCollection<
  TSourceItem,
  const TCursor extends CollectionCursorValue,
  const TQuery extends object,
  TItem = TSourceItem,
>(
  load: CollectionLoader<TSourceItem, TQuery, TCursor>,
  definition: CollectionOptions<TSourceItem, TQuery, TCursor> & {
    transform?: (item: NoInfer<TSourceItem>) => Promise<TItem> | TItem
  },
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
        cursor: await decodeCursor(request.cursor, definition.cursorSchema),
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
            ? encodeCursor(definition.cursor(pageItems[pageItems.length - 1]!) as CollectionCursorValue)
            : null,
      }
    },
    async parseQuery(input) {
      return definition.querySchema
        ? await parseSchema(definition.querySchema, input)
        : (input as TQuery)
    },
  }
}
