import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createClient } from "@libsql/client"
import { createClient as createHttpClient } from "@libsql/client/http"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { authTokenVariable, connectDatabase as connectWorker, parseDatabaseLocation } from "../src/connect.ts"
import { connectDatabase } from "../src/connect/node.ts"

import type { SQLInputValue } from "node:sqlite"

vi.mock("@libsql/client/http", () => ({ createClient: vi.fn() }))

const notes = sqliteTable("notes", { id: integer("id").primaryKey(), body: text("body").notNull() })
const setup = ["CREATE TABLE IF NOT EXISTS notes (id integer PRIMARY KEY, body text NOT NULL)"]

/** A D1 binding on an in-memory SQLite database, with D1's result shapes: `raw()` arrays, and batch rows as objects. */
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:")
  const queries: string[] = []
  class Statement {
    constructor(readonly query: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: unknown[]) {
      // SAFETY: Drizzle binds only SQLite values.
      return new Statement(this.query, values as SQLInputValue[])
    }
    prepared() {
      queries.push(this.query)
      return sqlite.prepare(this.query)
    }
    async run() {
      this.prepared().run(...this.values)
      return { success: true }
    }
    async raw() {
      const statement = this.prepared()
      statement.setReturnArrays(true)
      return statement.all(...this.values)
    }
    objects() {
      const statement = this.prepared()
      return statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), [])
    }
  }
  return {
    queries,
    binding: {
      prepare: (query: string) => new Statement(query),
      async batch(statements: Statement[]) {
        sqlite.exec("BEGIN")
        try {
          const results = statements.map(statement => ({ results: statement.objects() }))
          sqlite.exec("COMMIT")
          return results
        }
        catch (error) {
          sqlite.exec("ROLLBACK")
          throw error
        }
      },
    },
  }
}

const directories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("database locations", () => {
  it("reads bindings, variables, URLs, and files", () => {
    expect(parseDatabaseLocation(undefined)).toEqual({ kind: "auto" })
    expect(parseDatabaseLocation("d1:COMMENTS")).toEqual({ kind: "d1", binding: "COMMENTS" })
    expect(parseDatabaseLocation("env:COMMENTS_DATABASE_URL")).toEqual({ kind: "env", name: "COMMENTS_DATABASE_URL" })
    expect(parseDatabaseLocation("libsql://app.turso.io")).toEqual({ kind: "url", url: "libsql://app.turso.io" })
    expect(parseDatabaseLocation("file:./data/app.sqlite")).toEqual({ kind: "file", path: "./data/app.sqlite" })
  })

  it("rejects what it cannot connect to, and names it", () => {
    expect(() => parseDatabaseLocation("postgres://db.test/app", "comments")).toThrow("The database \"comments\" cannot connect to a Postgres URL.")
    expect(() => parseDatabaseLocation("./app.sqlite")).toThrow(expect.objectContaining({ code: "DATABASE_UNSUPPORTED_URL" }))
  })

  it("finds the token next to the URL variable", () => {
    expect(authTokenVariable("TURSO_DATABASE_URL")).toBe("TURSO_AUTH_TOKEN")
    expect(authTokenVariable("DATABASE_URL")).toBe("DATABASE_AUTH_TOKEN")
    expect(authTokenVariable("COMMENTS_DB")).toBe("COMMENTS_DB_AUTH_TOKEN")
  })

  it.each(["ws://db.test/app", "wss://db.test/app"])("rejects %s before it reaches the HTTP driver", (where) => {
    expect(() => parseDatabaseLocation(where)).toThrow(expect.objectContaining({ code: "DATABASE_UNSUPPORTED_URL" }))
  })
})

