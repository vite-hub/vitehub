import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { AccessAuthorizeOption } from "@vite-hub/runtime"
import { sourceErrorDiagnostics } from "../error-diagnostics.ts"
import { CollectionCursorError, createCollectionCursorCodec } from "./collection-cursor.ts"
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
  /** Disable generation of an HTTP endpoint. */
  readonly route?: false
  page(options: CollectionPageOptions<TQuery>): Promise<CollectionPage<TItem>>
  parseQuery(input: TQueryInput | CollectionRequestQuery): Promise<TQuery>
  /** Read an item when the Collection was configured with a get adapter. */
  get?: (key: string, options?: CollectionReadOptions) => Promise<TItem | null>
  query(input?: TQueryInput): CollectionQueryBuilder<TItem>
  all(options?: CollectionReadOptions & { query?: TQueryInput; limit?: number }): Promise<TItem[]>
  /** The query schema, when the Collection has one. Tools read it to describe accepted query keys. */
  readonly querySchema?: StandardSchemaV1<unknown, TQuery>
}

export interface CollectionReadOptions {
  signal?: AbortSignal
}


export interface CollectionQueryBuilder<TItem> {
  select<TKey extends Extract<keyof TItem, string>>(...keys: TKey[]): CollectionQueryBuilder<Pick<TItem, TKey>>
  page(options?: CollectionReadOptions & { cursor?: string; limit?: number }): Promise<CollectionPage<TItem>>
  all(options?: CollectionReadOptions & { limit?: number }): Promise<TItem[]>
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
  TCollection extends { readonly [collectionQueryInput]?: infer TQueryInput }
    ? (string extends keyof NonNullable<TQueryInput>
      ? NonNullable<TQueryInput> extends CollectionRequestQuery ? NonNullable<TQueryInput> : never
      : CollectionQueryInput<NonNullable<TQueryInput>>) extends infer T
      ? T extends object ? { [TKey in keyof T]: T[TKey] } : T
      : never
    : never

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
  /** `true` requires a signed-in Auth session. A callback also decides each request after sign-in. */
  authorize?: AccessAuthorizeOption
  route?: false
  get?: (key: string, options: CollectionReadOptions) => Promise<TSourceItem | null | undefined>
  cursor(item: NoInfer<TSourceItem>): Readonly<TCursorInput>
  cursorSchema: StandardSchemaV1<TCursorInput, TCursorOutput>
  defaultLimit?: number
  maxLimit?: number
  querySchema?: StandardSchemaV1<unknown, TQuery>
  transform?: CollectionTransform<TSourceItem>
}

export interface ProviderCollectionOptions<TSourceItem> {
  pagination: "provider"
  route?: false
  authorize?: AccessAuthorizeOption
  defaultLimit?: number
  maxLimit?: number
  get?: (key: string, options: CollectionReadOptions) => Promise<TSourceItem | null | undefined>
  querySchema?: StandardSchemaV1<unknown, object>
  transform?: CollectionTransform<TSourceItem>
}

export type ProviderCollectionLoader<TSourceItem, TQuery extends object> = (
  options: CollectionLoadOptions<TQuery, string>,
) => Promise<{ items: readonly TSourceItem[]; nextCursor: string | null }>

type CollectionDefinition<TSourceItem, TQuery extends object, TCursorInput extends CollectionCursorValue> = Omit<
  CollectionOptions<TSourceItem, TQuery, TCursorInput>,
  "cursorSchema" | "querySchema" | "transform" | "pagination"
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
  TQuerySchema extends StandardSchemaV1<unknown, object>,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: ProviderCollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>>,
  options: ProviderCollectionOptions<TSourceItem> & {
    get: NonNullable<ProviderCollectionOptions<TSourceItem>["get"]>
    querySchema: TQuerySchema
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<Awaited<ReturnType<TTransform>> | null>
}
export function defineCollection<
  TSourceItem,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
