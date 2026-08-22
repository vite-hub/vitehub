import type { StandardSchemaV1 } from "@standard-schema/spec"

const defaultPageLimit = 50
const defaultMaxLimit = 100
declare const collectionQueryInput: unique symbol

export type CollectionRequestQuery = Record<string, string | string[] | undefined>

export type CollectionCursorValue =
  | boolean
  | null
  | number
  | string
  | readonly CollectionCursorValue[]
  | { readonly [key: string]: CollectionCursorValue }

export interface CollectionLoadOptions<TQuery extends object, TCursor extends CollectionCursorValue> {
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

export interface Collection<
  TItem,
  TQuery extends object = CollectionRequestQuery,
  TQueryInput extends object = TQuery,
> {
  readonly [collectionQueryInput]?: TQueryInput
  page(options: CollectionPageOptions<TQuery>): Promise<CollectionPage<TItem>>
  parseQuery(input: CollectionRequestQuery): Promise<TQuery>
}

export type AnyCollection = Collection<any, any, any>

export type CollectionItem<TCollection extends AnyCollection> =
  TCollection extends Collection<infer TItem, any, any> ? TItem : never

type JSONOmitted = undefined | ((...args: any[]) => any) | symbol

type JSONOmittedBranch<T> = T extends { toJSON(): infer TJSON }
  ? JSONOmittedBranch<TJSON>
  : T extends JSONOmitted
    ? T
    : never

type JSONSerialized<T> = T extends { toJSON(): infer TJSON }
  ? JSONSerialized<TJSON>
  : T extends bigint
    ? never
    : T extends number
      ? number | null
      : T extends boolean | null | string
        ? T
        : T extends readonly (infer TItem)[]
          ? Array<JSONSerializedArrayItem<TItem>>
          : T extends object
            ? JSONSerializedObject<T>
            : never

type JSONSerializedArrayItem<T> = T extends { toJSON(): infer TJSON }
  ? JSONSerializedArrayValue<TJSON>
  : JSONSerializedArrayValue<T>

type JSONSerializedArrayValue<T> = T extends JSONOmitted ? null : JSONSerialized<T>

type Simplify<T> = { [TKey in keyof T]: T[TKey] }

type JSONSerializedObject<T extends object> = Simplify<{
  [TKey in keyof T as TKey extends symbol
    ? never
    : [JSONOmittedBranch<T[TKey]>] extends [never]
      ? TKey
      : never]: JSONSerialized<T[TKey]>
} & {
  [TKey in keyof T as TKey extends symbol
    ? never
    : [JSONOmittedBranch<T[TKey]>] extends [never]
      ? never
      : [JSONSerialized<T[TKey]>] extends [never]
        ? never
        : TKey]?: JSONSerialized<T[TKey]>
}>

export type CollectionClientItem<TCollection extends AnyCollection> = JSONSerializedArrayItem<
  CollectionItem<TCollection>
>

export type CollectionQuery<TCollection extends AnyCollection> =
  TCollection extends Collection<any, any, infer TQueryInput> ? TQueryInput : never

export type CollectionLoader<TSourceItem, TQuery extends object, TCursor extends CollectionCursorValue> = (
  options: CollectionLoadOptions<TQuery, TCursor>,
) => Promise<readonly TSourceItem[]>

type CollectionTransform<TSourceItem> = (item: NoInfer<TSourceItem>) => unknown

export interface CollectionOptions<
  TSourceItem,
  TQuery extends object,
  TCursorInput extends CollectionCursorValue,
  TCursorOutput extends CollectionCursorValue = TCursorInput,
> {
  cursor(item: NoInfer<TSourceItem>): Readonly<TCursorInput>
  cursorSchema: StandardSchemaV1<TCursorInput, TCursorOutput>
  defaultLimit?: number
  maxLimit?: number
  querySchema?: StandardSchemaV1<unknown, TQuery>
  transform?: CollectionTransform<TSourceItem>
}

type CollectionDefinition<TSourceItem, TQuery extends object, TCursorInput extends CollectionCursorValue> = Omit<
  CollectionOptions<TSourceItem, TQuery, TCursorInput>,
  "cursorSchema" | "querySchema" | "transform"
>

type CursorInput<TSchema extends StandardSchemaV1> = [StandardSchemaV1.InferInput<TSchema>] extends [
  CollectionCursorValue,
]
  ? StandardSchemaV1.InferInput<TSchema>
  : never

type CursorOutput<TSchema extends StandardSchemaV1> = [StandardSchemaV1.InferOutput<TSchema>] extends [
  CollectionCursorValue,
]
  ? StandardSchemaV1.InferOutput<TSchema>
  : never

type QueryInput<TSchema extends StandardSchemaV1> = [StandardSchemaV1.InferInput<TSchema>] extends [
  CollectionRequestQuery,
]
  ? StandardSchemaV1.InferInput<TSchema>
  : never

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
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function isCursorValue(value: unknown): value is CollectionCursorValue {
  if (Number(value) === value) return Number.isFinite(Number(value)) && !Object.is(value, -0)
  if (value === null || value === true || value === false || String(value) === value) return true
  if (Array.isArray(value)) return value.every(isCursorValue)
  if (Object(value) !== value || value instanceof Function) return false
  return Object.values(Object(value)).every(isCursorValue)
}

function encodeCursor(value: CollectionCursorValue): string {
  if (!isCursorValue(value)) {
    throw new TypeError("[vitehub] Collection cursor() must return a JSON-serializable value.")
  }
  return encodeBase64Url(JSON.stringify(value))
}

async function parseSchema<TOutput>(schema: StandardSchemaV1<unknown, TOutput>, value: unknown): Promise<TOutput> {
  const result = await schema["~standard"].validate(value)
  if (result.issues) throw new TypeError(result.issues[0]?.message ?? "Collection value is invalid.")
  return result.value
}

async function decodeCursor<TCursorInput extends CollectionCursorValue, TCursorOutput extends CollectionCursorValue>(
  value: string | undefined,
  schema: StandardSchemaV1<TCursorInput, TCursorOutput>,
): Promise<TCursorOutput | undefined> {
  if (value === undefined) return
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeBase64Url(value))
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
  if (!isCursorValue(decoded)) throw new CollectionCursorError()
  try {
    const cursor = await parseSchema(schema, decoded)
    if (!isCursorValue(cursor)) {
      throw new TypeError("Collection cursor schema returned an invalid value.")
    }
    return cursor
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
}

export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: CollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, CursorOutput<TCursorSchema>>,
  options: CollectionDefinition<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, CursorInput<TCursorSchema>> & {
    cursorSchema: TCursorSchema
    querySchema: TQuerySchema
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>>
export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
>(
  load: CollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, CursorOutput<TCursorSchema>>,
  options: CollectionDefinition<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, CursorInput<TCursorSchema>> & {
    cursorSchema: TCursorSchema
    querySchema: TQuerySchema
    transform?: undefined
  },
): Collection<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>>
export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: CollectionLoader<TSourceItem, CollectionRequestQuery, CursorOutput<TCursorSchema>>,
  options: CollectionDefinition<TSourceItem, CollectionRequestQuery, CursorInput<TCursorSchema>> & {
    cursorSchema: TCursorSchema
    querySchema?: undefined
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, CollectionRequestQuery, CollectionRequestQuery>
export function defineCollection<TSourceItem, TCursorSchema extends StandardSchemaV1>(
  load: CollectionLoader<TSourceItem, CollectionRequestQuery, CursorOutput<TCursorSchema>>,
  options: CollectionDefinition<TSourceItem, CollectionRequestQuery, CursorInput<TCursorSchema>> & {
    cursorSchema: TCursorSchema
    querySchema?: undefined
    transform?: undefined
  },
): Collection<TSourceItem, CollectionRequestQuery, CollectionRequestQuery>
export function defineCollection<
  TSourceItem,
  const TCursorInput extends CollectionCursorValue,
  const TCursorOutput extends CollectionCursorValue,
  const TQuery extends object,
  TItem = TSourceItem,
>(
  load: CollectionLoader<TSourceItem, TQuery, TCursorOutput>,
  definition: CollectionOptions<TSourceItem, TQuery, TCursorInput, TCursorOutput> & {
    transform?: (item: NoInfer<TSourceItem>) => Promise<TItem> | TItem
  },
): Collection<TItem, TQuery, object> {
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
      const transformedItems = definition.transform ? await Promise.all(pageItems.map(definition.transform)) : pageItems
      // SAFETY: The overload without transform fixes TItem to TSourceItem; the other branch ran the typed transform.
      const items = transformedItems as TItem[]
      return {
        items,
        nextCursor:
          hasMore && pageItems.length
            ? // SAFETY: CollectionOptions constrains cursor output to the serializable cursor contract.
              encodeCursor(definition.cursor(pageItems[pageItems.length - 1]!) as CollectionCursorValue)
            : null,
      }
    },
    async parseQuery(input) {
      if (definition.querySchema) return await parseSchema(definition.querySchema, input)
      // SAFETY: CollectionRequestQuery is the owned default contract when no custom query schema is supplied.
      return input as TQuery
    },
  }
}
