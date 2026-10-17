import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { defineCollection } from "../src/index.ts"
import { table } from "../src/drizzle.ts"

const meals = sqliteTable("meals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})
const other = sqliteTable("other", { id: text("id").primaryKey() })

const rows = [
  { createdAt: new Date(3_000), id: "c", kind: "dinner" },
  { createdAt: new Date(2_000), id: "b", kind: "lunch" },
  { createdAt: new Date(1_000), id: "a", kind: "dinner" },
]

function fakeDatabase() {
  const limits: number[] = []
  return {
    limits,
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (limit: number) => {
              limits.push(limit)
              return rows.slice(0, limit)
            },
          }),
        }),
      }),
    }),
  }
}

describe("@vite-hub/source/drizzle", () => {
  it("reads a Drizzle table as a keyset Collection source", async () => {
    const db = fakeDatabase()
    const collection = defineCollection({
      source: table({
        db,
        defaultLimit: 2,
        orderBy: { column: meals.createdAt, direction: "desc", tieBreaker: meals.id },
        table: meals,
      }),
    })

    const page = await collection.page({ query: {} })

    expect(page.items.map(meal => meal.id)).toEqual(["c", "b"])
    expect(page.nextCursor).toEqual(expect.any(String))
    // The Collection asks for one more row than the page size to detect the next page.
    expect(db.limits).toEqual([3])
  })

  it("encodes the cursor with the column driver values", () => {
    const source = table({
      db: fakeDatabase(),
      orderBy: { column: meals.createdAt, direction: "desc", tieBreaker: meals.id },
      table: meals,
    })

    expect(source.cursor?.(rows[0]!)).toEqual([3_000, "c"])
  })

  it("rejects order columns that cannot give a stable order", () => {
    const db = fakeDatabase()

    expect(() => table({
      db,
      orderBy: { column: meals.createdAt, direction: "asc", tieBreaker: meals.kind },
      table: meals,
    })).toThrow(expect.objectContaining({ code: "SOURCE_R0033" }))
    expect(() => table({
      db,
      // @ts-expect-error The order column must belong to the table.
      orderBy: { column: other.id, direction: "asc", tieBreaker: meals.id },
      table: meals,
    })).toThrow(expect.objectContaining({ code: "SOURCE_R0030" }))
  })
})
