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

  it("rejects malformed cursors and invalid definition limits", async () => {
    const { collection } = mealsCollection()
    await expect(
      collection.page({
        cursor: "not-a-cursor",
        query: await collection.parseQuery({}),
      }),
    ).rejects.toBeInstanceOf(CollectionCursorError)
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
