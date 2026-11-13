import { VITEHUB_DEPLOYMENT_HOST } from "@vite-hub/internal/build/vite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { defineRelations, inArray, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createCloudflareD1HttpResolver } from "../src/runtime/d1-http.ts"
import { createDrizzleSqliteAdapter } from "../src/runtime/drizzle-adapter.ts"
import { localLibsql } from "../src/runtime/local-client.ts"
import { hubDb } from "../src/vite.ts"

import type { RuntimeDrizzleDatabaseConfig } from "../src/types.ts"

const schema = {
  notes: sqliteTable("notes", {
    id: integer("id").primaryKey(),
    title: text("title").notNull(),
  }),
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => index + 1)

function localDb(config: Partial<RuntimeDrizzleDatabaseConfig>) {
  return createDrizzleSqliteAdapter({ connection: { url: ":memory:" }, name: "default", ...config }, defineRelations(schema), {
    libsql: localLibsql,
    missingConnection: "a Cloudflare D1 binding or `connection.url`",
    requireRemoteUrl: false,
  })
}

async function rejection(query: PromiseLike<unknown>): Promise<unknown> {
  try {
    await query
  }
  catch (error) {
    return error instanceof Error && error.cause ? error.cause : error
  }
  throw new Error("The query did not reject.")
}

describe("D1 limits on local SQLite in a dev server for Cloudflare", () => {
  it("rejects more than 100 bound parameters with the D1 code", async () => {
    const db = localDb({ cloudflare: { binding: "DB" }, localLimits: "d1" })
    await db.run(sql`create table notes (id integer primary key, title text not null)`)

    await expect(db.select().from(schema.notes).where(inArray(schema.notes.id, ids(100)))).resolves.toEqual([])
    expect(await rejection(db.select().from(schema.notes).where(inArray(schema.notes.id, ids(101))))).toMatchObject({
      code: "DATABASE_D1_TOO_MANY_PARAMETERS",
      docs: "https://vitehub.dev/docs/database/diagnostics/database_d1_too_many_parameters",
      why: "The query binds 101 parameters. Cloudflare D1 accepts at most 100 bound parameters per query.",
    })
  })

  it("rejects an SQL statement above 100,000 bytes and a value above 2,000,000 bytes", async () => {
    const db = localDb({ cloudflare: { binding: "DB" }, localLimits: "d1" })
    await db.run(sql`create table notes (id integer primary key, title text not null)`)

    expect(await rejection(db.run(sql.raw(`select 1 /* ${"x".repeat(100_000)} */`)))).toMatchObject({ code: "DATABASE_D1_STATEMENT_TOO_LONG" })
    expect(await rejection(db.insert(schema.notes).values({ id: 1, title: "x".repeat(2_000_001) }))).toMatchObject({
      code: "DATABASE_D1_VALUE_TOO_LARGE",
      why: "A bound value is 2000001 bytes. Cloudflare D1 accepts strings and BLOBs of at most 2000000 bytes.",
    })
    await expect(db.insert(schema.notes).values({ id: 2, title: "x".repeat(2_000_000) })).resolves.toBeDefined()
  })

  it("checks batches and transactions", async () => {
    const db = localDb({ cloudflare: { binding: "DB" }, localLimits: "d1" })
    await db.run(sql`create table notes (id integer primary key, title text not null)`)

    expect(await rejection(db.batch([db.select().from(schema.notes).where(inArray(schema.notes.id, ids(101)))]))).toMatchObject({ code: "DATABASE_D1_TOO_MANY_PARAMETERS" })
    expect(await rejection(db.transaction(tx => tx.select().from(schema.notes).where(inArray(schema.notes.id, ids(101)))))).toMatchObject({ code: "DATABASE_D1_TOO_MANY_PARAMETERS" })
  })

  it("keeps SQLite limits without a Cloudflare target or without D1", async () => {
    for (const config of [{ cloudflare: { binding: "DB" } }, { localLimits: "d1" as const }]) {
      const db = localDb(config)
      await db.run(sql`create table notes (id integer primary key, title text not null)`)
      await expect(db.select().from(schema.notes).where(inArray(schema.notes.id, ids(101)))).resolves.toEqual([])
    }
  })
})

