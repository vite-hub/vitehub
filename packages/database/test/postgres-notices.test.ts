// Runs only with a Postgres server, for example:
// docker run -d --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
// VITEHUB_TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:54329/postgres vitest run test/postgres-notices.test.ts
import { pgTable, serial } from "drizzle-orm/pg-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "../src/definition.ts"
import { createPostgresDatabase } from "../src/runtime/postgres.ts"

import type postgres from "postgres"

const url = process.env.VITEHUB_TEST_POSTGRES_URL

afterEach(() => {
  vi.restoreAllMocks()
})

describe.skipIf(!url)("the Postgres client of a Database", () => {
  it("prints nothing for an IF NOT EXISTS on an existing table, and prints a warning", async () => {
    const definition = defineDatabase({ dialect: "postgresql", schema: { notes: pgTable("notes", { id: serial("id").primaryKey() }) } })
    // SAFETY: the Postgres runtime keeps the postgres.js client as `$client`.
    const client = Reflect.get(createPostgresDatabase(definition, { binding: "HYPERDRIVE", url }), "$client") as postgres.Sql
    const table = `vitehub_notice_${Date.now()}`
    const log = vi.spyOn(console, "log")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const write = vi.spyOn(process.stdout, "write")
    try {
      await client.unsafe(`create table if not exists ${table} (id int)`)
      // The table exists now, so Postgres sends the notice "relation already exists, skipping".
      await client.unsafe(`create table if not exists ${table} (id int)`)
      await client.unsafe(`create schema if not exists public`)
      expect(log).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()

      await client.unsafe("do $$ begin raise warning 'vitehub test warning'; end $$")
      expect(warn.mock.calls).toEqual([["[vitehub] Postgres warning: vitehub test warning"]])
      // An error still rejects the query.
      await expect(client.unsafe("select * from vitehub_missing_table")).rejects.toThrow(/does not exist/)
    }
    finally {
      await client.unsafe(`drop table if exists ${table}`)
      await client.end()
    }
  })
})
