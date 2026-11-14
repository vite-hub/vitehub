import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { expect, it } from "vitest"

import { syncTables } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { syncOperations } from "../src/operations.ts"
import { createSyncHandler, recordSyncChanges } from "../src/runtime.ts"

const notes = sqliteTable("notes", { id: text("id").primaryKey(), body: text("body").notNull() })

function operation(name: string) {
  const found = syncOperations.find(candidate => candidate.name === name)
  if (!found) throw new TypeError(`Missing ${name}`)
  // SAFETY: the test calls the operation with the input of its schema.
  return found as typeof found & { run: (input: unknown, context: never) => Promise<unknown>, cli: { format: (output: never) => string } }
}

it("lists the definitions and their changes without row data", async () => {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${[...syncTables, "CREATE TABLE `notes` (`id` text PRIMARY KEY NOT NULL, `body` text NOT NULL)"].join(";\n")};`)
  const db = drizzle({ client })
  createSyncHandler({ definitions: { notes: defineSync({ table: notes, where: () => ({}), write: false }) }, databases: { default: { db } } })
  await db.insert(notes).values([{ id: "n1", body: "secret text" }, { id: "n2", body: "more" }])
  await recordSyncChanges("notes", { put: ["n1", "n2"] })

  const summary = await operation("sync.list").run({}, undefined as never)
  expect(summary).toEqual([{ name: "notes", table: "notes", key: "id", write: "no", live: true, actions: [], rows: 2, changes: 2, exits: 0, floor: 0, lastSeq: 2 }])
  expect(operation("sync.list").cli.format(summary as never)).toContain("notes")

  const changes = await operation("sync.changes").run({ name: "notes", limit: 1 }, undefined as never)
  expect(changes).toEqual([{ seq: 2, key: "n2", op: "put", createdAt: expect.any(Number) }])

  // A deleted row adds an exit, and the list shows the actions and `live: false`.
  createSyncHandler({ definitions: { notes: defineSync({ table: notes, where: () => ({}), live: false, actions: { touch: () => {}, archive: () => {} } }) }, databases: { default: { db } } })
  const [removed] = await db.select().from(notes).limit(1)
  await recordSyncChanges("notes", { delete: [removed!] })
  const after = await operation("sync.list").run({}, undefined as never)
  expect(after).toEqual([expect.objectContaining({ live: false, actions: ["archive", "touch"], exits: 1, changes: 2 })])
  const text = operation("sync.list").cli.format(after as never)
  expect(text).toContain("archive,touch")
  expect(text).toContain("EXITS")
  expect(JSON.stringify(changes)).not.toContain("secret")
  await expect(operation("sync.changes").run({ name: "nope" }, undefined as never)).rejects.toMatchObject({ code: "SYNC_UNKNOWN_NAME" })
})
