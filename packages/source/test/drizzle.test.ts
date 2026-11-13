import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { defineCollection } from "../src/index.ts"
import { table } from "../src/drizzle.ts"
import { defineCollectionHandler } from "../src/server.ts"

const meals = sqliteTable("meals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})
const other = sqliteTable("other", { id: text("id").primaryKey() })
const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
})

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
      route: false,
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

  describe("public access", () => {
    function usersDatabase() {
      const rows = [{ id: "u1", name: "Ada", passwordHash: "$argon2id$secret" }]
      return { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }) }
    }
    function usersSource() {
      return table({ db: usersDatabase(), orderBy: { column: users.id, direction: "asc", tieBreaker: users.id }, table: users })
    }

    it("does not give a table Collection without authorize a route", () => {
      // A users table with password hashes was served to anyone at /api/users.
      // @ts-expect-error A routed Collection must set authorize.
      expect(() => defineCollectionHandler(defineCollection({ source: usersSource() })))
        .toThrow(expect.objectContaining({ code: "SOURCE_R0035" }))
    })

    it("refuses a public table Collection without transform", () => {
      // @ts-expect-error A public Collection over table() must pick its fields with transform.
      expect(() => defineCollection({ access: "public", source: usersSource() }))
        .toThrow(expect.objectContaining({ code: "SOURCE_R0036" }))
    })

    it("serves only the transformed fields of a public table Collection", async () => {
      const collection = defineCollection({
        access: "public",
        source: usersSource(),
        transform: ({ id, name }) => ({ id, name }),
      })

      const response = await defineCollectionHandler(collection).fetch(new Request("https://app.test/api/users"))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ items: [{ id: "u1", name: "Ada" }], nextCursor: null })
    })

    it("keeps whole rows for signed-in and server-only Collections", () => {
      expect(defineCollection({ authorize: true, source: usersSource() }).authorize).toBe(true)
      expect(defineCollection({ route: false, source: usersSource() }).route).toBe(false)
    })
  })
})
