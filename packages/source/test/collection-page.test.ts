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
      const offset = cursor
        ? rows.findIndex((row) => row.createdAt === cursor[0] && row.id === cursor[1]) + 1
        : 0
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
    const nonFinite = btoa("[1e400,\"id\"]").replaceAll("=", "")
    await expect(
      collection.page({ cursor: nonFinite, query: await collection.parseQuery({}) }),
    ).rejects.toBeInstanceOf(CollectionCursorError)

    expect(() =>
      defineCollection(async () => [] as Array<{ id: string }>, {
        cursor: (row: { id: string }) => row.id,
        cursorSchema: v.string(),
        defaultLimit: 2,
        maxLimit: 1,
      }),
    ).toThrow("defaultLimit cannot exceed maxLimit")
  })
})
