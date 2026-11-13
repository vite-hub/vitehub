// Runs only with a Postgres server, for example:
// docker run -d --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
// VITEHUB_TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:54329/postgres vitest run test/postgres-replicas.test.ts
import { randomUUID } from "node:crypto"

import { integer, pgTable, text } from "drizzle-orm/pg-core"
import postgres from "postgres"
import { afterEach, describe, expect, it } from "vitest"

import { defineDatabase } from "../src/definition.ts"
import { createPostgresDatabase } from "../src/runtime/postgres.ts"

const adminUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const notes = pgTable("notes", { id: integer("id").primaryKey(), source: text("source").notNull() })

/** Creates a database with one row that names it, and returns its URL. */
async function createDatabase(source: string) {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
  const name = `vitehub_replica_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  await admin.unsafe(`create database ${name}`)
  cleanups.push(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`)
    await admin.end()
  })
  const url = new URL(adminUrl!)
  url.pathname = `/${name}`
  const sql = postgres(url.href, { max: 1, onnotice: () => {} })
  await sql.unsafe(`create table notes (id integer primary key, source text not null); insert into notes values (1, '${source}');`).simple()
  await sql.end()
  return url.href
}

describe.skipIf(!adminUrl)("Postgres read replicas", () => {
  // Two databases on one server stand in for a primary and its replica, so each read shows where it went.
  it("sends `db.$replica` reads to the replica, and other queries and writes to the primary", { timeout: 30_000 }, async () => {
    const primaryUrl = await createDatabase("primary")
    const replicaUrl = await createDatabase("replica")
    const db = createPostgresDatabase(defineDatabase({
      connection: { replicas: [replicaUrl], url: primaryUrl },
      dialect: "postgresql",
      schema: { notes },
    }), { binding: "HYPERDRIVE" })
    cleanups.push(async () => {
      await Reflect.get(db, "$client").end()
      await Reflect.get(db.$replica, "$client").end()
    })

    expect(await db.select().from(notes)).toEqual([{ id: 1, source: "primary" }])
    expect(await db.$replica.select().from(notes)).toEqual([{ id: 1, source: "replica" }])
    expect(await db.$replica.query.notes.findFirst()).toEqual({ id: 1, source: "replica" })

    await db.insert(notes).values({ id: 2, source: "write" })
    expect(await db.select().from(notes).orderBy(notes.id)).toEqual([{ id: 1, source: "primary" }, { id: 2, source: "write" }])
    expect(await db.$replica.select().from(notes)).toEqual([{ id: 1, source: "replica" }])
    await db.transaction(async (transaction) => {
      await transaction.insert(notes).values({ id: 3, source: "transaction" })
    })
    expect((await db.select().from(notes)).map(note => note.id).sort()).toEqual([1, 2, 3])
  })
})
