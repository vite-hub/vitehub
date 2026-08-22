import { describe, expectTypeOf, it } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { useCollection } from "../src/client.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { CollectionQuery } from "../src/index.ts"

interface Article {
  id: number
  title: string
}

type JSONValueRow = {
  array: Array<number | undefined | (() => void) | symbol>
  invalidUnion: bigint | string
  invalidUnionArray: Array<bigint | string>
  invalidUnionNested: { value: bigint | string }
  omitted: undefined
  optional: string | undefined
  toJSONOmitted: { toJSON(): undefined }
  value: number
}

interface InterfaceFilters {
  author?: string
}

type AliasFilters = {
  author?: string
  q: string
}

type CardinalityFilters = {
  tags?: string | string[]
}

type ReadonlyCardinalityFilters = {
  tags?: string | readonly string[]
}

type DuplicateCardinalityFilters = {
  tags?: string | readonly [string, string, ...string[]]
}

declare const filterKey: unique symbol
type ArrayFilters = { tags?: string[] }
type ReadonlyArrayFilters = { tags?: readonly string[] }
type TupleFilters = { tags?: string | readonly [string] }
type FixedTupleFilters = { tags?: string | readonly [string, string] }
type SymbolFilters = { [filterKey]: string }
type NumericFilters = { 0: string }
type MixedFilters = { author?: string } | { page: number } | { tags: string | string[] }
type ReservedFilters = { cursor?: string; limit?: string }
type ReservedUnionFilters = { author?: string } | { limit: string }

function defineQueryFixture<TInput extends object>(querySchema: StandardSchemaV1<TInput, TInput>) {
  // SAFETY: This type-only fixture declares the rows returned by its synthetic loader.
  return defineCollection(async () => [] as Array<{ id: string }>, {
    cursor: row => row.id,
    cursorSchema: v.string(),
    querySchema,
  })
}

declare const interfaceFilterSchema: StandardSchemaV1<InterfaceFilters, InterfaceFilters>
declare const aliasFilterSchema: StandardSchemaV1<AliasFilters, AliasFilters>
declare const cardinalityFilterSchema: StandardSchemaV1<CardinalityFilters, CardinalityFilters>
declare const readonlyCardinalityFilterSchema: StandardSchemaV1<ReadonlyCardinalityFilters, ReadonlyCardinalityFilters>
declare const duplicateCardinalityFilterSchema: StandardSchemaV1<
  DuplicateCardinalityFilters,
  DuplicateCardinalityFilters
>
declare const arrayFilterSchema: StandardSchemaV1<ArrayFilters, ArrayFilters>
declare const readonlyArrayFilterSchema: StandardSchemaV1<ReadonlyArrayFilters, ReadonlyArrayFilters>
declare const tupleFilterSchema: StandardSchemaV1<TupleFilters, TupleFilters>
declare const fixedTupleFilterSchema: StandardSchemaV1<FixedTupleFilters, FixedTupleFilters>
declare const symbolFilterSchema: StandardSchemaV1<SymbolFilters, SymbolFilters>
declare const numericFilterSchema: StandardSchemaV1<NumericFilters, NumericFilters>
declare const mixedFilterSchema: StandardSchemaV1<MixedFilters, MixedFilters>
declare const reservedFilterSchema: StandardSchemaV1<ReservedFilters, ReservedFilters>
declare const reservedUnionFilterSchema: StandardSchemaV1<ReservedUnionFilters, ReservedUnionFilters>

