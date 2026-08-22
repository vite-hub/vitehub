import { describe, expectTypeOf, it } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { useCollection } from "../src/client.ts"

import type { CollectionQuery } from "../src/index.ts"

interface Article {
  id: number
  title: string
}

type JSONValueRow = {
  array: Array<number | undefined | (() => void) | symbol>
  omitted: undefined
  optional: string | undefined
  toJSONOmitted: { toJSON(): undefined }
  value: number
}

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
  | Error
  | Map<string, number>
  | RegExp
  | Set<number>
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
    events: typeof events
    jsonValues: typeof jsonValues
    toJSONOmittedItems: typeof toJSONOmittedItems
    toJSONValues: typeof toJSONValues
    transformedQuery: typeof transformedQuery
    nonWireQuery: typeof nonWireQuery
    nonPlainItems: typeof nonPlainItems
  }
}

describe("useCollection types", () => {
  it("infers registered collection items and filters", () => {
    const collection = useCollection("articles", { filter: { author: "Ada" } })
    expectTypeOf(collection.items.value).toEqualTypeOf<Array<{ id: number | null; title: string }>>()
    expectTypeOf(useCollection("events").items.value).toEqualTypeOf<Array<{ at: string; id: never }>>()
    type JSONValue = {
      array: Array<number | null>
      optional?: string
      value: number | null
    }
    expectTypeOf(useCollection("jsonValues").items.value).toEqualTypeOf<JSONValue[]>()
    expectTypeOf(useCollection("toJSONOmittedItems").items.value).toMatchTypeOf<null[]>()
    expectTypeOf(useCollection("toJSONValues").items.value).toEqualTypeOf<
      Array<{ custom: { id: string }; url: string }>
    >()
    expectTypeOf(useCollection("nonPlainItems").items.value).toEqualTypeOf<never[]>()
    expectTypeOf<CollectionQuery<typeof nonWireQuery>>().toEqualTypeOf<never>()
    useCollection("transformedQuery", { filter: { q: "Ada" } })

    // @ts-expect-error Collection names come from ViteHubCollectionMap
    useCollection("missing")
    // @ts-expect-error Filters come from the registered Collection query schema
    useCollection("articles", { filter: { author: 42 } })
    // @ts-expect-error Filters use the query schema input rather than its transformed output
    useCollection("transformedQuery", { filter: { search: "Ada" } })
    // @ts-expect-error Collection filters only accept values representable by a GET query string
    useCollection("nonWireQuery", { filter: { page: 2 } })
  })
})
