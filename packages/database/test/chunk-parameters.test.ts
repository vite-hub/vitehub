import { createClient } from "@libsql/client"
import { inArray, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { chunkParameters } from "../src/runtime/chunk-parameters.ts"

const files = sqliteTable("files", {
  id: integer("id").primaryKey(),
  dropId: text("drop_id").notNull(),
  path: text("path").notNull(),
  size: integer("size").notNull(),
  type: text("type"),
  hash: text("hash"),
  createdAt: integer("created_at").notNull(),
})

const range = (length: number) => Array.from({ length }, (_, index) => index)
const sizes = (chunks: unknown[][]) => chunks.map(chunk => chunk.length)

describe("chunkParameters", () => {
  it("fits D1's 100 bound parameters by default", () => {
    expect(sizes(chunkParameters(range(250)))).toEqual([100, 100, 50])
    expect(sizes(chunkParameters(range(100)))).toEqual([100])
    expect(chunkParameters([])).toEqual([])
  })

  it("keeps room for the other parameters of the statement", () => {
    expect(sizes(chunkParameters(range(200), { reserved: 2 }))).toEqual([98, 98, 4])
    expect(sizes(chunkParameters(range(100), { per: 3 }))).toEqual([33, 33, 33, 1])
    expect(sizes(chunkParameters(range(10), { limit: 4, per: 2, reserved: 1 }))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
  })

  it("counts the columns of a Drizzle table for a multi-row insert", () => {
    expect(sizes(chunkParameters(range(30), { per: files }))).toEqual([14, 14, 2])
  })

  it("uses an explicit per count for SQL expressions with multiple bindings", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      const db = drizzle({ client })
      const expressions = sqliteTable("expressions", { value: text("value").notNull() })
      await db.run("CREATE TABLE expressions (value text NOT NULL)")
      const rows = range(100).map(value => ({ value: sql`${String(value)} || ${String(value)}` }))
      // The table shorthand counts columns, not bindings inside SQL expressions.
      expect(db.insert(expressions).values(chunkParameters(rows, { per: expressions })[0]!).toSQL().params).toHaveLength(200)
      for (const chunk of chunkParameters(rows, { per: 2 })) {
        const insert = db.insert(expressions).values(chunk)
        expect(insert.toSQL().params).toHaveLength(100)
        await insert
      }
      expect(await db.select().from(expressions)).toEqual(range(100).map(value => ({ value: `${value}${value}` })))
    }
    finally {
      client.close()
    }
  })

  it("throws when one value does not fit, or a count is not a whole number", () => {
    expect(() => chunkParameters([1], { per: 60, reserved: 50 })).toThrow("chunkParameters() cannot fit one value: it takes 60 bound parameters and the statement has 50 more, over the limit of 100.")
    expect(() => chunkParameters([1], { per: 0 })).toThrow(TypeError)
    expect(() => chunkParameters([1], { reserved: -1 })).toThrow(TypeError)
    expect(() => chunkParameters([1], { limit: 1.5 })).toThrow(TypeError)
  })

  it("gives Drizzle queries that bind at most 100 parameters", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      const db = drizzle({ client })
      await db.run("CREATE TABLE files (id integer PRIMARY KEY, drop_id text NOT NULL, path text NOT NULL, size integer NOT NULL, type text, hash text, created_at integer NOT NULL)")
      const rows = range(250).map(id => ({ createdAt: id, dropId: "d", hash: "h", id, path: `/${id}`, size: id, type: "text/plain" }))
      for (const chunk of chunkParameters(rows, { per: files })) {
        const insert = db.insert(files).values(chunk)
        expect(insert.toSQL().params.length).toBeLessThanOrEqual(100)
        await insert
      }
      const ids = range(250)
      let found = 0
      for (const chunk of chunkParameters(ids, { reserved: 1 })) {
        const select = db.select({ id: files.id }).from(files).where(inArray(files.id, chunk))
        expect(select.toSQL().params.length).toBeLessThanOrEqual(99)
        found += (await select).length
      }
      expect(found).toBe(250)
    }
    finally {
      client.close()
    }
  })
})
