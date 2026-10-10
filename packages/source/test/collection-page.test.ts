import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { CollectionCursorError, defineCollection } from "../src/index.ts"

interface Row {
  createdAt: number
  id: string
  photoPath: string
}

function mealsCollection() {
  const load = vi.fn(
    async ({
      cursor,
      limit,
      query: _query,
    }: {
      cursor?: readonly [number, string]
      limit: number
      query: { day?: string }
    }): Promise<Row[]> => {
      const rows = [
        { createdAt: 30, id: "three", photoPath: "three/original" },
        { createdAt: 20, id: "two", photoPath: "two/original" },
        { createdAt: 10, id: "one", photoPath: "one/original" },
      ]
      const offset = cursor ? rows.findIndex(row => row.createdAt === cursor[0] && row.id === cursor[1]) + 1 : 0
      return rows.slice(offset, offset + limit)
    },
  )
  return {
    collection: defineCollection(load, {
      cursor: (row: Row) => [row.createdAt, row.id] as const,
      cursorSchema: v.tuple([v.number(), v.string()]),
      defaultLimit: 2,
      maxLimit: 2,
      querySchema: v.object({ day: v.optional(v.string()) }),
      transform(row) {
        return { createdAt: new Date(row.createdAt).toISOString(), id: row.id }
      },
    }),
    load,
  }
}

