import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearActiveCloudflareEnv, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { pgTable, serial, text } from "drizzle-orm/pg-core"

import { defineDatabase } from "../src/definition.ts"
import { resolveDBViteConfig } from "../src/config.ts"
import { inspectDatabaseDefinitions } from "../src/inspect.ts"
import { mergeCloudflareHyperdriveBindings, resolveCloudflareD1Bindings, resolveCloudflareHyperdriveBindings } from "../src/internal/cloudflare.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"
import { writeHostedDatabaseRuntimeModules } from "../src/internal/vite-build.ts"
import { hubDb } from "../src/vite.ts"
import { createAgentDatabase } from "../src/runtime/agent.ts"

const driver = vi.hoisted(() => ({
  clients: [] as Array<{ end: ReturnType<typeof vi.fn>, options: Record<string, unknown>, url: string }>,
}))

vi.mock("postgres", () => ({
  default: (url: string, options: Record<string, unknown>) => {
    const client = { end: vi.fn(async () => {}), options, url }
    driver.clients.push(client)
    return client
  },
}))

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (config: { client: unknown }) => ({
    $client: config.client,
    select() {
      return this.$client
    },
  }),
}))

const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
})

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-postgres-"))
  tempDirs.push(rootDir)
  return rootDir
}

// Inside the repository, so a Definition can import `@vite-hub/database` and Drizzle when it loads.
async function createLoadableProject() {
  await mkdir(join(import.meta.dirname, "../../../.vitest-tmp"), { recursive: true })
  const rootDir = await mkdtemp(join(import.meta.dirname, "../../../.vitest-tmp/postgres-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writePostgresDefinition(rootDir: string, path: string, lines: string[]) {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { pgTable, text } from 'drizzle-orm/pg-core'",
    "const notes = pgTable('notes', { title: text('title') })",
    "export default defineDatabase({",
    ...lines,
    "  schema: { notes },",
    "})",
    "",
  ].join("\n"))
  return file
}

// The mocked Drizzle database exposes its mocked postgres.js client as `$client`.
function clientOf(db: object) {
  return Reflect.get(db, "$client")
}

async function loadPostgresRuntime() {
  return await import("../src/runtime/postgres.ts")
}

beforeEach(() => {
  driver.clients.length = 0
  clearActiveCloudflareEnv()
})

afterEach(async () => {
  clearActiveCloudflareEnv()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Postgres Database Definitions", () => {
  it("returns a plain Postgres Definition", () => {
    const definition = defineDatabase({
      cloudflare: { hyperdriveId: "hyperdrive-id" },
      connection: { url: "postgres://localhost/app" },
      dialect: "postgresql",
      drizzle: { casing: "snake_case" },
      name: "app",
      schema: { notes },
    })

    expect(definition).toEqual({
      cloudflare: { hyperdriveId: "hyperdrive-id" },
      connection: { url: "postgres://localhost/app" },
      dialect: "postgresql",
      drizzle: { casing: "snake_case" },
      name: "app",
      schema: { notes },
    })
  })

  it("rejects SQLite-only options and unknown dialects", () => {
    // @ts-expect-error D1 HTTP is a SQLite option.
    expect(() => defineDatabase({ cloudflare: { http: true }, dialect: "postgresql", schema: { notes } }))
      .toThrow(expect.objectContaining({ code: "DATABASE_UNKNOWN_OPTION", message: expect.stringContaining("cloudflare.http") }))
    // @ts-expect-error libSQL auth tokens are a SQLite option.
    expect(() => defineDatabase({ connection: { authToken: "token" }, dialect: "postgresql", schema: { notes } }))
      .toThrow(expect.objectContaining({ code: "DATABASE_UNKNOWN_OPTION", message: expect.stringContaining("connection.authToken") }))
    // @ts-expect-error MySQL is not a supported dialect.
    expect(() => defineDatabase({ dialect: "mysql", schema: { notes } }))
      .toThrow(expect.objectContaining({ code: "DATABASE_INVALID_DIALECT" }))
  })
})

