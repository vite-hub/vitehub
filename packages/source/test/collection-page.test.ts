import { describe, expect, it, vi } from "vitest"

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
      defaultLimit: 2,
      maxLimit: 2,
      parseCursor(input) {
        if (
          !Array.isArray(input) ||
          input.length !== 2 ||
          typeof input[0] !== "number" ||
          typeof input[1] !== "string"
        ) {
          throw new TypeError("Meal cursor must contain a timestamp and id.")
        }
        return [input[0], input[1]] as const
      },
      query(input) {
        return { day: typeof input.day === "string" ? input.day : undefined }
      },
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
    const query = collection.parseQuery({ day: "2026-08-21" })
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

  it("rejects malformed cursors and invalid definition limits", async () => {
    const { collection } = mealsCollection()
    await expect(
      collection.page({
        cursor: "not-a-cursor",
        query: collection.parseQuery({}),
      }),
    ).rejects.toBeInstanceOf(CollectionCursorError)

    expect(() =>
      defineCollection(async () => [] as Array<{ id: string }>, {
        cursor: (row: { id: string }) => row.id,
        defaultLimit: 2,
        maxLimit: 1,
      }),
    ).toThrow("defaultLimit cannot exceed maxLimit")
  })
})
