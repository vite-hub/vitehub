import { describe, expectTypeOf, it } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { useCollection } from "../src/client.ts"

const articles = defineCollection(async () => [] as Array<{ id: number, title: string }>, {
  cursor: article => article.id,
  cursorSchema: v.number(),
  querySchema: v.object({ author: v.optional(v.string()) }),
})

const events = defineCollection(async () => [] as Array<{ at: Date, id: bigint }>, {
  cursor: event => event.at.toISOString(),
  cursorSchema: v.string(),
})

declare global {
  interface ViteHubCollectionMap {
    articles: typeof articles
    events: typeof events
  }
}

describe("useCollection types", () => {
  it("infers registered collection items and filters", () => {
    const collection = useCollection("articles", { filter: { author: "Ada" } })
    expectTypeOf(collection.items.value).toEqualTypeOf<Array<{ id: number, title: string }>>()
    expectTypeOf(useCollection("events").items.value)
      .toEqualTypeOf<Array<{ at: string, id: never }>>()

    // @ts-expect-error Collection names come from ViteHubCollectionMap
    useCollection("missing")
    // @ts-expect-error Filters come from the registered Collection query schema
    useCollection("articles", { filter: { author: 42 } })
  })
})