const interfaceQuery = defineQueryFixture(interfaceFilterSchema)
const aliasQuery = defineQueryFixture(aliasFilterSchema)
const cardinalityQuery = defineQueryFixture(cardinalityFilterSchema)
const readonlyCardinalityQuery = defineQueryFixture(readonlyCardinalityFilterSchema)
const duplicateCardinalityQuery = defineQueryFixture(duplicateCardinalityFilterSchema)
const arrayQuery = defineQueryFixture(arrayFilterSchema)
const readonlyArrayQuery = defineQueryFixture(readonlyArrayFilterSchema)
const tupleQuery = defineQueryFixture(tupleFilterSchema)
const fixedTupleQuery = defineQueryFixture(fixedTupleFilterSchema)
const symbolQuery = defineQueryFixture(symbolFilterSchema)
const numericQuery = defineQueryFixture(numericFilterSchema)
const mixedQuery = defineQueryFixture(mixedFilterSchema)
const reservedQuery = defineQueryFixture(reservedFilterSchema)
const reservedUnionQuery = defineQueryFixture(reservedUnionFilterSchema)

// SAFETY: This type-only fixture declares the rows its loader would return.
const articles = defineCollection(async () => [] as Article[], {
  cursor: article => article.id,
  cursorSchema: v.number(),
  querySchema: v.object({ author: v.optional(v.string()) }),
})

// SAFETY: This type-only fixture declares the rows its loader would return.
const events = defineCollection(async () => [] as Array<{ at: Date; id: bigint }>, {
  cursor: event => event.at.toISOString(),
  cursorSchema: v.string(),
})

// SAFETY: This type-only fixture covers JSON coercion and omission at the HTTP boundary.
const jsonValues = defineCollection(
  async () => {
    // SAFETY: This type-only fixture declares the JSON-shaped rows its loader would return.
    return [] as JSONValueRow[]
  },
  {
    cursor: () => "done",
    cursorSchema: v.string(),
  },
)

// SAFETY: This type-only fixture covers item-level JSON array coercion.
const toJSONOmittedItems = defineCollection(async () => [] as Array<{ toJSON(): undefined }>, {
  cursor: () => "done",
  cursorSchema: v.string(),
})

const toJSONValues = defineCollection(
  async () => {
    // SAFETY: This type-only fixture declares built-in and custom toJSON() rows for client projection coverage.
    return [] as Array<{ custom: { toJSON(): { id: string } }; url: URL }>
  },
  {
    cursor: () => "done",
    cursorSchema: v.string(),
  },
)

type UnsupportedItem =
  | ArrayBuffer
  | DataView
  | Error
  | Map<string, number>
  | RegExp
  | Set<number>
  | SharedArrayBuffer
  | Uint8Array
  | WeakMap<object, number>
  | WeakSet<object>

const nonPlainItems = defineCollection(
  async () => {
    // SAFETY: This type-only fixture declares statically detectable unsupported rows for client projection coverage.
    return [] as UnsupportedItem[]
  },
  {
    cursor: () => "done",
    cursorSchema: v.string(),
  },
)

const transformedQuery = defineCollection(async ({ query }) => [{ id: query.search }], {
  cursor: item => item.id,
  cursorSchema: v.string(),
  querySchema: v.pipe(
    v.object({ q: v.string() }),
    v.transform(({ q }) => ({ search: q })),
  ),
})

const nonWireQuery = defineCollection(async ({ query }) => [{ id: query.page }], {
  cursor: item => item.id,
  cursorSchema: v.number(),
  querySchema: v.object({ page: v.number() }),
})

declare global {
  interface ViteHubCollectionMap {
    articles: typeof articles
    interfaceQuery: typeof interfaceQuery
    cardinalityQuery: typeof cardinalityQuery
    readonlyCardinalityQuery: typeof readonlyCardinalityQuery
    events: typeof events
    jsonValues: typeof jsonValues
    toJSONOmittedItems: typeof toJSONOmittedItems
    toJSONValues: typeof toJSONValues
    transformedQuery: typeof transformedQuery
    nonWireQuery: typeof nonWireQuery
    nonPlainItems: typeof nonPlainItems
    reservedQuery: typeof reservedQuery
  }
}

