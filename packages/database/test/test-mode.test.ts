import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { db } from "../src/runtime/drizzle-runtime.ts"

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-database-test-mode-"))
  const migrations = join(root, "server/databases/migrations")
  await mkdir(join(migrations, "meta"), { recursive: true })
  await writeFile(join(migrations, "0000_notes.sql"), "CREATE TABLE `notes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`title` text NOT NULL\n);\n")
  await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify({
    dialect: "sqlite",
    entries: [{ breakpoints: true, idx: 0, tag: "0000_notes", version: "6", when: 1_788_000_000_000 }],
    version: "7",
  }))
})

afterAll(async () => {
  await enableViteHubTestMode({ root }).reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  await rm(root, { force: true, recursive: true })
})

it("gives the default database an in-memory SQLite with the app's migrations, empty after each reset", async () => {
  const mode = enableViteHubTestMode({ root })

  await db.run(sql`INSERT INTO notes (title) VALUES ('first')`)
  expect(await db.all(sql`SELECT id, title FROM notes`)).toEqual([{ id: 1, title: "first" }])

  await mode.reset()

  expect(await db.all(sql`SELECT id, title FROM notes`)).toEqual([])
})