describe("connectDatabase", () => {
  it.each(["D1", "libSQL", "Node"])("returns undefined for missing single rows on %s", async (driver) => {
    const d1 = fakeD1()
    // Use libSQL's real result shapes without requiring a remote database.
    const client = createClient({ url: ":memory:" })
    vi.mocked(createHttpClient).mockReturnValue(client)
    const options = { setup, schema: { notes } }
    const db = driver === "Node" ? connectDatabase(":memory:", options) : connectWorker(driver === "D1" ? "d1:NOTES" : "https://db.test", options)
    try {
      await runWithActiveCloudflareEnv({ NOTES: d1.binding }, async () => {
        await db.insert(notes).values({ id: 1, body: "one" })
        expect(await db.select().from(notes).where(eq(notes.id, 2)).get()).toBeUndefined()
        expect(await db.query.notes.findFirst({ where: eq(notes.id, 2) })).toBeUndefined()
        expect(await db.select().from(notes).where(eq(notes.id, 2)).all()).toEqual([])
        expect(await db.select().from(notes).where(eq(notes.id, 1)).get()).toEqual({ id: 1, body: "one" })
        expect(await db.query.notes.findFirst({ where: eq(notes.id, 1) })).toEqual({ id: 1, body: "one" })
        expect(await db.batch([
          db.query.notes.findFirst({ where: eq(notes.id, 2) }),
          db.query.notes.findFirst({ where: eq(notes.id, 1) }),
        ])).toEqual([undefined, { id: 1, body: "one" }])
      })
    }
    finally {
      client.close()
    }
  })

  it("creates the tables before the first query, once, on a D1 binding", async () => {
    const d1 = fakeD1()
    const db = connectWorker("d1:NOTES", { setup, schema: { notes } })
    await runWithActiveCloudflareEnv({ NOTES: d1.binding }, async () => {
      await db.batch([db.insert(notes).values({ id: 1, body: "one" }), db.insert(notes).values({ id: 2, body: "two" })])
      expect(await db.select().from(notes).where(eq(notes.id, 2)).get()).toEqual({ id: 2, body: "two" })
      expect(await db.insert(notes).values({ id: 3, body: "three" }).returning({ id: notes.id })).toEqual([{ id: 3 }])
    })
    expect(d1.queries.filter(query => query.startsWith("CREATE TABLE"))).toHaveLength(1)
  })

  it("keeps rows in a SQLite file on Node", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-connect-"))
    directories.push(directory)
    const where = `file:${join(directory, "nested", "app.sqlite")}`
    await connectDatabase(where, { setup }).insert(notes).values({ id: 1, body: "kept" })
    expect(await connectDatabase(where, { setup }).select().from(notes).all()).toEqual([{ id: 1, body: "kept" }])
  })

  it("finds DATABASE_URL, skips it when it is Postgres, then the D1 binding DB", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://db.test/app")
    vi.stubEnv("TURSO_DATABASE_URL", "")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const d1 = fakeD1()
    const db = connectWorker(undefined, { setup })
    await runWithActiveCloudflareEnv({ DB: d1.binding }, async () => {
      await db.insert(notes).values({ id: 1, body: "auto" })
    })
    expect(d1.queries).toContain("insert into \"notes\" (\"id\", \"body\") values (?, ?)")
    expect(warn).toHaveBeenCalledOnce()
  })

  it("says what it looked for when it finds nothing, and uses the fallback when it has one", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("TURSO_DATABASE_URL", "")
    // Drizzle wraps what the connection throws, and keeps it as the cause.
    await expect(runWithActiveCloudflareEnv({}, async () => await connectWorker("d1:NOTES", { name: "comments" }).select().from(notes))).rejects.toMatchObject({ cause: {
      code: "DATABASE_NOT_CONNECTED",
      why: "The database \"comments\" found no connection. It looked for the Cloudflare D1 binding \"NOTES\".",
    } })
    const db = connectDatabase("env:NOTES_DATABASE_URL", { setup, fallback: ":memory:" })
    await db.insert(notes).values({ id: 1, body: "local" })
    expect(await db.select().from(notes).all()).toEqual([{ id: 1, body: "local" }])
  })

  it("runs the setup again on the next query after it fails", async () => {
    const d1 = fakeD1()
    const db = connectWorker("d1:NOTES", { setup: ["CREATE TABLE broken ("] })
    await runWithActiveCloudflareEnv({ NOTES: d1.binding }, async () => {
      await expect(db.select().from(notes)).rejects.toThrow()
      await expect(db.select().from(notes)).rejects.toThrow()
    })
    expect(d1.queries.filter(query => query.startsWith("CREATE TABLE broken"))).toHaveLength(2)
  })

  it("cannot open a file on Workers", async () => {
    await expect(connectWorker("file:./app.sqlite").select().from(notes)).rejects.toMatchObject({ cause: { code: "DATABASE_UNSUPPORTED_URL" } })
  })
})
