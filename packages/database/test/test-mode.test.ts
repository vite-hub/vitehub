import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { databases, db } from "../src/runtime/drizzle-runtime.ts"
import { ensureDatabaseMigrations } from "../src/runtime/migrate-on-start.ts"

const fixture = vi.hoisted(() => ({ enabled: true }))
vi.mock("#vitehub/database/databases", async () => {
  const { defineRelations } = await import("drizzle-orm")
  const { integer, sqliteTable, text } = await import("drizzle-orm/sqlite-core")
  const notes = sqliteTable("notes", {
    id: integer().primaryKey({ autoIncrement: true }),
    title: text().notNull(),
  })
  return {
    get default() {
      return fixture.enabled ? {
        default: {
          config: {
            connection: { url: "file:unused.sqlite" },
            dialect: "sqlite",
            generatedSchemaFile: ".vitehub/database/schema/default.ts",
            migrationsDir: "server/databases/default/migrations",
            mode: "default",
            name: "default",
            orm: "drizzle",
          },
          relations: defineRelations({ notes }),
          schema: { notes },
        },
      } : { missing: { relations: {}, schema: {} } }
    },
  }
})

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-database-test-mode-"))
  const migrations = join(root, "server/databases/default/migrations")
  // Drizzle Kit 1.0 writes one folder per migration.
  await mkdir(join(migrations, "20260901000000_notes"), { recursive: true })
  await writeFile(join(migrations, "20260901000000_notes/migration.sql"), "CREATE TABLE `notes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`title` text NOT NULL\n);\n")
})

afterAll(async () => {
  await enableViteHubTestMode({ root }).reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  await rm(root, { force: true, recursive: true })
})

it("gives the default database an in-memory SQLite with the app's migrations, empty after each reset", async () => {
  const mode = enableViteHubTestMode({ root })

  expect(Object.keys(db.query)).toEqual(["notes"])
  await db.run(sql`INSERT INTO notes (title) VALUES ('first')`)
  expect(await db.all(sql`SELECT id, title FROM notes`)).toEqual([{ id: 1, title: "first" }])

  await mode.reset()

  expect(await db.all(sql`SELECT id, title FROM notes`)).toEqual([])
})

it("skips a SQLite database in ensureMigrations(), because the test database already has its migrations", async () => {
  const mode = enableViteHubTestMode({ root })
  await mode.reset()
  const notes = { dataLoss: [], hash: "notes", name: "20260901000000_notes", statements: ["CREATE TABLE `notes` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `title` text NOT NULL)"], when: 1 }
  await ensureDatabaseMigrations({ databases, load: async () => ({ allowDataLoss: false, databases: { default: { dialect: "sqlite", migrations: [notes] } } }) })
  await db.run(sql`INSERT INTO notes (title) VALUES ('kept')`)
  expect(await db.all(sql`SELECT title FROM notes`)).toEqual([{ title: "kept" }])
})

it("keeps disabled and unconfigured databases unavailable in test mode", async () => {
  const mode = enableViteHubTestMode({ root })
  await mode.reset()
  fixture.enabled = false
  vi.resetModules()
  const { databases, db: disabled } = await import("../src/runtime/drizzle-runtime.ts")

  expect(() => disabled.run).toThrow(expect.objectContaining({ code: "DATABASE_DISABLED" }))
  expect(() => databases.missing!.db.run).toThrow(expect.objectContaining({ code: "DATABASE_NOT_FOUND" }))
  expect(mode.peek("database:default")).toBeUndefined()
  expect(mode.peek("database:missing")).toBeUndefined()
})
