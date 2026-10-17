import { H3 } from "h3"
import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { array, CollectionCursorError, defineCollection } from "../src/index.ts"
import { defineCollectionHandler } from "../src/server.ts"

import type { ArrayCollectionOptions, CollectionPage } from "../src/index.ts"

const records = [
  { authors: [{ name: "Ada" }], category: "guide", id: 1, slug: "alpha", summary: "First guide", title: "Alpha" },
  { authors: [{ name: "Grace" }], category: "reference", id: 2, slug: "beta", summary: "API details", title: "Beta" },
  { authors: [{ name: "Ada" }, { name: "Grace" }], category: "guide", id: 3, slug: "gamma", summary: "Second guide", title: "Gamma" },
  { authors: [], category: "note", id: 4, slug: "untagged", summary: "No author", title: "Untagged" },
]

type Item = Record<string, unknown>

function articles(items: readonly Item[] | (() => Item[] | { items: Item[], digest?: string }) = records, options: ArrayCollectionOptions<"category" | "authors.name"> = {}) {
  return defineCollection({
    source: array<Item, "category" | "authors.name">(items, {
      facets: ["category", "authors.name"],
      filters: ["category", "authors.name"],
      key: "slug",
      search: ["title", "summary"],
      ...options,
    }),
  })
}

async function query(collection: ReturnType<typeof articles>, input: Record<string, string | string[] | undefined>, cursor?: string, limit?: number) {
  return await collection.page({ cursor, limit, query: await collection.parseQuery(input) })
}