>(
  load: ProviderCollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>>,
  options: ProviderCollectionOptions<TSourceItem> & {
    get: NonNullable<ProviderCollectionOptions<TSourceItem>["get"]>
    querySchema: TQuerySchema
    transform?: undefined
  },
): Collection<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<TSourceItem | null>
}
export function defineCollection<
  TSourceItem,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: ProviderCollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>>,
  options: ProviderCollectionOptions<TSourceItem> & {
    querySchema: TQuerySchema
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>>
export function defineCollection<
  TSourceItem,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
>(
  load: ProviderCollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>>,
  options: ProviderCollectionOptions<TSourceItem> & {
    querySchema: TQuerySchema
    transform?: undefined
  },
): Collection<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>>
export function defineCollection<
  TSourceItem,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: ProviderCollectionLoader<TSourceItem, CollectionRequestQuery>,
  options: ProviderCollectionOptions<TSourceItem> & {
    get: NonNullable<ProviderCollectionOptions<TSourceItem>["get"]>
    querySchema?: undefined
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, CollectionRequestQuery, CollectionRequestQuery> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<Awaited<ReturnType<TTransform>> | null>
}
export function defineCollection<TSourceItem>(
  load: ProviderCollectionLoader<TSourceItem, CollectionRequestQuery>,
  options: ProviderCollectionOptions<TSourceItem> & {
    get: NonNullable<ProviderCollectionOptions<TSourceItem>["get"]>
    querySchema?: undefined
    transform?: undefined
  },
): Collection<TSourceItem, CollectionRequestQuery, CollectionRequestQuery> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<TSourceItem | null>
}
export function defineCollection<
  TSourceItem,
  TTransform extends CollectionTransform<TSourceItem>,
>(
  load: ProviderCollectionLoader<TSourceItem, CollectionRequestQuery>,
  options: ProviderCollectionOptions<TSourceItem> & {
    querySchema?: undefined
    transform: TTransform
  },
): Collection<Awaited<ReturnType<TTransform>>, CollectionRequestQuery, CollectionRequestQuery>
export function defineCollection<TSourceItem>(
  load: ProviderCollectionLoader<TSourceItem, CollectionRequestQuery>,
  options: ProviderCollectionOptions<TSourceItem> & {
    querySchema?: undefined
    transform?: undefined
  },
): Collection<TSourceItem, CollectionRequestQuery, CollectionRequestQuery>

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
): Collection<Awaited<ReturnType<TTransform>>, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<Awaited<ReturnType<TTransform>> | null>
}
export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
>(
  load: CollectionLoader<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, CursorOutput<TCursorSchema>>,
  options: CollectionDefinition<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, CursorInput<TCursorSchema>> & {
    get: NonNullable<CollectionOptions<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, CursorInput<TCursorSchema>>["get"]>
    cursorSchema: TCursorSchema
    querySchema: TQuerySchema
    transform?: undefined
  },
): Collection<TSourceItem, StandardSchemaV1.InferOutput<TQuerySchema>, QueryInput<TQuerySchema>> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<TSourceItem | null>
}
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
): Collection<Awaited<ReturnType<TTransform>>, CollectionRequestQuery, CollectionRequestQuery> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<Awaited<ReturnType<TTransform>> | null>
}
export function defineCollection<
  TSourceItem,
  TCursorSchema extends StandardSchemaV1,
>(
  load: CollectionLoader<TSourceItem, CollectionRequestQuery, CursorOutput<TCursorSchema>>,
  options: CollectionDefinition<TSourceItem, CollectionRequestQuery, CursorInput<TCursorSchema>> & {
    get: NonNullable<CollectionOptions<TSourceItem, CollectionRequestQuery, CursorInput<TCursorSchema>>["get"]>
    cursorSchema: TCursorSchema
    querySchema?: undefined
    transform?: undefined
  },
): Collection<TSourceItem, CollectionRequestQuery, CollectionRequestQuery> & {
  get: (key: string, options?: CollectionReadOptions) => Promise<TSourceItem | null>
}
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
  const TCursorInput extends CollectionCursorValue = CollectionCursorValue,
  const TCursorOutput extends CollectionCursorValue = CollectionCursorValue,
  const TQuery extends object = CollectionRequestQuery,
  const TQueryInput extends object = TQuery,
  TItem = TSourceItem,
