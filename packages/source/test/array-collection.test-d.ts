import { describe, expectTypeOf, it } from "vitest"
import * as v from "valibot"

import { array, defineCollection } from "../src/index.ts"
import { useCollection } from "../src/client.ts"

import type { CollectionFacets, CollectionItem, CollectionPage, CollectionQuery } from "../src/index.ts"

interface Article {
  category: string
  secret: string
  slug: string
  title: string
}

declare const loadArticles: () => Promise<Article[]>

const articleIndex = defineCollection({
  source: array(loadArticles, { facets: ["category"], filters: ["category", "author.name"], search: ["title"] }),
  transform: ({ category, slug, title }) => ({ category, slug, title }),
})

const plain = defineCollection({ source: array([{ id: 1 }]) })

const parsed = defineCollection({
  source: array(async (): Promise<unknown[]> => [], { filters: ["kind"], schema: v.object({ kind: v.string(), rank: v.pipe(v.string(), v.transform(Number)) }) }),
})

declare global {
  interface ViteHubCollectionMap {
    articleIndex: typeof articleIndex
  }
}

describe("array() Collection types", () => {
  it("derives items from transform and the query from declared filters", () => {
    expectTypeOf<CollectionItem<typeof articleIndex>>().toEqualTypeOf<{ category: string, slug: string, title: string }>()
    expectTypeOf<CollectionQuery<typeof articleIndex>>().toMatchTypeOf<{
      "category"?: string | readonly string[]
      "author.name"?: string | readonly string[]
      "empty"?: "category" | "author.name" | readonly ("category" | "author.name")[]
      "search"?: string
    }>()
    expectTypeOf<CollectionItem<typeof plain>>().toEqualTypeOf<{ id: number }>()
    expectTypeOf<CollectionItem<typeof parsed>>().toEqualTypeOf<{ kind: string, rank: number }>()
  })

  it("rejects undeclared filters in the typed client", () => {
    useCollection("articleIndex", { filter: { "category": ["guide", "note"], "empty": "author.name", "search": "vite" } })
    // @ts-expect-error -- secret is not a declared filter.
    useCollection("articleIndex", { filter: { secret: "one" } })
    // @ts-expect-error -- empty only accepts declared filters.
    useCollection("articleIndex", { filter: { empty: "secret" } })
  })

  it("exposes total and facets on pages and on useCollection()", () => {
    const { facets, total } = useCollection("articleIndex")
    expectTypeOf(total.value).toEqualTypeOf<number | undefined>()
    expectTypeOf(facets.value).toEqualTypeOf<CollectionFacets | undefined>()
    expectTypeOf(articleIndex.page).returns.resolves.toEqualTypeOf<CollectionPage<{ category: string, slug: string, title: string }>>()
    expectTypeOf<CollectionPage<unknown>["total"]>().toEqualTypeOf<number | undefined>()
  })
})