describe("useCollection types", () => {
  it("infers registered collection items and filters", () => {
    const collection = useCollection("articles", { filter: { author: "Ada" } })
    expectTypeOf(collection.items.value).toEqualTypeOf<Array<{ id: number | null; title: string }>>()
    expectTypeOf(useCollection("events").items.value).toEqualTypeOf<Array<{ at: string; id: never }>>()
    type JSONValue = {
      array: Array<number | null>
      invalidUnion: string
      invalidUnionArray: string[]
      invalidUnionNested: { value: string }
      optional?: string
      value: number | null
    }
    expectTypeOf(useCollection("jsonValues").items.value).toEqualTypeOf<JSONValue[]>()
    expectTypeOf(useCollection("toJSONOmittedItems").items.value).toMatchTypeOf<null[]>()
    expectTypeOf(useCollection("toJSONValues").items.value).toEqualTypeOf<
      Array<{ custom: { id: string }; url: string }>
    >()
    expectTypeOf(useCollection("nonPlainItems").items.value).toEqualTypeOf<never[]>()
    expectTypeOf<CollectionQuery<typeof interfaceQuery>>().toEqualTypeOf<InterfaceFilters>()
    expectTypeOf<CollectionQuery<typeof aliasQuery>>().toEqualTypeOf<AliasFilters>()
    expectTypeOf<CollectionQuery<typeof cardinalityQuery>>().toEqualTypeOf<CardinalityFilters>()
    expectTypeOf<CollectionQuery<typeof readonlyCardinalityQuery>>().toEqualTypeOf<ReadonlyCardinalityFilters>()
    expectTypeOf<CollectionQuery<typeof duplicateCardinalityQuery>>().toEqualTypeOf<DuplicateCardinalityFilters>()
    expectTypeOf<CollectionQuery<typeof arrayQuery>>().toEqualTypeOf<never>()
    expectTypeOf<CollectionQuery<typeof readonlyArrayQuery>>().toEqualTypeOf<never>()
    expectTypeOf<CollectionQuery<typeof tupleQuery>>().toEqualTypeOf<never>()
    expectTypeOf<CollectionQuery<typeof fixedTupleQuery>>().toEqualTypeOf<never>()
    expectTypeOf<CollectionQuery<typeof symbolQuery>>().toEqualTypeOf<never>()
    expectTypeOf<CollectionQuery<typeof numericQuery>>().toEqualTypeOf<never>()
    expectTypeOf<CollectionQuery<typeof mixedQuery>>().toEqualTypeOf<{ author?: string }>()
    expectTypeOf<CollectionQuery<typeof reservedQuery>>().toEqualTypeOf<never>()
    expectTypeOf<CollectionQuery<typeof reservedUnionQuery>>().toEqualTypeOf<{ author?: string }>()
    expectTypeOf<CollectionQuery<typeof nonWireQuery>>().toEqualTypeOf<never>()
    useCollection("cardinalityQuery", { filter: { tags: [] } })
    useCollection("cardinalityQuery", { filter: { tags: ["one"] } })
    useCollection("cardinalityQuery", { filter: { tags: ["one", "two"] } })
    const readonlyTags: readonly string[] = ["one", "two"]
    useCollection("readonlyCardinalityQuery", { filter: { tags: readonlyTags } })
    useCollection("interfaceQuery", { filter: { author: "Ada" } })
    useCollection("transformedQuery", { filter: { q: "Ada" } })

    // @ts-expect-error Collection names come from ViteHubCollectionMap
    useCollection("missing")
    // @ts-expect-error Filters come from the registered Collection query schema
    useCollection("articles", { filter: { author: 42 } })
    // @ts-expect-error Filters use the query schema input rather than its transformed output
    useCollection("transformedQuery", { filter: { search: "Ada" } })
    // @ts-expect-error Collection filters only accept values representable by a GET query string
    useCollection("nonWireQuery", { filter: { page: 2 } })
    // @ts-expect-error Pagination keys are reserved by the Collection request boundary
    useCollection("reservedQuery", { filter: { limit: "10" } })
  })
})
