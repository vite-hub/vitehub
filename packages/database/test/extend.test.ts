import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"
import { createServer as createViteServer } from "vite"

import { extendDatabaseSchema, resolveDBViteConfig } from "../src/config.ts"
import { hubDb } from "../src/vite.ts"

import type { DatabaseExtendContext, DatabaseExtendingPlugin } from "../src/types.ts"
import type { Plugin } from "vite"

const execFileAsync = promisify(execFile)
const drizzleKit = join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function writeProjectFile(rootDir: string, path: string, contents: string[]) {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents.join("\n"))
  return file
}

async function createProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-extend-"))
  tempDirs.push(rootDir)
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
  await writeFile(join(rootDir, "package.json"), '{"type":"module"}')
  await writeProjectFile(rootDir, "server/databases/config.ts", [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    "const notes = sqliteTable('notes', { id: integer('id').primaryKey(), title: text('title').notNull() })",
    "export default defineDatabase({",
    `  connection: { url: ${JSON.stringify(`file:${join(rootDir, "data/app.db")}`)} },`,
    "  schema: { notes },",
    "})",
    "",
  ])
  return rootDir
}

/** A fixture module that owns its tables and adds them to the app's Default Database. */
async function createAuthModule(rootDir: string, exports: string[] = []) {
  const schemaFile = await writeProjectFile(rootDir, "modules/auth/schema.ts", [
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    "export const user = sqliteTable('user', { id: text('id').primaryKey(), email: text('email').notNull() })",
    ...exports,
    "",
  ])
  const contexts: Array<Pick<DatabaseExtendContext, "dialect" | "name">> = []
  const plugin: Plugin & DatabaseExtendingPlugin = {
    name: "fixture-auth",
    vitehub: {
      database: {
        extend({ dialect, name, schemaFiles }) {
          contexts.push({ dialect, name })
          if (name === "default") schemaFiles.push(schemaFile)
        },
      },
    },
  }
  return { contexts, plugin, schemaFile }
}

describe("Database extensions", () => {
  it("adds tables from a Vite plugin to queries and generated migrations", async () => {
    const rootDir = await createProject()
    const auth = await createAuthModule(rootDir)
    await writeProjectFile(rootDir, "server/query.ts", [
      "import { useDatabase } from '@vite-hub/database/drizzle'",
      "export async function query() {",
      "  const { db, schema } = useDatabase('default')",
      "  await db.insert(schema.user).values({ id: 'u1', email: 'ada@example.com' })",
      "  return { rows: await db.select().from(schema.user), tables: Object.keys(schema).sort() }",
      "}",
      "",
    ])

    // The extending plugin runs after the Database plugin to prove registration order does not matter.
    const server = await createViteServer({
      configFile: false,
      logLevel: "silent",
      plugins: [hubDb(), auth.plugin],
      root: rootDir,
      server: { middlewareMode: true, watch: null },
    })
    try {
      expect(auth.contexts).toEqual([{ dialect: "sqlite", name: "default" }])
      await expect(readFile(join(rootDir, ".vitehub/types/database.d.ts"), "utf8")).resolves.toContain(
        "schema: typeof database_0.schema & Omit<typeof database_0_extension_0, \"default\">",
      )

      await execFileAsync(process.execPath, [drizzleKit, "generate", "--config", ".vitehub/database/drizzle.config.ts"], { cwd: rootDir })
      const migrationsDir = join(rootDir, "server/databases/migrations")
      const migration = (await readdir(migrationsDir)).find(file => file.endsWith(".sql"))
      const sql = await readFile(join(migrationsDir, migration!), "utf8")
      expect(sql).toContain("CREATE TABLE `notes`")
      expect(sql).toContain("CREATE TABLE `user`")
      await mkdir(join(rootDir, "data"), { recursive: true })
      await execFileAsync(process.execPath, [drizzleKit, "migrate", "--config", ".vitehub/database/drizzle.config.ts"], { cwd: rootDir })

      // SAFETY: This fixture writes the queried module immediately before Vite loads it.
      const module = await server.ssrLoadModule(join(rootDir, "server/query.ts")) as {
        query: () => Promise<{ rows: unknown[], tables: string[] }>
      }
      await expect(module.query()).resolves.toEqual({
        rows: [{ email: "ada@example.com", id: "u1" }],
        tables: ["notes", "user"],
      })
    }
    finally {
      await server.close()
    }
  }, 60_000)

  it("rejects an extension table that reuses a Definition schema key", async () => {
    const rootDir = await createProject()
    const auth = await createAuthModule(rootDir, ["export const notes = sqliteTable('auth_notes', { id: text('id') })"])
    const server = await createViteServer({
      configFile: false,
      logLevel: "silent",
      plugins: [auth.plugin, hubDb()],
      root: rootDir,
      server: { middlewareMode: true, watch: null },
    })
    try {
      await expect(server.ssrLoadModule(join(rootDir, ".vitehub/database/schema/default.ts"))).rejects.toThrow(
        "[vitehub] Database \"default\" schema key \"notes\" is exported by both server/databases/config.ts and modules/auth/schema.ts.",
      )
    }
    finally {
      await server.close()
    }
  }, 30_000)

  it("rejects a schema key that two extension files export", async () => {
    const rootDir = await createProject()
    const auth = await createAuthModule(rootDir)
    // The same table object under a second binding makes `export *` ambiguous, so Drizzle Kit would not see it.
    const billing = await writeProjectFile(rootDir, "modules/billing/schema.ts", [
      "import { user as authUser } from '../auth/schema.ts'",
      "export const user = authUser",
      "",
    ])
    const plugin: Plugin & DatabaseExtendingPlugin = {
      name: "fixture-billing",
      vitehub: { database: { extend: ({ schemaFiles }) => { schemaFiles.push(billing) } } },
    }
    const server = await createViteServer({
      configFile: false,
      logLevel: "silent",
      plugins: [auth.plugin, plugin, hubDb()],
      root: rootDir,
      server: { middlewareMode: true, watch: null },
    })
    try {
      await expect(server.ssrLoadModule(join(rootDir, ".vitehub/database/schema/default.ts"))).rejects.toThrow(
        "[vitehub] Database \"default\" schema key \"user\" is exported by both modules/auth/schema.ts and modules/billing/schema.ts.",
      )
    }
    finally {
      await server.close()
    }
  }, 30_000)

  it("rejects a schema file that does not exist", async () => {
    const rootDir = await createProject()
    const config = resolveDBViteConfig({}, rootDir)!
    await expect(extendDatabaseSchema(config, [({ schemaFiles }) => {
      schemaFiles.push("modules/missing/schema.ts")
    }])).rejects.toThrow(`Schema file "${join(rootDir, "modules/missing/schema.ts")}" added to Database "default" does not exist.`)
  })

  it("lists extension schema files in Database inspection", async () => {
    const rootDir = await createProject()
    const auth = await createAuthModule(rootDir)
    const plugin = hubDb()
    // SAFETY: hubDb returns a Vite plugin whose configResolved property is the hook handler used by this test.
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins: [plugin, auth.plugin], root: rootDir })

    expect(plugin.api.getConfig()?.schemaExtensionsByDatabase).toEqual({ default: [auth.schemaFile] })
    const [definition] = await plugin.vitehub!.inspect!()!.definitions![0]!.list()
    expect(definition?.fields).toContainEqual({ label: "Schema extensions", value: "modules/auth/schema.ts" })
  })
})
