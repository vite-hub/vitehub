import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { eq, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { getActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { build } from "esbuild"

import { createDbCloudflareWorker } from "../src/runtime/cloudflare-vite.ts"

const defaultSchema = {
  notes: sqliteTable("notes", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
  }),
}

const analyticsSchema = {
  analyticsEvents: sqliteTable("analytics_events", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  }),
}

const runtimeState = {
  analyticsDbPath: "",
  dbPath: "",
}

const execFileAsync = promisify(execFile)

function createFakeD1Binding() {
  return {
    batch: async () => [],
    prepare() {
      return {
        bind() {
          return {
            all: async () => ({ results: [] }),
            raw: async () => [],
            run: async () => ({}),
          }
        },
      }
    },
  }
}

async function createHostedAnalyticsDb(http: true | { authToken: string, url: string } = true) {
  const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")
  const db = createHostedDrizzleDb({
    cloudflare: {
      binding: "DB_ANALYTICS",
      databaseId: "analytics-d1-id",
      http,
      migrationsDir: "server/databases/analytics/migrations",
    },
    dialect: "sqlite",
    drizzle: {},
    generatedSchemaFile: ".vitehub/database/schema/analytics.ts",
    migrationsDir: "server/databases/analytics/migrations",
    mode: "named",
    name: "analytics",
    orm: "drizzle",
  }, analyticsSchema)
  return { db }
}

function createD1Response(...rows: unknown[][][]) {
  return new Response(JSON.stringify({
    result: rows.map(resultRows => ({ results: { rows: resultRows }, success: true })),
    success: true,
  }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  })
}

;(vi.mock as any)("#vitehub/database/schema", () => ({
  ...defaultSchema,
  default: defaultSchema,
}), { virtual: true })

function createRuntimeDatabaseEntries() {
  return {
    analytics: {
      config: {
        cloudflare: {
          binding: "DB_ANALYTICS",
        },
        connection: {
          get url() {
            return runtimeState.analyticsDbPath || undefined
          },
        },
        dialect: "sqlite",
        drizzle: {},
        generatedSchemaFile: ".vitehub/database/schema/analytics.ts",
        migrationsDir: "src/database/analytics/migrations",
        mode: "named",
        name: "analytics",
        orm: "drizzle",
      },
      schema: analyticsSchema,
    },
    default: {
      config: {
        connection: {
          get url() {
            return runtimeState.dbPath
          },
        },
        dialect: "sqlite",
        drizzle: {},
        generatedSchemaFile: ".vitehub/database/schema/default.ts",
        migrationsDir: "src/database/migrations",
        mode: "default",
        name: "default",
        orm: "drizzle",
      },
      schema: defaultSchema,
    },
  }
}

let runtimeDatabaseEntriesFactory: () => Record<string, unknown> = createRuntimeDatabaseEntries

beforeEach(() => {
  runtimeDatabaseEntriesFactory = createRuntimeDatabaseEntries
  ;(vi.doMock as any)("#vitehub/database/databases", () => ({
    default: runtimeDatabaseEntriesFactory(),
  }), { virtual: true })
})

let tempDir = ""

afterEach(async () => {
  runtimeState.analyticsDbPath = ""
  runtimeState.dbPath = ""
  setActiveCloudflareEnv(undefined)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true })
    tempDir = ""
  }
})

describe("cloudflare worker runtime", () => {
  it("isolates overlapping request environments", async () => {
    let arrivals = 0
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => {
      release = resolve
    })
    const worker = createDbCloudflareWorker({
      app: async () => {
        const before = getActiveCloudflareEnv()?.REQUEST_ID
        arrivals += 1
        if (arrivals === 2) release()
        await bothStarted
        return Response.json({ after: getActiveCloudflareEnv()?.REQUEST_ID, before })
      },
    })

    const [first, second] = await Promise.all([
      worker.fetch(new Request("https://example.com/first"), { REQUEST_ID: "first" }, { waitUntil: vi.fn() }),
      worker.fetch(new Request("https://example.com/second"), { REQUEST_ID: "second" }, { waitUntil: vi.fn() }),
    ])

    await expect(first.json()).resolves.toEqual({ after: "first", before: "first" })
    await expect(second.json()).resolves.toEqual({ after: "second", before: "second" })
  })
})