describe("D1 limits on a D1 binding", () => {
  it("rejects more than 100 bound parameters before the binding runs the query", async () => {
    const prepared: string[] = []
    const statement = {
      all: async () => ({ results: [] }),
      bind: () => statement,
      raw: async () => [],
      run: async () => ({}),
    }
    const binding = { batch: async () => [], prepare: (query: string) => { prepared.push(query); return statement } }
    const db = createDrizzleSqliteAdapter({ cloudflare: { binding: "DB" }, name: "default" }, defineRelations(schema), { missingConnection: "a D1 binding", requireRemoteUrl: true })

    const error = await runWithActiveCloudflareEnv({ DB: binding }, () => rejection(db.select().from(schema.notes).where(inArray(schema.notes.id, ids(101)))))

    expect(error).toMatchObject({ code: "DATABASE_D1_TOO_MANY_PARAMETERS" })
    await expect(runWithActiveCloudflareEnv({ DB: binding }, () => db.select().from(schema.notes).where(inArray(schema.notes.id, ids(100))))).resolves.toEqual([])
  })
})

describe("D1 limits on D1 HTTP", () => {
  it("rejects more than 100 bound parameters before the request", async () => {
    const request = vi.fn(async () => Response.json({ success: true, result: [{ success: true, results: { rows: [] } }] }))
    const getDatabase = createCloudflareD1HttpResolver({
      cloudflare: { databaseId: "notes-id", http: { authToken: "token", url: "https://d1.example.com/raw" } },
      name: "default",
    }, defineRelations(schema), request)

    expect(await rejection(getDatabase().select().from(schema.notes).where(inArray(schema.notes.id, ids(101))))).toMatchObject({ code: "DATABASE_D1_TOO_MANY_PARAMETERS" })
    expect(request).not.toHaveBeenCalled()
    await expect(getDatabase().select().from(schema.notes).where(inArray(schema.notes.id, ids(100)))).resolves.toEqual([])
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe("the Vite databases module", () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  async function databasesModule(config: Record<string, unknown>): Promise<string | undefined> {
    // Inside the repository, so the Definition can import `@vite-hub/database` and Drizzle when it loads.
    await mkdir(join(import.meta.dirname, "../../../.vitest-tmp"), { recursive: true })
    const root = await mkdtemp(join(import.meta.dirname, "../../../.vitest-tmp/d1-limits-"))
    roots.push(root)
    await mkdir(join(root, "server/databases"), { recursive: true })
    await writeFile(join(root, "server/databases/default.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "export default defineDatabase({ schema: { notes: sqliteTable('notes', { title: text('title') }) } })",
      "",
    ].join("\n"))
    const plugin = hubDb({ driver: "d1" })
    // SAFETY: These are Vite hook handlers returned by hubDb.
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, ...config })
    // SAFETY: These are Vite hook handlers returned by hubDb.
    const resolveId = (plugin.resolveId as { handler: (id: string) => string | undefined }).handler
    // SAFETY: These are Vite hook handlers returned by hubDb.
    const load = (plugin.load as { handler: (id: string) => string | undefined }).handler
    return load(resolveId("#vitehub/database/databases")!)
  }

  it("asks local SQLite for the D1 limits only in a dev server for Cloudflare", async () => {
    expect(await databasesModule({ command: "serve", [VITEHUB_DEPLOYMENT_HOST]: "cloudflare" })).toContain('localLimits: "d1"')
    expect(await databasesModule({ command: "serve", nitro: { preset: "cloudflare-module" } })).toContain('localLimits: "d1"')
    expect(await databasesModule({ command: "serve", [VITEHUB_DEPLOYMENT_HOST]: "node" })).not.toContain("localLimits")
    expect(await databasesModule({ command: "build", [VITEHUB_DEPLOYMENT_HOST]: "cloudflare" })).not.toContain("localLimits")
  })
})
