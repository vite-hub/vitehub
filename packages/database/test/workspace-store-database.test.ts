import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { databases } from "../src/runtime/registry.ts"
import { createBlobDatabaseWorkspaceStore } from "../../workspace/src/blob-database.ts"
import type { BlobDatabaseWorkspaceStoreTarget } from "../../workspace/src/blob-database.ts"
import { resolveWorkspaceStoreTarget } from "../../workspace/src/storage/target.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"

// The build gives the `history` Database a migrations folder outside `server/databases/history/` (as for a contributed
// Definition) and relations that include a contributed table. A Definition alone knows neither.
const migrationsDir = "vendor/history/migrations"
vi.mock("#vitehub/database/databases", async () => {
  const { defineRelations } = await import("drizzle-orm")
  const { integer, sqliteTable, text } = await import("drizzle-orm/sqlite-core")
  const { workspaceHistorySchema } = await import("../../workspace/src/storage/history-schema.ts")
  const notes = sqliteTable("contributed_notes", { id: integer().primaryKey(), workspace: text().notNull() })
  const schema = { ...workspaceHistorySchema, notes }
  return {
    default: {
      history: {
        config: {
          connection: { url: "file:unused.sqlite" },
          dialect: "sqlite",
          generatedSchemaFile: ".vitehub/database/schema/history.ts",
          migrationsDir: "vendor/history/migrations",
          mode: "named",
          name: "history",
          orm: "drizzle",
        },
        relations: defineRelations(schema, r => ({
          notes: { owner: r.one.workspaceHistoryWorkspaces({ from: r.notes.workspace, to: r.workspaceHistoryWorkspaces.workspace }) },
        })),
        schema,
      },
    },
  }
})

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-database-"))
  const history = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
  const folder = join(root, migrationsDir, "20260901000000_history")
  await mkdir(folder, { recursive: true })
  // Drizzle Kit 1.0 separates statements with a breakpoint line.
  const statements = [...history.split(";").filter(statement => statement.trim()), "CREATE TABLE contributed_notes (id integer PRIMARY KEY, workspace text NOT NULL)"]
  await writeFile(join(folder, "migration.sql"), statements.join(";\n--> statement-breakpoint\n"))
})

afterAll(async () => {
  await enableViteHubTestMode({ root }).reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  await rm(root, { force: true, recursive: true })
})

it("gives the Workspace store the database of the build, with its migrations folder and merged relations", async () => {
  const mode = enableViteHubTestMode({ root })
  await mode.reset()
  // `databases.history` is the entry that `useDatabase("history")` returns. This test has no generated registry types.
  const database = vi.fn(() => databases.history!.db)
  const store = createBlobDatabaseWorkspaceStore({
    blob: createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") })),
    database,
    workspace: "site",
  })
  // A Workspace Definition module creates the store while the build loads it without the app's Databases.
  expect(database).not.toHaveBeenCalled()

  const revision = await store.history.commit({ files: { "guide.md": { content: "hello", path: "guide.md" } }, ifHead: null })
  expect(await store.history.head()).toEqual(revision)
  expect(database).toHaveBeenCalledOnce()

  // SAFETY: A Blob + Database Store always reports its Blob + Database target.
  const target = await resolveWorkspaceStoreTarget(store) as BlobDatabaseWorkspaceStoreTarget
  expect(target.database).toBe(databases.history!.db)
  // The contributed relation exists only in the relations that the build merged.
  await target.database.run(sql`INSERT INTO contributed_notes (id, workspace) VALUES (1, (SELECT workspace FROM workspace_history_workspaces))`)
  // SAFETY: Without generated registry types, the relational query API of this database is untyped.
  const notes = Reflect.get(databases.history!.db.query, "notes") as { findFirst: (options: { with: { owner: true } }) => Promise<unknown> }
  await expect(notes.findFirst({ with: { owner: true } })).resolves.toMatchObject({ id: 1, owner: { deleted: false } })
})

it("rejects a Database Definition with WORKSPACE_R0077", async () => {
  const { defineDatabase } = await import("../src/definition.ts")
  const { workspaceHistorySchema } = await import("../../workspace/src/storage/history-schema.ts")
  const definition = defineDatabase({ name: "history", schema: workspaceHistorySchema })
  const store = createBlobDatabaseWorkspaceStore({
    blob: createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") })),
    // @ts-expect-error A Definition is not a Drizzle database.
    database: definition,
    workspace: "site",
  })

  await expect(store.history.head()).rejects.toMatchObject({ code: "WORKSPACE_R0077", fix: expect.stringContaining("useDatabase(\"history\").db") })
})
