import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient } from "@libsql/client"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

const collectionSchema = {
  meals: sqliteTable("meals", {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  }),
}

let tempDir = ""
let closeDatabase = () => {}
let runtimeDatabase: object = {}

;(vi.mock as any)("@vite-hub/database/drizzle", () => ({
  databases: {},
  schema: collectionSchema,
  useDatabase: () => runtimeDatabase,
}), { virtual: true })

afterEach(async () => {
  closeDatabase()
  closeDatabase = () => {}
  vi.resetModules()
  runtimeDatabase = {}
  if (tempDir) await rm(tempDir, { force: true, recursive: true })
  tempDir = ""
})

async function createTestDatabase() {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-drizzle-collection-"))
  const client = createClient({ url: `file:${join(tempDir, "collection.sqlite")}` })
  closeDatabase = () => client.close()
  const db = drizzle({ client, schema: collectionSchema })
  runtimeDatabase = { db, schema: collectionSchema }
  return { db, schema: collectionSchema }
}

describe("table Collection source", () => {
  it("owns stable keyset pagination and applies filters before fetching pages", async () => {
    const { db, schema } = await createTestDatabase()
    const { defineCollection, table } = await import("../src/source.ts")
    await db.run(sql`
      create table meals (
        id text primary key,
        kind text not null,
        created_at integer not null
      )
    `)
    await db.insert(schema.meals).values([
      { createdAt: new Date(3_000), id: "c", kind: "dinner" },
      { createdAt: new Date(3_000), id: "b", kind: "lunch" },
      { createdAt: new Date(3_000), id: "a", kind: "dinner" },
      { createdAt: new Date(2_000), id: "z", kind: "dinner" },
    ])

    const meals = defineCollection({
      source: table({
        db,
        defaultLimit: 2,
        orderBy: {
          column: schema.meals.createdAt,
          direction: "desc",
          tieBreaker: schema.meals.id,
        },
        table: schema.meals,
      }),
    })

    const first = await meals.page({ query: {} })
    expect(first.items.map(meal => meal.id)).toEqual(["c", "b"])
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await meals.page({ cursor: first.nextCursor!, query: {} })
    expect(second.items.map(meal => meal.id)).toEqual(["a", "z"])
    expect(second.nextCursor).toBeNull()

    const dinners = defineCollection({
      source: table({
        db,
        defaultLimit: 2,
        orderBy: {
          column: schema.meals.createdAt,
          direction: "desc",
          tieBreaker: schema.meals.id,
        },
        table: schema.meals,
        where: ({ query, table }) =>
          typeof query.kind === "string" ? eq(table.kind, query.kind) : undefined,
      }),
    })
    const dinnerPage = await dinners.page({ query: { kind: "dinner" } })
    expect(dinnerPage.items.map(meal => meal.id)).toEqual(["c", "a"])
    const finalDinnerPage = await dinners.page({
      cursor: dinnerPage.nextCursor!,
      query: { kind: "dinner" },
    })
    expect(finalDinnerPage.items.map(meal => meal.id)).toEqual(["z"])
  })

  it("rejects an unstable tie-breaker", async () => {
    const { db, schema } = await createTestDatabase()
    const { defineCollection, table } = await import("../src/source.ts")

    expect(() => defineCollection({
      source: table({
        db,
        orderBy: {
          column: schema.meals.createdAt,
          direction: "desc",
          tieBreaker: schema.meals.kind,
        },
        table: schema.meals,
      }),
    })).toThrow("Collection orderBy tieBreaker must be unique")
  })
})