describe("Postgres build configuration", () => {
  it("resolves Hyperdrive bindings and connection URLs without SQLite or D1 defaults", async () => {
    const rootDir = await createTempProject()
    await writePostgresDefinition(rootDir, "server/databases/config.ts", [
      "  dialect: 'postgresql',",
      "  cloudflare: { hyperdriveId: process.env.CLOUDFLARE_HYPERDRIVE_ID || 'hyperdrive-id' },",
      "  connection: { url: process.env.DATABASE_URL },",
    ])

    const config = resolveDBViteConfig({
      binding: "CONTENT_DB",
      connection: { url: "libsql://integration.example" },
      databaseId: "d1-id",
      databaseName: "d1-name",
      driver: "d1",
    }, rootDir)!

    expect(config.databases.default).toMatchObject({
      connection: { url: { kind: "env-variable", source: { kind: "env", name: "DATABASE_URL" } } },
      dialect: "postgresql",
      hyperdrive: {
        binding: "HYPERDRIVE",
        hyperdriveId: { default: "hyperdrive-id", kind: "env-variable", source: { kind: "env", name: "CLOUDFLARE_HYPERDRIVE_ID" } },
      },
    })
    expect(config.databases.default?.cloudflare).toBeUndefined()
    expect(config.definitionDefaults.cloudflareProjections.default).toBeUndefined()
    expect(resolveCloudflareD1Bindings(config).d1Databases).toEqual([])
    expect(resolveCloudflareHyperdriveBindings(config)).toEqual([{ binding: "HYPERDRIVE", id: "hyperdrive-id" }])
  })

  it("names Hyperdrive bindings per Named Database and rejects conflicting bindings", async () => {
    const rootDir = await createTempProject()
    await writePostgresDefinition(rootDir, "server/databases/analytics/config.ts", [
      "  name: 'analytics',",
      "  dialect: 'postgresql',",
      "  cloudflare: { hyperdriveId: 'analytics-id' },",
    ])
    await writePostgresDefinition(rootDir, "server/databases/billing/config.ts", [
      "  name: 'billing',",
      "  dialect: \"postgresql\",",
      "  cloudflare: { binding: 'HYPERDRIVE_ANALYTICS', hyperdriveId: 'billing-id' },",
    ])

    const config = resolveDBViteConfig(undefined, rootDir)!
    expect(config.databases.analytics?.hyperdrive?.binding).toBe("HYPERDRIVE_ANALYTICS")
    expect(() => resolveCloudflareHyperdriveBindings(config)).toThrow(expect.objectContaining({ code: "DATABASE_BINDING_CONFLICT" }))
  })

  it("requires a literal dialect", async () => {
    const rootDir = await createTempProject()
    await writePostgresDefinition(rootDir, "server/databases/config.ts", ["  dialect: process.env.DATABASE_DIALECT,"])

    expect(() => resolveDBViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "DATABASE_INVALID_DIALECT" }))
  })

  it("generates a postgresql Drizzle Kit config and a typed registry", async () => {
    const rootDir = await createLoadableProject()
    await writePostgresDefinition(rootDir, "server/databases/config.ts", [
      "  dialect: 'postgresql',",
      "  connection: { url: process.env.DATABASE_URL },",
    ])
    const config = resolveDBViteConfig(undefined, rootDir)!

    await writeGeneratedDatabaseArtifacts(config)

    const drizzleConfig = await readFile(config.generatedDrizzleConfigFile, "utf8")
    expect(drizzleConfig).toContain("dialect: \"postgresql\"")
    expect(drizzleConfig).toContain("url: process.env[\"DATABASE_URL\"]")
    expect(drizzleConfig).toContain("out: \"server/databases/migrations\"")
    await expect(readFile(config.generatedSchemaFilesByDatabase.default!, "utf8")).resolves.toContain("export { table_0 as notes }")
    const types = await readFile(join(rootDir, ".vitehub/types/database.d.ts"), "utf8")
    expect(types).toContain("dialect: \"postgresql\"")
  })

  it("keeps the libSQL runtime out of the Vite databases module of a Postgres-only app", async () => {
    const rootDir = await createLoadableProject()
    await writePostgresDefinition(rootDir, "server/databases/config.ts", ["  dialect: 'postgresql',"])
    const plugin = hubDb()
    // SAFETY: These are Vite hook handlers returned by hubDb.
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root: rootDir })
    // SAFETY: These are Vite hook handlers returned by hubDb.
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    // SAFETY: These are Vite hook handlers returned by hubDb.
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    const code = await load((await resolveId("#vitehub/database/databases"))!)
    expect(code).toContain("runtime/postgres")
    expect(code).not.toContain("runtime/hosted")
  })

  it("rejects a contribution with another dialect in Definition inspection, as the build does", async () => {
    const rootDir = await createTempProject()
    await writePostgresDefinition(rootDir, "server/databases/config.ts", ["  dialect: 'postgresql',"])
    const plugins = [{ name: "history-owner/vite", vitehub: { databases: [{ definition: { module: "history-tables/schema" }, dialect: "sqlite", name: "history" }] } }]

    await expect(inspectDatabaseDefinitions({ plugins, projectRoot: rootDir, rootDir })).rejects.toMatchObject({
      code: "DATABASE_INVALID_CONTRIBUTION_TARGET",
      message: expect.stringContaining("use the \"sqlite\" dialect, but the Database \"default\" uses \"postgresql\""),
    })
  })

  it("lists the Postgres dialect in Definition inspection", async () => {
    const rootDir = await createTempProject()
    await writePostgresDefinition(rootDir, "server/databases/config.ts", ["  dialect: 'postgresql',"])

    expect((await inspectDatabaseDefinitions({ projectRoot: rootDir, rootDir }))[0]?.fields).toEqual([
      { label: "Mode", value: "Default" },
      { label: "Dialect", value: "PostgreSQL" },
      { label: "Tables", value: "notes" },
    ])
  })

  it("writes hosted runtime modules that create Postgres clients without the SQLite runtime", async () => {
    const rootDir = await createTempProject()
    await writePostgresDefinition(rootDir, "server/databases/config.ts", [
      "  dialect: 'postgresql',",
      "  cloudflare: { hyperdriveId: 'hyperdrive-id' },",
      "  connection: { url: process.env.DATABASE_URL },",
    ])
    const config = resolveDBViteConfig(undefined, rootDir)!
    const output = join(rootDir, ".vitehub/database")

    await writeHostedDatabaseRuntimeModules(output, config)

    for (const provider of ["cloudflare", "vercel"]) {
      const code = await readFile(join(output, `${provider}-runtime.mjs`), "utf8")
      expect(code).toContain("import { createPostgresDatabase } from")
      expect(code).toContain("runtime/postgres")
      expect(code).toContain("db: createPostgresDatabase(definition_0, {\"binding\":\"HYPERDRIVE\",\"url\":{\"kind\":\"env-variable\"")
      expect(code).not.toContain("createHostedDrizzleDb")
    }
  })

  it("replaces generated Hyperdrive bindings in Wrangler config and keeps other bindings", () => {
    expect(mergeCloudflareHyperdriveBindings([
      { binding: "HYPERDRIVE", id: "stale-id" },
      { binding: "OTHER", id: "other-id" },
    ], [{ binding: "HYPERDRIVE", id: "hyperdrive-id" }])).toEqual([
      { binding: "OTHER", id: "other-id" },
      { binding: "HYPERDRIVE", id: "hyperdrive-id" },
    ])
  })
})