describe("drizzle runtime", () => {
  it("loads the published drizzle subpath without a Vite virtual module", async () => {
    const script = [
      'const { databases, db, schema } = await import("@vite-hub/database/drizzle")',
      'if (JSON.stringify(schema) !== "{}") throw new Error("expected empty schema fallback")',
      'if (JSON.stringify(databases.default.schema) !== "{}") throw new Error("expected empty default database schema")',
      'try {',
      "  db.run",
      '}',
      'catch (error) {',
      '  if (String(error.message).includes("requires `hubDb()`")) process.exit(0)',
      "  throw error",
      '}',
      'throw new Error("expected missing database proxy to throw")',
    ].join("\n")

    await expect(execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd() })).resolves.toBeDefined()
  })

  it("provides a default fallback entry when the virtual database registry is empty", async () => {
    runtimeDatabaseEntriesFactory = () => ({})
    vi.resetModules()

    const { databases, db } = await import("../src/runtime/drizzle-runtime.ts")

    expect(db).toBe(databases.default.db)
    expect(databases.default.schema).toEqual({})
    expect(() => databases.default.db.run).toThrow("[vitehub] `@vite-hub/database/drizzle` requires `hubDb()` and `database !== false`.")
  })

  it("keeps db as the default database alias and serves named schemas independently", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vitehub-db-runtime-"))
    runtimeState.dbPath = `file:${join(tempDir, "db.sqlite")}`
    runtimeState.analyticsDbPath = `file:${join(tempDir, "analytics.sqlite")}`

    const { databases, db } = await import("../src/drizzle.ts")

    expect(db).toBe(databases.default.db)

    await databases.default.db.run(sql`
      create table if not exists notes (
        id integer primary key autoincrement,
        title text not null
      )
    `)
    await databases.analytics.db.run(sql`
      create table if not exists analytics_events (
        id integer primary key autoincrement,
        name text not null
      )
    `)

    await databases.default.db.insert(defaultSchema.notes).values({ title: "runtime note" })
    await databases.analytics.db.insert(analyticsSchema.analyticsEvents).values({ name: "page-view" })

    expect(await databases.default.db.select().from(defaultSchema.notes)).toEqual([{ id: 1, title: "runtime note" }])
    expect(await databases.analytics.db.select().from(analyticsSchema.analyticsEvents)).toEqual([{ id: 1, name: "page-view" }])
  })

  it("prefers an active Cloudflare D1 binding over the configured fallback URL", async () => {
    runtimeState.analyticsDbPath = "file:.data/analytics.sqlite"
    const binding = createFakeD1Binding()
    setActiveCloudflareEnv({ DB_ANALYTICS: binding })

    const { databases } = await import("../src/runtime/drizzle-runtime.ts")

    expect((databases.analytics.db as { $client?: unknown }).$client).toBe(binding)
  })

  it("throws when a named database has neither an active binding nor a fallback URL", async () => {
    const { databases } = await import("../src/runtime/drizzle-runtime.ts")

    expect(() => databases.analytics.db.run).toThrow("Database \"analytics\" requires a Cloudflare D1 binding or `db.connection.url`.")
  })
})

describe("database definition runtime", () => {
  it("returns a local database from defineDatabase", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vitehub-db-definition-"))
    const { defineDatabase } = await import("../src/definition.ts")
    const database = defineDatabase({
      connection: { url: `file:${join(tempDir, "definition.sqlite")}` },
      schema: defaultSchema,
    })

    await database.run(sql`
      create table notes (
        id integer primary key autoincrement,
        title text not null
      )
    `)
    await database.insert(defaultSchema.notes).values({ title: "definition note" })

    expect(database.name).toBe("default")
    expect(database.schema).toBe(defaultSchema)
    expect(await database.select().from(defaultSchema.notes)).toEqual([{ id: 1, title: "definition note" }])
  })

  it("uses the definition's active Cloudflare binding in hosted mode", async () => {
    const binding = createFakeD1Binding()
    setActiveCloudflareEnv({ DB_ANALYTICS: binding })

    const { createDefinitionRuntime } = await import("../src/runtime/definition-hosted.ts")
    const database = createDefinitionRuntime({
      cloudflare: { binding: "DB_ANALYTICS" },
      dialect: "sqlite",
      drizzle: {},
      name: "analytics",
      schema: analyticsSchema,
    })

    expect((database as { $client?: unknown }).$client).toBe(binding)
  })

  it("bundles the hosted definition runtime without Node filesystem imports", async () => {
    const result = await build({
      bundle: true,
      conditions: ["vitehub-hosted", "workerd", "worker", "browser", "default"],
      external: ["node:async_hooks"],
      format: "esm",
      platform: "neutral",
      stdin: {
        contents: 'import { defineDatabase } from "@vite-hub/database"; export const database = defineDatabase({ schema: {} })',
        resolveDir: import.meta.dirname,
        sourcefile: "hosted-database-definition.ts",
      },
      write: false,
    })
    const output = result.outputFiles[0]!.text

    expect(output).toContain("Hosted database")
    expect(output).not.toContain("node:fs")
    expect(output).not.toContain("node:path")
  })
})