describe("Collections", () => {
  it("exposes the query schema that parseQuery() uses", async () => {
    const querySchema = v.object({ day: v.optional(v.string()) })
    const withSchema = defineCollection(async () => [], { cursor: () => 0, cursorSchema: v.number(), querySchema })
    const withoutSchema = defineCollection(async () => [], { cursor: () => 0, cursorSchema: v.number() })

    expect(withSchema.querySchema).toBe(querySchema)
    expect(withoutSchema.querySchema).toBeUndefined()
    await expect(withSchema.parseQuery({ day: ["a", "b"] })).rejects.toThrow()
  })

  it("supports provider cursors, direct reads, projection, and cancellation", async () => {
    const load = vi.fn(async ({ cursor, limit }: { cursor?: string, limit: number }) => cursor
      ? { items: [{ id: "two", value: 2 }], nextCursor: null }
      : { items: [{ id: "one", value: 1 }], nextCursor: "next" })
    const controller = new AbortController()
    const collection = defineCollection(load, {
      pagination: "provider",
      route: false,
      get: async key => key === "one" ? { id: key, value: 1 } : null,
      transform: row => ({ ...row, value: row.value * 2 }),
      defaultLimit: 1,
      maxLimit: 1,
    })

    await expect(collection.query({}).select("id").all({ signal: controller.signal })).resolves.toEqual([{ id: "one" }, { id: "two" }])
    await expect(collection.get("one")).resolves.toEqual({ id: "one", value: 2 })
    await expect(collection.get("missing")).resolves.toBeNull()
    expect(load).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 1, query: {}, signal: controller.signal })
    controller.abort()
    await expect(collection.query({}).all({ signal: controller.signal })).rejects.toThrow()
  })

  it("loads one bounded page, transforms rows, and continues from an opaque cursor", async () => {
    const { collection, load } = mealsCollection()
    const query = await collection.parseQuery({ day: "2026-08-21" })
    const first = await collection.page({ limit: 50, query })

    expect(load).toHaveBeenCalledWith({ cursor: undefined, limit: 3, query, signal: undefined })
    expect(first.items).toEqual([
      { createdAt: "1970-01-01T00:00:00.030Z", id: "three" },
      { createdAt: "1970-01-01T00:00:00.020Z", id: "two" },
    ])
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await collection.page({ cursor: first.nextCursor!, query })
    expect(load).toHaveBeenLastCalledWith({
      cursor: [20, "two"],
      limit: 3,
      query,
      signal: undefined,
    })
    expect(second.items).toEqual([{ createdAt: "1970-01-01T00:00:00.010Z", id: "one" }])
    expect(second.nextCursor).toBeNull()
  })

  it("transforms encoded cursor input before passing it to the loader", async () => {
    const load = vi.fn(async ({ cursor }: { cursor?: number }) =>
      cursor === undefined ? [{ id: "2" }, { id: "1" }] : [],
    )
    const collection = defineCollection(load, {
      cursor: (row: { id: string }) => row.id,
      cursorSchema: v.pipe(v.string(), v.transform(Number), v.number()),
      defaultLimit: 1,
      maxLimit: 1,
    })

    const first = await collection.page({ query: {} })
    await collection.page({ cursor: first.nextCursor!, query: {} })

    expect(load).toHaveBeenLastCalledWith({ cursor: 2, limit: 2, query: {}, signal: undefined })
  })

  it("round-trips Unicode cursor input and validates transformed output", async () => {
    const load = vi.fn(async ({ cursor }: { cursor?: string }) => cursor === undefined
      ? [{ id: "日本語 🌍" }, { id: "next" }]
      : [])
    const collection = defineCollection(load, {
      cursor: row => row.id,
      cursorSchema: v.pipe(v.string(), v.transform(value => value.toUpperCase())),
      defaultLimit: 1,
      maxLimit: 1,
    })

    const first = await collection.page({ query: {} })
    await collection.page({ cursor: first.nextCursor!, query: {} })
    expect(load).toHaveBeenLastCalledWith({ cursor: "日本語 🌍", limit: 2, query: {}, signal: undefined })

    const invalidOutput = defineCollection(async () => [{ id: 1 }, { id: 2 }], {
      cursor: row => row.id,
      cursorSchema: v.pipe(v.number(), v.transform(() => Number.POSITIVE_INFINITY)),
      defaultLimit: 1,
      maxLimit: 1,
    })
    const invalidPage = await invalidOutput.page({ query: {} })
    await expect(invalidOutput.page({ cursor: invalidPage.nextCursor!, query: {} }))
      .rejects.toBeInstanceOf(CollectionCursorError)
  })

  it("accepts plain cursor objects from another realm", async () => {
    // SAFETY: Node's VM evaluates the exact plain cursor object literal owned by this fixture.
    const cursor = runInNewContext("({ id: 'one' })") as { id: string }
    const collection = defineCollection(async () => [cursor, { id: "two" }], {
      cursor: row => row,
      cursorSchema: v.object({ id: v.string() }),
      defaultLimit: 1,
      maxLimit: 1,
    })

    await expect(collection.page({ query: {} })).resolves.toMatchObject({
      nextCursor: expect.any(String),
    })
  })

  it("derives the continuation cursor before a transform mutates its source item", async () => {
    const load = vi.fn(async ({ cursor }: { cursor?: number }) =>
      cursor === undefined
        ? [
            { createdAt: 2, id: "two" },
            { createdAt: 1, id: "one" },
          ]
        : [],
    )
    const collection = defineCollection(load, {
      cursor: row => row.createdAt,
      cursorSchema: v.number(),
      defaultLimit: 1,
      maxLimit: 1,
      transform(row) {
        row.createdAt = -1
        return { id: row.id }
      },
    })

    const first = await collection.page({ query: {} })
    await collection.page({ cursor: first.nextCursor!, query: {} })

    expect(first.items).toEqual([{ id: "two" }])
    expect(load).toHaveBeenLastCalledWith({ cursor: 2, limit: 2, query: {}, signal: undefined })
  })

  it("exposes authorize on the Collection and validates it", () => {
    const authorize = () => true
    const options = { cursor: (item: { id: number }) => item.id, cursorSchema: v.number() }
    expect(defineCollection(async () => [{ id: 1 }], { ...options, authorize }).authorize).toBe(authorize)
    expect(defineCollection(async () => [{ id: 1 }], { ...options, authorize: true }).authorize).toBe(true)
    expect(defineCollection(async () => [{ id: 1 }], options)).not.toHaveProperty("authorize")
    // SAFETY: The test deliberately violates the input contract to prove the runtime guard.
    expect(() => defineCollection(async () => [{ id: 1 }], { ...options, authorize: "yes" as never }))
      .toThrow("Collection authorize must be true or a function.")
  })

  it("rejects malformed cursors and invalid definition limits", async () => {
    const { collection } = mealsCollection()
    const query = await collection.parseQuery({})
    await expect(
      collection.page({
        cursor: "not-a-cursor",
        query,
      }),
    ).rejects.toBeInstanceOf(CollectionCursorError)
    for (const cursor of ["A", "AA=", "Zm9v==", "AA\u002fAA", "MB"]) {
      await expect(collection.page({ cursor, query })).rejects.toBeInstanceOf(CollectionCursorError)
    }
    const first = await collection.page({ query })
    await expect(collection.page({ cursor: `${first.nextCursor}==`, query })).rejects.toBeInstanceOf(CollectionCursorError)
    const wrongShape = btoa(JSON.stringify(["wrong"])).replaceAll("=", "")
    await expect(
      collection.page({ cursor: wrongShape, query: await collection.parseQuery({}) }),
    ).rejects.toBeInstanceOf(CollectionCursorError)
    const nonFinite = btoa('[1e400,"id"]').replaceAll("=", "")
    await expect(collection.page({ cursor: nonFinite, query: await collection.parseQuery({}) })).rejects.toBeInstanceOf(
      CollectionCursorError,
    )

    const negativeZero = defineCollection(async () => [{ id: -0 }, { id: 1 }], {
      cursor: row => row.id,
      cursorSchema: v.number(),
      defaultLimit: 1,
      maxLimit: 1,
    })
    await expect(negativeZero.page({ query: {} })).rejects.toThrow(
      "Collection cursor() must return a JSON-serializable value",
    )

    expect(() =>
      // SAFETY: This empty fixture preserves the row contract needed to test invalid limits.
      defineCollection(async () => [] as Array<{ id: string }>, {
        cursor: (row: { id: string }) => row.id,
        cursorSchema: v.string(),
        defaultLimit: 2,
        maxLimit: 1,
      }),
    ).toThrow("defaultLimit cannot exceed maxLimit")
  })

  it("rejects cyclic and prototype-backed cursor values", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const cyclicCollection = defineCollection(async () => [cyclic, {}], {
      cursor: row => row,
      cursorSchema: v.any(),
      defaultLimit: 1,
      maxLimit: 1,
    })

    await expect(cyclicCollection.page({ query: {} })).rejects.toThrow(
      "Collection cursor() must return a JSON-serializable value",
    )

    const prototypeCollection = defineCollection(async () => [new URL("https://vitehub.dev"), new URL("https://vitehub.dev/next")], {
      // SAFETY: This fixture deliberately violates the cursor type contract to verify runtime rejection.
      cursor: row => row as never,
      cursorSchema: v.any(),
      defaultLimit: 1,
      maxLimit: 1,
    })

    await expect(prototypeCollection.page({ query: {} })).rejects.toThrow(
      "Collection cursor() must return a JSON-serializable value",
    )
  })
})