describe("Postgres runtime", () => {
  const definition = {
    dialect: "postgresql" as const,
    drizzle: {},
    name: "default",
    schema: { notes },
  }

  it("creates one client per Cloudflare request from the Hyperdrive binding", async () => {
    const { createPostgresDatabase } = await loadPostgresRuntime()
    const db = createPostgresDatabase(definition, { binding: "HYPERDRIVE", url: "postgres://fallback/app" })
    const env = { HYPERDRIVE: { connectionString: "postgres://hyperdrive/app" } }

    const first = await runWithActiveCloudflareEnv(env, async () => {
      const client = clientOf(db)
      await Promise.resolve()
      expect(clientOf(db)).toBe(client)
      return client
    })
    const second = runWithActiveCloudflareEnv(env, () => clientOf(db))

    expect(first).not.toBe(second)
    expect(driver.clients).toHaveLength(2)
    expect(driver.clients[0]).toMatchObject({ options: { max: 5 }, url: "postgres://hyperdrive/app" })
    // Array columns need the type metadata that postgres.js discovers.
    expect(driver.clients[0]!.options).not.toHaveProperty("fetch_types")
    expect(driver.clients[0]!.end).not.toHaveBeenCalled()
  })

  it("keys requests by the installed env when the host cannot wrap the request", async () => {
    const { createPostgresDatabase } = await loadPostgresRuntime()
    const db = createPostgresDatabase(definition, { binding: "HYPERDRIVE" })
    const binding = { connectionString: "postgres://hyperdrive/app" }

    setActiveCloudflareEnv({ HYPERDRIVE: binding })
    const first = clientOf(db)
    expect(clientOf(db)).toBe(first)
    setActiveCloudflareEnv({ HYPERDRIVE: binding })

    expect(clientOf(db)).not.toBe(first)
  })

  it("shares one pool outside Cloudflare and replaces it when the URL changes", async () => {
    clearActiveCloudflareEnv()
    const { createPostgresDatabase } = await loadPostgresRuntime()
    vi.stubEnv("VITEHUB_TEST_DATABASE_URL", "postgres://first/app")
    try {
      const db = createPostgresDatabase({ ...definition, cloudflare: { binding: "APP_HYPERDRIVE" } }, {
        binding: "HYPERDRIVE",
        url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_DATABASE_URL" } },
      })

      expect(clientOf(db)).toBe(clientOf(db))
      expect(driver.clients).toEqual([expect.objectContaining({ options: {}, url: "postgres://first/app" })])

      vi.stubEnv("VITEHUB_TEST_DATABASE_URL", "postgres://second/app")
      expect(clientOf(db)).toMatchObject({ url: "postgres://second/app" })
      expect(driver.clients[0]!.end).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("prefers the Definition binding and URL over generated defaults", async () => {
    clearActiveCloudflareEnv()
    const { createPostgresDatabase } = await loadPostgresRuntime()
    const db = createPostgresDatabase({
      ...definition,
      cloudflare: { binding: "APP_HYPERDRIVE" },
      connection: { url: "postgres://definition/app" },
    }, { binding: "HYPERDRIVE", url: "postgres://generated/app" })

    expect(clientOf(db)).toMatchObject({ url: "postgres://definition/app" })
    runWithActiveCloudflareEnv({ APP_HYPERDRIVE: { connectionString: "postgres://hyperdrive/app" }, HYPERDRIVE: { connectionString: "postgres://other/app" } }, () => {
      expect(clientOf(db)).toMatchObject({ url: "postgres://hyperdrive/app" })
    })
  })

  it("requires a Hyperdrive binding or connection URL", async () => {
    clearActiveCloudflareEnv()
    const { createPostgresDatabase } = await loadPostgresRuntime()
    const db = createPostgresDatabase({ ...definition, name: "analytics" }, { binding: "HYPERDRIVE_ANALYTICS" })

    expect(() => db.select).toThrow(expect.objectContaining({
      code: "DATABASE_MISSING_CONNECTION",
      message: "The database \"analytics\" has no connection. It needs the Cloudflare Hyperdrive binding \"HYPERDRIVE_ANALYTICS\" or `connection.url`.",
    }))
  })

  it("runs Agent statements through execute()", async () => {
    const execute = vi.fn(async () => [{ ok: true }])
    const agentDb = createAgentDatabase({ default: { db: { execute } } })

    await expect(agentDb.query("select 1")).resolves.toEqual([{ ok: true }])
    await agentDb.exec("delete from notes")
    await agentDb.schema()

    expect(execute).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(execute.mock.calls[2])).toContain("information_schema.columns")
  })
})
