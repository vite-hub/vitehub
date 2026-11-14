import { createClient } from "@libsql/client"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { expect, it } from "vitest"

import { syncTables } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { syncOperations } from "../src/operations.ts"
import { createSyncHandler } from "../src/runtime.ts"

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
  const handler = createSyncHandler({ definitions: { notes: defineSync({ table: notes, where: () => ({}), write: false }) }, db: () => db })
  expect(await operation("sync.list").run({}, undefined as never)).toEqual([expect.objectContaining({ triggers: false, changes: 0 })])
  // The first request adds the triggers and raises the floor. From then on, every write of the table is in the change log.
  expect((await handler.fetch(new Request("https://app.test/api/_vitehub/sync/notes"))).status).toBe(200)
  await db.insert(notes).values([{ id: "n1", body: "secret text" }, { id: "n2", body: "more" }])

  const summary = await operation("sync.list").run({}, undefined as never)
  expect(summary).toEqual([{ name: "notes", table: "notes", key: "id", write: "no", live: true, subsets: [], actions: [], rows: 2, changes: 2, exits: 0, floor: 1, lastSeq: 3, triggers: true, scopeColumns: [] }])
  expect(operation("sync.list").cli.format(summary as never)).toContain("notes")

  const changes = await operation("sync.changes").run({ name: "notes", limit: 1 }, undefined as never)
  expect(changes).toEqual([{ seq: 3, key: "n2", op: "put", createdAt: expect.any(Number) }])

  // A deleted row adds an exit, and the list shows the actions and `live: false`.
  createSyncHandler({ definitions: { notes: defineSync({ table: notes, where: () => ({}), live: false, subsets: ["body"], actions: { touch: () => {}, archive: () => {} } }) }, db: () => db })
  const [removed] = await db.select().from(notes).limit(1)
  await db.delete(notes).where(eq(notes.id, removed!.id))
  const after = await operation("sync.list").run({}, undefined as never)
  expect(after).toEqual([expect.objectContaining({ live: false, subsets: ["body"], actions: ["archive", "touch"], exits: 1, changes: 2, rows: 1 })])
  const text = operation("sync.list").cli.format(after as never)
  expect(text).toContain("archive,touch")
  expect(text).toContain("EXITS")
  expect(text).toContain("SUBSETS")
  expect(text).toContain("TRIGGERS")
  expect(JSON.stringify(changes)).not.toContain("secret")
  await expect(operation("sync.changes").run({ name: "nope" }, undefined as never)).rejects.toMatchObject({ code: "SYNC_UNKNOWN_NAME" })
})