describe("hosted drizzle runtime", () => {
  it("defers hosted URL validation until the database is used", async () => {
    const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")

    const db = createHostedDrizzleDb({
      connection: {
        url: "file:.data/database.sqlite",
      },
      dialect: "sqlite",
      drizzle: {},
      generatedSchemaFile: ".vitehub/database/schema/default.ts",
      migrationsDir: "src/database/migrations",
      mode: "default",
      name: "default",
      orm: "drizzle",
    }, defaultSchema)

    expect(() => db.run).toThrow("Hosted DB \"default\" requires an active Cloudflare D1 binding, cloudflare.http with databaseId, or a remote libSQL URL")
  })

  it("rejects non-libsql remote schemes in hosted mode", async () => {
    const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")

    const db = createHostedDrizzleDb({
      connection: {
        url: "postgres://database.example.com/app",
      },
      dialect: "sqlite",
      drizzle: {},
      generatedSchemaFile: ".vitehub/database/schema/default.ts",
      migrationsDir: "src/database/migrations",
      mode: "default",
      name: "default",
      orm: "drizzle",
    }, defaultSchema)

    expect(() => db.run).toThrow("Hosted DB \"default\" requires an active Cloudflare D1 binding, cloudflare.http with databaseId, or a remote libSQL URL")
  })

  it("uses the active Cloudflare binding when hosted outputs run on Cloudflare", async () => {
    const binding = createFakeD1Binding()
    setActiveCloudflareEnv({ DB_ANALYTICS: binding })

    const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")
    const db = createHostedDrizzleDb({
      cloudflare: {
        binding: "DB_ANALYTICS",
        databaseId: "analytics-d1-id",
        http: true,
        migrationsDir: "src/database/analytics/migrations",
      },
      dialect: "sqlite",
      drizzle: {},
      generatedSchemaFile: ".vitehub/database/schema/analytics.ts",
      migrationsDir: "src/database/analytics/migrations",
      mode: "named",
      name: "analytics",
      orm: "drizzle",
    }, analyticsSchema)

    expect((db as { $client?: unknown }).$client).toBe(binding)
  })

  it("queries configured Cloudflare D1 over authenticated HTTP", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "api-token")
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => createD1Response([[1, "page-view"]]))
    vi.stubGlobal("fetch", fetchMock)

    const { db } = await createHostedAnalyticsDb()
    await expect(db.select().from(analyticsSchema.analyticsEvents)).resolves.toEqual([{ id: 1, name: "page-view" }])
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/analytics-d1-id/raw")
    expect(request).toMatchObject({
      headers: {
        Authorization: "Bearer api-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    })
    expect(JSON.parse(String(request?.body))).toMatchObject({ params: [], sql: expect.stringContaining("analytics_events") })
  })

  it("maps all, get, and run results through the D1 raw transport", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "api-token")
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createD1Response([[1, "page-view"]]))
      .mockResolvedValueOnce(createD1Response([[2, "download"]]))
      .mockResolvedValueOnce(createD1Response([]))
    vi.stubGlobal("fetch", fetchMock)

    const { db } = await createHostedAnalyticsDb()
    await expect(db.select().from(analyticsSchema.analyticsEvents)).resolves.toEqual([{ id: 1, name: "page-view" }])
    await expect(db.select().from(analyticsSchema.analyticsEvents).where(eq(analyticsSchema.analyticsEvents.id, 2)).get()).resolves.toEqual({ id: 2, name: "download" })
    await expect(db.insert(analyticsSchema.analyticsEvents).values({ name: "signup" }).run()).resolves.toEqual({ rows: [] })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("uses an explicitly configured authenticated D1 proxy", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cloudflare-token-must-not-be-used")
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => createD1Response([[1, "page-view"]]))
    vi.stubGlobal("fetch", fetchMock)

    const { db } = await createHostedAnalyticsDb({
      authToken: "proxy-token",
      url: "https://d1.example.com/raw",
    })
    await db.select().from(analyticsSchema.analyticsEvents)

    const [url, request] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://d1.example.com/raw")
    expect(request?.headers).toMatchObject({ Authorization: "Bearer proxy-token" })
    expect(JSON.stringify(request)).not.toContain("cloudflare-token-must-not-be-used")
  })

  it("preserves a configured libSQL fallback when D1 HTTP is not selected", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { createHostedDrizzleDb } = await import("../src/runtime/hosted.ts")
    const db = createHostedDrizzleDb({
      cloudflare: {
        binding: "DB_ANALYTICS",
        databaseId: "analytics-d1-id",
        migrationsDir: "server/databases/analytics/migrations",
      },
      connection: { url: "libsql://analytics.example.turso.io" },
      dialect: "sqlite",
      drizzle: {},
      generatedSchemaFile: ".vitehub/database/schema/analytics.ts",
      migrationsDir: "server/databases/analytics/migrations",
      mode: "named",
      name: "analytics",
      orm: "drizzle",
    }, analyticsSchema)

    expect((db as { $client?: unknown }).$client).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends Drizzle batches through one Cloudflare D1 request", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "api-token")
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => createD1Response([[1, "first"]], [[2, "second"]]))
    vi.stubGlobal("fetch", fetchMock)

    const { db } = await createHostedAnalyticsDb()
    const batchDb = db as unknown as { batch: (queries: unknown[]) => Promise<unknown[]> }
    await expect(batchDb.batch([
      db.select().from(analyticsSchema.analyticsEvents).where(eq(analyticsSchema.analyticsEvents.id, 1)),
      db.select().from(analyticsSchema.analyticsEvents).where(eq(analyticsSchema.analyticsEvents.id, 2)),
    ])).resolves.toEqual([
      [{ id: 1, name: "first" }],
      [{ id: 2, name: "second" }],
    ])
    const [, request] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(request?.body))).toMatchObject({
      batch: [
        { params: [1], sql: expect.stringContaining("analytics_events") },
        { params: [2], sql: expect.stringContaining("analytics_events") },
      ],
    })
  })

  it("requires Cloudflare API credentials before D1 HTTP access", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "")
    const { db } = await createHostedAnalyticsDb()
    expect(() => db.run).toThrow("Hosted Cloudflare D1 database \"analytics\" requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN when cloudflare.http is true.")
  })

  it("requires both configured proxy values without falling back to Cloudflare credentials", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cloudflare-token")
    const { db } = await createHostedAnalyticsDb({ authToken: "", url: "https://d1.example.com/raw" })
    expect(() => db.run).toThrow("requires cloudflare.http.url and cloudflare.http.authToken at runtime")
  })

  it("rejects malformed and failed D1 responses without exposing credentials", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "secret-api-token")
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("not json", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ message: "permission denied" }],
        success: false,
      }), { headers: { "Content-Type": "application/json" }, status: 403 }))
    vi.stubGlobal("fetch", fetchMock)

    const { db } = await createHostedAnalyticsDb()
    const malformedError = await db.select().from(analyticsSchema.analyticsEvents).then(() => undefined, error => error)
    const deniedError = await db.select().from(analyticsSchema.analyticsEvents).then(() => undefined, error => error)
    expect(malformedError).toMatchObject({
      cause: { message: "[vitehub] Cloudflare D1 request failed (502)." },
    })
    expect(deniedError).toMatchObject({
      cause: { message: "[vitehub] Cloudflare D1 request failed (403): permission denied" },
    })
    expect(JSON.stringify([malformedError, deniedError])).not.toContain("secret-api-token")
  })

  it("rejects per-query errors and mismatched D1 batch results", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "api-token")
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [
          { results: { rows: [[1, "first"]] }, success: true },
          { errors: [{ message: "second query failed" }], success: false },
        ],
        success: true,
      }), { headers: { "Content-Type": "application/json" }, status: 200 }))
      .mockResolvedValueOnce(createD1Response([[1, "only-result"]]))
    vi.stubGlobal("fetch", fetchMock)

    const { db } = await createHostedAnalyticsDb()
    const batch = () => (db as unknown as { batch: (queries: unknown[]) => Promise<unknown[]> }).batch([
      db.select().from(analyticsSchema.analyticsEvents).where(eq(analyticsSchema.analyticsEvents.id, 1)),
      db.select().from(analyticsSchema.analyticsEvents).where(eq(analyticsSchema.analyticsEvents.id, 2)),
    ])
    await expect(batch()).rejects.toThrow("Cloudflare D1 query 2 failed (200): second query failed")
    await expect(batch()).rejects.toThrow("Cloudflare D1 returned an unexpected query result count")
  })
})