>(
  load: ((options: CollectionLoadOptions<TQuery, TCursorOutput>) => Promise<readonly TSourceItem[]>)
    | ((options: CollectionLoadOptions<TQuery, string>) => Promise<{ items: readonly TSourceItem[]; nextCursor: string | null }>),
  definition: (CollectionOptions<TSourceItem, TQuery, TCursorInput, TCursorOutput> | ProviderCollectionOptions<TSourceItem>) & {
    cursorSchema?: StandardSchemaV1
    querySchema?: StandardSchemaV1<TQueryInput, TQuery>
    transform?: (item: NoInfer<TSourceItem>) => Promise<TItem> | TItem
  },
): Collection<TItem, TQuery, TQueryInput> {
  const defaultLimit = definition.defaultLimit ?? defaultPageLimit
  const maxLimit = definition.maxLimit ?? defaultMaxLimit
  assertPositiveInteger(defaultLimit, "defaultLimit")
  assertPositiveInteger(maxLimit, "maxLimit")
  if (defaultLimit > maxLimit) {
    throw sourceErrorDiagnostics.SOURCE_R0008({ message: "[vitehub] Collection defaultLimit cannot exceed maxLimit." })
  }
  const provider = "pagination" in definition && definition.pagination === "provider"
  // SAFETY: Cursor overloads supply cursor metadata; only the non-provider branch uses this view.
  const cursorDefinition = definition as CollectionOptions<TSourceItem, TQuery, TCursorInput, TCursorOutput> & {
    cursorSchema: StandardSchemaV1<TCursorInput, TCursorOutput>
  }
  const cursorCodec = provider ? undefined : createCollectionCursorCodec(cursorDefinition.cursorSchema)
  const authorize = definition.authorize
  if (authorize !== undefined && authorize !== true && !(authorize instanceof Function)) {
    throw sourceErrorDiagnostics.SOURCE_R0024({ message: "[vitehub] Collection authorize must be true or a function." })
  }

  if (definition.route !== undefined && definition.route !== false) throw new TypeError("[vitehub] Collection route must be false or omitted.")

  async function parseQuery(input: TQueryInput | CollectionRequestQuery): Promise<TQuery> {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This is the query boundary: reject null, primitives, and arrays before schema validation.
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("[vitehub] Collection query must be an object.")
    if (definition.querySchema) return await parseCollectionSchema(definition.querySchema, input)
    // SAFETY: Without a schema, overloads use the untransformed request-query contract.
    return input as TQuery
  }

  async function page(request: CollectionPageOptions<TQuery>): Promise<CollectionPage<TItem>> {
    request.signal?.throwIfAborted()
    const limit = resolveLimit(request.limit, defaultLimit, maxLimit)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Opaque provider cursors accept every string, including the empty string.
    if (provider && request.cursor !== undefined && typeof request.cursor !== "string") throw new CollectionCursorError()
    let pageItems: readonly TSourceItem[]
    let nextCursor: string | null
    if (provider) {
      // SAFETY: The provider discriminant selects the matching loader overload.
      const result = await (load as ProviderCollectionLoader<TSourceItem, TQuery>)({
        cursor: request.cursor,
        limit,
        query: request.query,
        signal: request.signal,
      })
      request.signal?.throwIfAborted()
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate the provider page boundary; continuation is a string and only null means completion.
      if (!result || Array.isArray(result) || !Array.isArray(result.items) || !(result.nextCursor === null || typeof result.nextCursor === "string")) {
        throw new TypeError("[vitehub] Provider Collection load() must return { items, nextCursor: string | null }.")
      }
      if (result.items.length > limit) throw new TypeError("[vitehub] Provider Collection returned more items than its requested limit.")
      pageItems = result.items
      nextCursor = result.nextCursor
    }
    else {
      // SAFETY: Without the provider discriminant, public overloads require an array-returning cursor loader.
      const result = await (load as CollectionLoader<TSourceItem, TQuery, TCursorOutput>)({
        // SAFETY: The codec validates and transforms the cursor using the overload's cursor schema.
        cursor: await cursorCodec!.decode(request.cursor) as TCursorOutput | undefined,
        limit: limit + 1,
        query: request.query,
        signal: request.signal,
      })
      request.signal?.throwIfAborted()
      if (!Array.isArray(result)) throw sourceErrorDiagnostics.SOURCE_R0009({ message: "[vitehub] Collection load() must return an array." })
      pageItems = result.slice(0, limit)
      nextCursor = result.length > limit && pageItems.length ? cursorCodec!.encode(cursorDefinition.cursor(pageItems[pageItems.length - 1]!)) : null
    }
    request.signal?.throwIfAborted()
    const transformedItems = definition.transform ? await Promise.all(pageItems.map(definition.transform)) : [...pageItems]
    request.signal?.throwIfAborted()
    // SAFETY: TItem is the transform result, or TSourceItem when no transform is configured.
    return { items: transformedItems as TItem[], nextCursor }
  }

  // SAFETY: An omitted input starts as an empty query and still passes through parseQuery before loading.
  function query(input: TQueryInput = {} as TQueryInput, selected?: string[]): CollectionQueryBuilder<TItem> {
    function project(item: TItem): TItem {
      // SAFETY: select() constrains keys to item fields; its return type exposes only those projected fields.
      return selected === undefined ? item : Object.fromEntries(selected.map(key => [key, (item as Record<string, unknown>)[key]])) as TItem
    }
    return {
      select(...keys) {
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JavaScript callers must pass string field names at the select() API boundary.
        if (!keys.every(key => typeof key === "string")) throw new TypeError("[vitehub] Collection select() expects field names.")
        // SAFETY: project() picks exactly these keys from each item before returning it.
        return query(input, keys) as CollectionQueryBuilder<Pick<TItem, typeof keys[number]>>
      },
      async page(options = {}) {
        options.signal?.throwIfAborted()
        const result = await page({ ...options, query: await parseQuery(input) })
        return { ...result, items: result.items.map(project) }
      },
      async all(options = {}) {
        options.signal?.throwIfAborted()
        const parsed = await parseQuery(input)
        const cursors = new Set<string>()
        const items: TItem[] = []
        let cursor: string | undefined
        do {
          options.signal?.throwIfAborted()
          const result = await page({ ...options, cursor, query: parsed })
          for (const item of result.items) items.push(project(item))
          cursor = result.nextCursor ?? undefined
          if (cursor !== undefined) {
            if (cursors.has(cursor)) throw new CollectionCursorError("[vitehub] Collection loader repeated a pagination cursor.")
            cursors.add(cursor)
          }
        } while (cursor !== undefined)
        return items
      },
    }
  }

  return {
    ...(authorize ? { authorize } : {}),
    ...(definition.route === false ? { route: false as const } : {}),
    page,
    parseQuery,
    query(input) { return query(input) },
    // SAFETY: An omitted query is schema-validated by query().all() before any loader invocation.
    all({ query: input = {} as TQueryInput, ...options } = {}) { return query(input).all(options) },
    async get(key, options = {}) {
      options.signal?.throwIfAborted()
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Direct reads require a nonempty string key before invoking the adapter.
      if (typeof key !== "string" || !key) throw new TypeError("[vitehub] Collection get() expects a nonempty string key.")
      if (!(definition.get instanceof Function)) throw new TypeError("[vitehub] Collection get() requires a get adapter.")
      const item = await definition.get(key, options)
      options.signal?.throwIfAborted()
      if (item === null || item === undefined) return null
      const transformed = definition.transform ? await definition.transform(item) : item
      options.signal?.throwIfAborted()
      // SAFETY: The configured transform determines TItem; overloads otherwise retain TSourceItem.
      return transformed as TItem
    },
    ...(definition.querySchema ? { querySchema: definition.querySchema } : {}),
  }
}
