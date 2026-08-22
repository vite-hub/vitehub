import { describe, expectTypeOf, it } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { useCollection } from "../src/client.ts"

// SAFETY: This type-only fixture declares the rows its loader would return.
const articles = defineCollection(async () => [] as Array<{ id: number; title: string }>, {
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
    return [] as Array<{
      array: Array<number | undefined | (() => void) | symbol>
      omitted: undefined
      value: number
    }>
  },
  {
    cursor: () => "done",
    cursorSchema: v.string(),
  },
)

declare global {
  interface ViteHubCollectionMap {
    articles: typeof articles
    events: typeof events
    jsonValues: typeof jsonValues
  }
}

describe("useCollection types", () => {
  it("infers registered collection items and filters", () => {
    const collection = useCollection("articles", { filter: { author: "Ada" } })
    expectTypeOf(collection.items.value).toEqualTypeOf<Array<{ id: number | null; title: string }>>()
    expectTypeOf(useCollection("events").items.value).toEqualTypeOf<Array<{ at: string; id: never }>>()
    expectTypeOf(useCollection("jsonValues").items.value).toEqualTypeOf<
      Array<{ array: Array<number | null>; value: number | null }>
    >()

    // @ts-expect-error Collection names come from ViteHubCollectionMap
    useCollection("missing")
    // @ts-expect-error Filters come from the registered Collection query schema
    useCollection("articles", { filter: { author: 42 } })
  })
})