describe("array()", () => {
  it("filters, searches, sorts, counts, facets, and pages an array", async () => {
    const collection = articles(records, { sort: { field: "slug" } })
    const first = await query(collection, { "authors.name": "ada", "search": "A" }, undefined, 1)

    expect(first.items).toEqual([records[0]])
    expect(first.total).toBe(2)
    expect(first.facets).toEqual({
      "authors.name": [{ count: 2, value: "Ada" }, { count: 1, value: "Grace" }],
      "category": [{ count: 2, value: "guide" }],
    })
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await query(collection, { "authors.name": "Ada", "search": "a" }, first.nextCursor!, 1)
    expect(second.items).toEqual([records[2]])
    expect(second.nextCursor).toBeNull()
  })

  it("matches any repeated filter value and keeps commas inside values", async () => {
    const collection = articles([...records, { category: "Doe, Jane", slug: "comma" }])
    expect((await query(collection, { category: ["note", "reference"] })).items.map(item => item.slug)).toEqual(["beta", "untagged"])
    expect((await query(collection, { category: "Doe, Jane" })).items.map(item => item.slug)).toEqual(["comma"])
  })

  it("filters empty values out of band from literal values", async () => {
    const collection = articles([
      { category: "guide", slug: "guide" },
      { slug: "missing" },
      { category: "__empty__", slug: "literal" },
      { category: "", slug: "blank" },
    ])

    expect((await query(collection, { empty: "category" })).items.map(item => item.slug)).toEqual(["missing"])
    expect((await query(collection, { category: "__empty__" })).items.map(item => item.slug)).toEqual(["literal"])
    expect((await query(collection, { category: "" })).items.map(item => item.slug)).toEqual(["blank"])
    expect((await query(collection, { empty: "authors.name" })).total).toBe(4)
  })

  it("matches nested arrays and treats empty arrays as empty", async () => {
    const collection = articles()
    expect((await query(collection, { empty: "authors.name" })).items).toEqual([records[3]])
    expect((await query(collection, { "authors.name": "grace" })).total).toBe(2)
  })

  it("does not read prototype properties through field paths", async () => {
    const collection = articles([{ title: "Guide" }])
    Object.defineProperty(Object.prototype, "collectionLeak", { configurable: true, value: "secret" })
    try {
      await expect(collection.page({ query: { "__proto__.collectionLeak": ["secret"] } as never })).resolves.toMatchObject({ items: [], total: 0 })
    }
    finally {
      Reflect.deleteProperty(Object.prototype, "collectionLeak")
    }
  })

  it("ignores null and undefined filter values from server callers", async () => {
    const collection = articles()
    const first = await collection.page({ limit: 1, query: { "category": [null, "Guide"], "authors.name": undefined } as never })
    expect(first).toMatchObject({ items: [records[0]], total: 2 })
    await expect(collection.page({ cursor: first.nextCursor!, limit: 1, query: { category: ["guide"] } })).resolves.toMatchObject({ items: [records[2]] })
  })

  it("sorts numbers numerically and strings in either direction", async () => {
    const numeric = defineCollection({ source: array([{ rank: 10 }, { rank: 2 }, { rank: 1 }], { sort: { field: "rank" } }) })
    expect((await numeric.page({ query: {} })).items).toEqual([{ rank: 1 }, { rank: 2 }, { rank: 10 }])
    const descending = articles(records, { sort: { direction: "desc", field: "title" } })
    expect((await query(descending, {})).items.map(item => item.slug)).toEqual(["untagged", "gamma", "beta", "alpha"])
  })

  it("sorts Dates by time and filters and facets them as ISO strings", async () => {
    const items = [
      { date: new Date("2026-10-02T00:00:00.000Z"), slug: "b" },
      { date: new Date("2026-09-30T00:00:00.000Z"), slug: "a" },
      { date: new Date("2026-10-10T00:00:00.000Z"), slug: "c" },
    ]
    const dated = defineCollection({ source: array(items, { facets: ["date"], filters: ["date"], sort: { direction: "desc", field: "date" } }) })
    const page = await dated.page({ query: {} })
    expect(page.items.map(item => item.slug)).toEqual(["c", "b", "a"])
    expect(page.facets?.date?.[0]).toEqual({ count: 1, value: "2026-09-30T00:00:00.000Z" })
    const filtered = await dated.page({ query: { date: ["2026-10-02T00:00:00.000Z"] } })
    expect(filtered.items.map(item => item.slug)).toEqual(["b"])
  })

  it("bounds pages and facet values by maxLimit", async () => {
    const collection = articles(records, { defaultLimit: 1, maxLimit: 2 })
    expect((await query(collection, {})).items).toHaveLength(1)
    const bounded = await query(collection, {}, undefined, 500)
    expect(bounded.items).toHaveLength(2)
    expect(bounded.facets?.category).toHaveLength(2)
    await expect(query(collection, {}, undefined, 0)).rejects.toThrow("positive integer")
  })

  it("omits facets when none are declared and always reports total", async () => {
    const collection = defineCollection({ source: array(records) })
    const page = await collection.page({ query: {} })
    expect(page.total).toBe(4)
    expect(page).not.toHaveProperty("facets")
  })

  it("looks up one item by its key field", async () => {
    const collection = articles()
    await expect(collection.get?.("beta")).resolves.toEqual(records[1])
    await expect(collection.get?.("missing")).resolves.toBeNull()
    expect(defineCollection({ source: array(records) }).get).toBeUndefined()
  })

  it("rejects undeclared query keys, undeclared empty filters, and disabled search", async () => {
    const collection = articles()
    await expect(collection.parseQuery({ secret: "one" })).rejects.toThrow("not allowed")
    await expect(collection.parseQuery({ sort: "secret" })).rejects.toThrow("not allowed")
    await expect(collection.parseQuery({ empty: "secret" })).rejects.toThrow("not allowed")
    await expect(collection.parseQuery({ search: ["a", "b"] })).rejects.toThrow("one value")
    const unsearchable = defineCollection({ source: array(records) })
    await expect(unsearchable.parseQuery({ search: "a" })).rejects.toThrow("not enabled")
    await expect(unsearchable.parseQuery({ search: "" })).resolves.toEqual({ search: "" })
  })

  it("rejects filters that collide with reserved query keys", () => {
    expect(() => array(records, { filters: ["search"] })).toThrow("reserved query key")
    expect(() => array(records, { filters: ["limit"] })).toThrow("reserved query key")
  })

  it("validates and parses items with a schema", async () => {
    const collection = defineCollection({
      source: array(async () => [{ rank: "2" }, { rank: "1" }], {
        schema: v.object({ rank: v.pipe(v.string(), v.transform(Number)) }),
        sort: { field: "rank" },
      }),
    })
    await expect(collection.page({ query: {} })).resolves.toMatchObject({ items: [{ rank: 1 }, { rank: 2 }] })

    const invalid = defineCollection({ source: array([{ rank: 1 }], { schema: v.object({ rank: v.string() }) }) })
    await expect(invalid.page({ query: {} })).rejects.toThrow("item 0 does not match its schema")
  })

  it("rejects loaders that do not return an array", async () => {
    const collection = defineCollection({ source: array(async () => ({ items: "nope" }) as never) })
    await expect(collection.page({ query: {} })).rejects.toThrow("must return an array")
  })

  describe("cursors", () => {
    it("rejects malformed and non-canonical cursors", async () => {
      const collection = articles(Array.from({ length: 12 }, (_, id) => ({ id })))
      const first = await query(collection, {}, undefined, 1)
      for (const cursor of ["not-a-cursor", "A", "AA=", "Zm9v==", "AA/AA", `${first.nextCursor}==`]) {
        await expect(query(collection, {}, cursor, 1)).rejects.toMatchObject({ reason: "malformed" })
      }
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
      const cursor = first.nextCursor!
      const mutated = cursor.slice(0, -1) + alphabet[alphabet.indexOf(cursor.at(-1)!) + 1]
      await expect(query(collection, {}, mutated, 1)).rejects.toBeInstanceOf(CollectionCursorError)
      await expect(query(collection, {}, cursor, 1)).resolves.toMatchObject({ items: [{ id: 1 }] })
    })

    it("rejects cursors from another query as stale", async () => {
      const collection = articles()
      const first = await query(collection, {}, undefined, 1)
      await expect(query(collection, { search: "alpha" }, first.nextCursor!, 1)).rejects.toMatchObject({ code: "SOURCE_R0027", reason: "stale" })
      const literal = await query(collection, { category: "note" }, undefined, 1)
      expect(literal.nextCursor).toBeNull()
    })

    it("distinguishes empty filters from literal values in cursors", async () => {
      const collection = articles([
        { category: "empty", slug: "literal" },
        { category: "empty", slug: "literal-2" },
        { slug: "missing" },
      ])
      const first = await query(collection, { category: "empty" }, undefined, 1)
      await expect(query(collection, { empty: "category" }, first.nextCursor!, 1)).rejects.toMatchObject({ reason: "stale" })
    })

    it("accepts cursors across equivalent query forms and page sizes", async () => {
      const collection = articles(records, { sort: { field: "slug" } })
      const first = await query(collection, { category: "Guide" }, undefined, 1)
      await expect(query(collection, { category: ["guide"] }, first.nextCursor!, 2)).resolves.toMatchObject({ items: [{ slug: "gamma" }] })
    })

    it("rejects cursors after the data changes, by digest or by content hash", async () => {
      let snapshot: { items: Item[], digest?: string } = { digest: "v1", items: records }
      const digested = articles(() => snapshot)
      const first = await query(digested, {}, undefined, 1)
      snapshot = { digest: "v2", items: records }
      await expect(query(digested, {}, first.nextCursor!, 1)).rejects.toMatchObject({ reason: "stale" })

      let items = records.slice(0, 2)
      const hashed = articles(() => items)
      const page = await query(hashed, {}, undefined, 1)
      items = records.slice(1, 3)
      await expect(query(hashed, {}, page.nextCursor!, 1)).rejects.toMatchObject({ reason: "stale" })
    })
  })

  it("serves total and facets from the generated route and maps stale cursors to 409", async () => {
    let items: Item[] = records
    const app = new H3().get("/articles", defineCollectionHandler(articles(() => items, { defaultLimit: 1 })))

    const response = await app.request("/articles?category=guide")
    const body = await response.json() as CollectionPage<Item>
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ items: [records[0]], total: 2, facets: { category: [{ count: 2, value: "guide" }] } })

    expect((await app.request("/articles?secret=1")).status).toBe(400)
    expect((await app.request("/articles?empty=category&empty=secret")).status).toBe(400)
    expect((await app.request("/articles?cursor=invalid")).status).toBe(400)
    expect((await app.request(`/articles?search=guide&cursor=${encodeURIComponent(body.nextCursor!)}`)).status).toBe(409)
    items = [...records, { category: "guide", slug: "zeta" }]
    expect((await app.request(`/articles?category=guide&cursor=${encodeURIComponent(body.nextCursor!)}`)).status).toBe(409)
  })
})
