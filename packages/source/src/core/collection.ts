import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { AccessAuthorizeOption } from "@vite-hub/runtime"
import { sourceErrorDiagnostics } from "../error-diagnostics.ts"
import { createCollectionCursorCodec } from "./collection-cursor.ts"
import { parseCollectionSchema } from "./schema.ts"

export { CollectionCursorError } from "./collection-cursor.ts"

const defaultPageLimit = 50
const defaultMaxLimit = 100
declare const collectionQueryInput: unique symbol

export type CollectionRequestQuery = Record<string, string | readonly string[] | undefined>

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
  /** Access rule for the generated route. Omit it for a public Collection. */
  readonly authorize?: AccessAuthorizeOption
  readonly route?: false
  readonly get?: (key: string, options?: { signal?: AbortSignal }) => Promise<TItem | null | undefined>
  page(options: CollectionPageOptions<TQuery>): Promise<CollectionPage<TItem>>
  parseQuery(input: CollectionRequestQuery): Promise<TQuery>
  /** The query schema, when the Collection has one. Tools read it to describe accepted query keys. */
  readonly querySchema?: StandardSchemaV1<unknown, TQuery>
}

export type AnyCollection = Collection<any, any, any>

export type CollectionItem<TCollection extends AnyCollection> =
  TCollection extends Collection<infer TItem, any, any> ? TItem : never

type JSONOmitted = undefined | ((...args: any[]) => any) | symbol

// TypeScript cannot structurally distinguish every class instance from a POJO interface. The handler rejects
// non-plain prototypes at runtime; these built-ins are the unsupported object shapes it can also identify statically.
type JSONUnsupportedObject =
  | ArrayBuffer
  | ArrayBufferView
  | Date
  | Error
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | RegExp
  | SharedArrayBuffer
  | URL
  | WeakMap<object, unknown>
  | WeakSet<object>

type JSONOmittedBranch<T> = T extends { toJSON(): infer TJSON }
  ? TJSON extends JSONOmitted
    ? TJSON
    : never
  : T extends JSONOmitted
    ? T
    : never

// This projection describes decoded successful response bodies. Unsupported active values fail serialization,
// so distributive union members that cannot occur in a successful body project to never.
type JSONSerializedValue<T> = T extends { toJSON(): infer TJSON }
  ? JSONSerializedPostToJSON<TJSON>
  : JSONSerializedPostToJSON<T>

type JSONSerializedPostToJSON<T> = T extends bigint | JSONUnsupportedObject
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

type JSONSerialized<T> = T extends unknown ? JSONSerializedValue<T> : never

type JSONSerializedArrayItem<T> = T extends { toJSON(): infer TJSON }
  ? JSONSerializedArrayValue<TJSON>
  : JSONSerializedArrayValue<T>

type JSONSerializedArrayValue<T> = T extends JSONOmitted ? null : JSONSerializedPostToJSON<T>

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

export type ProviderCollectionLoader<TSourceItem, TQuery extends object> = (options: {
  cursor?: string
  limit: number
  query: TQuery
  signal?: AbortSignal
}) => Promise<{ items: readonly TSourceItem[]; nextCursor: string | null }>

type CollectionTransform<TSourceItem> = (item: NoInfer<TSourceItem>) => unknown

export interface CollectionOptions<
  TSourceItem,
  TQuery extends object,
  TCursorInput extends CollectionCursorValue,
  TCursorOutput extends CollectionCursorValue = TCursorInput,
> {
  /** `true` requires a signed-in Auth session. A callback also decides each request after sign-in. */
  authorize?: AccessAuthorizeOption
  cursor(item: NoInfer<TSourceItem>): Readonly<TCursorInput>
  cursorSchema: StandardSchemaV1<TCursorInput, TCursorOutput>
  defaultLimit?: number
  maxLimit?: number
  querySchema?: StandardSchemaV1<unknown, TQuery>
  transform?: CollectionTransform<TSourceItem>
  get?: (key: string, options: { signal?: AbortSignal }) => Promise<TSourceItem | null | undefined>
  route?: false
}

export interface ProviderCollectionOptions<TSourceItem, TQuery extends object, TItem = TSourceItem> {
  authorize?: AccessAuthorizeOption
  route?: false
  pagination: "provider"
  get?: (key: string, options: { signal?: AbortSignal }) => Promise<TSourceItem | null | undefined>
  defaultLimit?: number
  maxLimit?: number
  querySchema?: StandardSchemaV1<unknown, TQuery>
  transform?: (item: NoInfer<TSourceItem>) => Promise<TItem> | TItem
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

// H3 represents no value as undefined, one value as a string, and repeated values as an array of two or more strings.
type RepeatedQueryValues = [string, string, ...string[]]

type AmbiguousArrayQueryKey<TInput extends object> = {
  [TKey in keyof TInput]-?: [Extract<TInput[TKey], readonly string[]>] extends [never]
    ? never
    : RepeatedQueryValues extends TInput[TKey]
      ? string extends TInput[TKey]
        ? undefined extends TInput[TKey]
          ? never
          : TKey
        : TKey
      : TKey
}[keyof TInput]

type ReservedCollectionQueryKey = "cursor" | "limit"

export type CollectionQueryInput<TInput> = TInput extends object
  ? [Exclude<keyof TInput, string>] extends [never]
    ? [Extract<ReservedCollectionQueryKey, keyof TInput>] extends [never]
      ? [TInput[keyof TInput]] extends [CollectionRequestQuery[string]]
        ? [AmbiguousArrayQueryKey<TInput>] extends [never]
          ? TInput
          : never
        : never
      : never
    : never
  : never

type QueryInput<TSchema extends StandardSchemaV1> = CollectionQueryInput<StandardSchemaV1.InferInput<TSchema>>

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw sourceErrorDiagnostics.SOURCE_R0004({ message: `[vitehub] Collection ${label} must be a positive integer.` })
  }
}

function resolveLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (limit !== undefined) assertPositiveInteger(limit, "limit")
  return Math.min(limit ?? defaultLimit, maxLimit)
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
  TQuerySchema extends StandardSchemaV1<unknown, object>,
  TItem = TSourceItem,
>(
  load: ProviderCollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>>,
  options: ProviderCollectionOptions<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, TItem> & {
    querySchema: TQuerySchema
  },
): Collection<TItem, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>>
export function defineCollection<TSourceItem, TItem = TSourceItem>(
  load: ProviderCollectionLoader<TSourceItem, CollectionRequestQuery>,
  options: ProviderCollectionOptions<TSourceItem, CollectionRequestQuery, TItem> & { querySchema?: undefined },
): Collection<TItem, CollectionRequestQuery, CollectionRequestQuery>
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
  load: CollectionLoader<TSourceItem, TQuery, TCursorOutput> | ProviderCollectionLoader<TSourceItem, TQuery>,
  definition: (CollectionOptions<TSourceItem, TQuery, TCursorInput, TCursorOutput> | ProviderCollectionOptions<TSourceItem, TQuery, TItem>) & {
    transform?: (item: NoInfer<TSourceItem>) => Promise<TItem> | TItem
  },
): Collection<TItem, TQuery, object> {
  const defaultLimit = definition.defaultLimit ?? defaultPageLimit
  const maxLimit = definition.maxLimit ?? defaultMaxLimit
  assertPositiveInteger(defaultLimit, "defaultLimit")
  assertPositiveInteger(maxLimit, "maxLimit")
  if (defaultLimit > maxLimit) {
    throw sourceErrorDiagnostics.SOURCE_R0008({ message: "[vitehub] Collection defaultLimit cannot exceed maxLimit." })
  }
  const cursorDefinition = "cursorSchema" in definition ? definition : undefined
  const cursorCodec = cursorDefinition ? createCollectionCursorCodec(cursorDefinition.cursorSchema) : undefined
  const authorize = definition.authorize
  if (authorize !== undefined && authorize !== true && !(authorize instanceof Function)) {
    throw sourceErrorDiagnostics.SOURCE_R0024({ message: "[vitehub] Collection authorize must be true or a function." })
  }

  const collection: Collection<TItem, TQuery, object> = {
    ...(authorize ? { authorize } : {}),
    route: definition.route,
    async page(request) {
      const limit = resolveLimit(request.limit, defaultLimit, maxLimit)
      if (!cursorDefinition || !cursorCodec) {
        // SAFETY: The provider overload pairs a provider definition with a provider loader.
        const result = await (load as ProviderCollectionLoader<TSourceItem, TQuery>)({ cursor: request.cursor, limit, query: request.query, signal: request.signal })
        if (!result || !Array.isArray(result.items) || (result.nextCursor !== null && !isProviderCursor(result.nextCursor))) {
          throw sourceErrorDiagnostics.SOURCE_R0009({ message: "[vitehub] Provider Collection load() must return items and nextCursor." })
        }
        const transformedItems = definition.transform ? await Promise.all(result.items.map(definition.transform)) : result.items
        // SAFETY: Without transform the overload fixes TItem to TSourceItem; otherwise each item was transformed.
        const items = transformedItems as TItem[]
        return { items, nextCursor: result.nextCursor }
      }
      // SAFETY: A cursor definition is paired with a cursor loader by the public overloads.
      const sourceItems = await (load as CollectionLoader<TSourceItem, TQuery, TCursorOutput>)({ cursor: await cursorCodec.decode(request.cursor), limit: limit + 1, query: request.query, signal: request.signal })
      if (!Array.isArray(sourceItems)) {
        throw sourceErrorDiagnostics.SOURCE_R0009({ message: "[vitehub] Collection load() must return an array." })
      }
      const hasMore = sourceItems.length > limit
      const pageItems = sourceItems.slice(0, limit)
      const nextCursor =
        hasMore && pageItems.length
          ? cursorCodec.encode(cursorDefinition.cursor(pageItems[pageItems.length - 1]!))
          : null
      const transformedItems = definition.transform ? await Promise.all(pageItems.map(definition.transform)) : pageItems
      // SAFETY: The overload without transform fixes TItem to TSourceItem; the other branch ran the typed transform.
      const items = transformedItems as TItem[]
      return {
        items,
        nextCursor,
      }
    },
    async parseQuery(input) {
      if (definition.querySchema) return await parseCollectionSchema(definition.querySchema, input)
      // SAFETY: CollectionRequestQuery is the owned default contract when no custom query schema is supplied.
      return input as TQuery
    },
    ...(definition.querySchema ? { querySchema: definition.querySchema } : {}),
  }
  const get = definition.get
  if (get) {
    const lookup = async (key: string, options?: { signal?: AbortSignal }) => {
      const item = await get(key, options ?? {})
      if (item === null || item === undefined) return item
      return definition.transform ? await definition.transform(item) : item
    }
    // SAFETY: The overload without transform fixes TItem to TSourceItem; otherwise lookup applies the typed transform.
    Object.assign(collection, { get: lookup as NonNullable<Collection<TItem>["get"]> })
  }
  return collection
}

function isProviderCursor(value: unknown): value is string {
  return value === String(value)
}
