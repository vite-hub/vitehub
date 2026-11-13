import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { defineRelations, eq, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@vite-hub/web-container/env", () => ({ isWebContainer: () => true }))

const schema = {
  notes: sqliteTable("notes", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
  }),
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vitehub-database-web-container-"))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { force: true, recursive: true })
})

it("opens a local file with SQLite WASM in a WebContainer and logs it once", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const path = join(dir, "data", "sqlite.db")
  const { createDefinitionRuntime } = await import("../src/runtime/definition-local.ts")
  const db = createDefinitionRuntime({ connection: { url: `file:${path}` }, name: "default", relations: defineRelations(schema), schema })

  await db.run(sql`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)`)
  await db.insert(schema.notes).values({ title: "first" })
  await db.transaction(async (tx) => {
    await tx.insert(schema.notes).values({ title: "second" })
    await tx.update(schema.notes).set({ title: "renamed" }).where(eq(schema.notes.title, "first"))
  })
  await expect(db.select().from(schema.notes)).resolves.toEqual([{ id: 1, title: "renamed" }, { id: 2, title: "second" }])

  expect(warn).toHaveBeenCalledOnce()
  expect(String(warn.mock.calls[0]![0])).toContain("SQLite WASM")

  // The file on disk is a SQLite database that native libSQL reads.
  const native = createClient({ url: `file:${path}` })
  expect((await native.execute("SELECT title FROM notes ORDER BY id")).rows.map(row => row.title)).toEqual(["renamed", "second"])
  native.close()
})
