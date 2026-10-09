import { createServer as createHttpServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"
import { createServer as createViteServer, type ViteDevServer } from "vite"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import {
  DB_VIRTUAL_DATABASES_ID,
  DB_VIRTUAL_SCHEMA_ID,
  hubDb,
} from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-vite-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, path: string, table = "notes", options: { cloudflare?: string, connection?: string } = {}) {
  const file = join(rootDir, path)
  const name = /(?:^|\/)src\/([^/]+)\.database\./.exec(path)?.[1]
    ?? /(?:^|\/)server\/databases\/([^/]+)\/config\./.exec(path)?.[1]
    ?? "default"
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${table} = sqliteTable('${table}', { title: text('title') })`,
    "export default defineDatabase({",
    `  name: ${JSON.stringify(name)},`,
    ...(options.cloudflare ? ["  cloudflare: {", options.cloudflare, "  },"] : []),
    ...(options.connection ? ["  connection: {", options.connection, "  },"] : []),
    `  schema: { ${table} },`,
    "})",
    "",
  ].join("\n"))
  return file
}

async function resolveCliContributor(plugin: ReturnType<typeof hubDb>) {
  const cli = plugin.vitehub?.cli
  return cli instanceof Function ? await cli() : cli
}

function resolveConfigResolved(plugin: ReturnType<typeof hubDb>): (config: unknown) => Promise<void> {
  // SAFETY: hubDb returns a Vite plugin whose configResolved property is the hook handler used by these tests.
  return plugin.configResolved as (config: unknown) => Promise<void>
}

interface TestHotUpdateContext {
  file: string
  server: ViteDevServer | {
    moduleGraph: {
      getModuleById: (id: string) => { id: string } | undefined
      invalidateModule: (module: { id: string }) => void
    }
  }
}

function resolveHotUpdate(plugin: ReturnType<typeof hubDb>): (context: TestHotUpdateContext) => Promise<void> {
  const hook = plugin.handleHotUpdate
  if (!(hook instanceof Function)) throw new Error("Expected a handleHotUpdate hook handler.")
  return async context => await Reflect.apply(hook, undefined, [context])
}

function isAddressInfo(address: string | AddressInfo): address is AddressInfo {
  return Object.prototype.toString.call(address) === "[object Object]"
}

async function listenHttpServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || !isAddressInfo(address)) throw new Error("Expected TCP server address.")
  return `http://127.0.0.1:${address.port}`
}

async function closeHttpServer(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubDb", () => {
  it("inspects Database provider artifacts under the writer's nested Vite root", async () => {
    const root = await createTempProject()
    const appRoot = join(root, "app")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    await writeDefinition(appRoot, "src/report.database.ts", "report", { connection: "url: 'libsql://database.example'," })
    await symlink(join(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    const plugin = hubDb()
    await resolveConfigResolved(plugin)({ root: appRoot, command: "build", build: { outDir: "dist" }, resolve: { alias: [] }, plugins: [] })
    for (const hook of [plugin.buildStart, plugin.buildEnd, plugin.closeBundle]) {
      if (hook instanceof Function) await Reflect.apply(hook, {}, [])
      else if (hook && hook.handler instanceof Function) await Reflect.apply(hook.handler, {}, [])
    }
    const entries = plugin.vitehub?.inspect?.()?.providerOutput ?? []
    expect(entries.map(entry => entry.path)).toEqual([
      join(appRoot, "dist/app/index.js"), join(appRoot, ".vercel/output/functions/__server.func/index.mjs"),
    ])
    for (const entry of entries) await expect(readFile(entry.path, "utf8")).resolves.toBeTruthy()
  })

  it("does not inspect provider output without enabled Database Definitions", async () => {
    const rootDir = await createTempProject()
    const plugin = hubDb()
    await resolveConfigResolved(plugin)({ root: rootDir })
    expect(plugin.vitehub?.inspect?.()?.providerOutput).toEqual([])

    await writeDefinition(rootDir, "server/databases/config.ts")
    await resolveConfigResolved(plugin)({ database: false, root: rootDir })
    expect(plugin.vitehub?.inspect?.()).toBeUndefined()
  })

  it.each([
    { name: "local SQLite", connection: "url: 'file:local.db',", cloudflare: undefined, providers: [] },
    { name: "remote libSQL", connection: "url: 'libsql://database.example',", cloudflare: undefined, providers: ["cloudflare", "vercel"] },
    { name: "D1 binding", connection: undefined, cloudflare: "databaseId: 'database-id', databaseName: 'database-name',", providers: ["cloudflare"] },
    { name: "D1 HTTP", connection: undefined, cloudflare: "databaseId: 'database-id', databaseName: 'database-name', http: true,", providers: ["cloudflare", "vercel"] },
    { name: "D1 HTTP without a database name", connection: undefined, cloudflare: "databaseId: 'database-id', http: true,", providers: ["vercel"] },
  ])("inspects supported provider output for $name", async ({ connection, cloudflare, providers }) => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", { connection, cloudflare })
    const plugin = hubDb()
    await resolveConfigResolved(plugin)({ root: rootDir })
    expect(plugin.vitehub?.inspect?.()?.providerOutput?.map(output => output.description)).toEqual(
      providers.map(provider => provider === "cloudflare" ? "Generated Cloudflare Database worker" : "Generated Vercel Database function"),
    )
  })

  it("requires every Database Definition to support a provider", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/remote/config.ts", "notes", { connection: "url: 'libsql://database.example'," })
    await writeDefinition(rootDir, "server/databases/local/config.ts", "tasks", { connection: "url: 'file:local.db'," })
    const plugin = hubDb()
    await resolveConfigResolved(plugin)({ root: rootDir })
    expect(plugin.vitehub?.inspect?.()?.providerOutput).toEqual([])
  })

  it("reads provisioned D1 IDs when inspecting provider output", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", { cloudflare: "databaseName: 'database-name'," })
    const plugin = hubDb()
    await resolveConfigResolved(plugin)({ root: rootDir })
    expect(plugin.vitehub?.inspect?.()?.providerOutput).toEqual([])

    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "provisioned-database-id" } } }))
    expect(plugin.vitehub?.inspect?.()?.providerOutput?.map(output => output.description)).toEqual(["Generated Cloudflare Database worker"])
  })

  it("merges discovered D1 bindings and migrations into Cloudflare Nitro output", async () => {
    const rootDir = await createTempProject()
    const serverDir = join(rootDir, ".output", "server")
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", { cloudflare: "binding: 'DB', databaseName: 'app', databaseId: 'database-id'," })
    await mkdir(join(rootDir, "server/databases/migrations"), { recursive: true })
    await writeFile(join(rootDir, "server/databases/migrations/0001_init.sql"), "create table notes (title text);\n")
    const compiledHooks: Array<() => Promise<void>> = []
    const createNitro = (preset: string) => {
      const options: { cloudflare?: { wrangler?: { d1_databases?: unknown } }, output: { serverDir: string }, preset: string } = { output: { serverDir }, preset }
      return { hooks: { hook: (_name: "compiled", callback: () => Promise<void>) => void compiledHooks.push(callback) }, options }
    }
    const cloudflareNitro = createNitro("cloudflare-module")
    cloudflareNitro.options.cloudflare = {
      wrangler: {
        d1_databases: [
          { binding: "DB", database_id: "stale-id", database_name: "app" },
          { binding: "LEGACY", database_id: "legacy-id", database_name: "legacy" },
        ],
      },
    }
    const vercelNitro = createNitro("vercel")
    const cloudflarePlugin = hubDb()
    const vercelPlugin = hubDb()
    cloudflarePlugin.nitro.setup(cloudflareNitro)
    vercelPlugin.nitro.setup(vercelNitro)

    await resolveConfigResolved(cloudflarePlugin)({ root: rootDir })
    await resolveConfigResolved(vercelPlugin)({ root: rootDir })
    await Promise.all(compiledHooks.map(hook => hook()))

    expect(cloudflareNitro.options.cloudflare.wrangler?.d1_databases).toEqual([
      { binding: "DB", database_id: "database-id", database_name: "app", migrations_dir: ".vitehub/database/migrations/DB" },
      { binding: "LEGACY", database_id: "legacy-id", database_name: "legacy" },
    ])
    await expect(readFile(join(serverDir, ".vitehub/database/migrations/DB/0001_init.sql"), "utf8")).resolves.toBe("create table notes (title text);\n")
    expect(vercelNitro.options.cloudflare).toBeUndefined()
  })

  it("serializes shared Provider Output finalization", () => {
    expect(hubDb().closeBundle).toMatchObject({ order: "post", sequential: true })
  })

  it("routes Vite development queries through configured Cloudflare D1 HTTP", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    let proxyRequest: { authorization?: string, body?: unknown, method?: string, path?: string } = {}
    const proxy = createHttpServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      proxyRequest = {
        authorization: request.headers.authorization,
        body: JSON.parse(body),
        method: request.method,
        path: request.url,
      }
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({
        result: [{ results: { rows: [["remote note"]] }, success: true }],
        success: true,
      }))
    })
    const proxyUrl = await listenHttpServer(proxy)

    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      cloudflare: [
        "    databaseId: 'dev-database-id',",
        "    http: {",
        "      authToken: 'dev-proxy-token',",
        `      url: ${JSON.stringify(`${proxyUrl}/raw`)},`,
        "    },",
      ].join("\n"),
    })
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "query.ts"), [
      "import { useDatabase } from '@vite-hub/database/drizzle'",
      "export const query = () => {",
      "  const { db, schema } = useDatabase('default')",
      "  return db.select().from(schema.notes)",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "index.html"), "<div>ViteHub Database</div>")

    const server = await createViteServer({
      configFile: false,
      plugins: [hubDb()],
      root: rootDir,
      server: { host: "127.0.0.1", port: 0 },
    })

    try {
      await server.listen()
      // SAFETY: This fixture writes the queried module immediately before Vite loads it.
      const module = await server.ssrLoadModule(join(rootDir, "server", "query.ts")) as {
        query: () => Promise<Array<{ title: string }>>
      }

      await expect(module.query()).resolves.toEqual([{ title: "remote note" }])
      expect(proxyRequest).toMatchObject({
        authorization: "Bearer dev-proxy-token",
        body: { params: [], sql: expect.stringContaining("notes") },
        method: "POST",
        path: "/raw",
      })
    }
    finally {
      await Promise.all([server.close(), closeHttpServer(proxy)])
    }
  }, 30_000)

  it("refreshes direct Definition resource projections during Vite development hot updates", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    const requests: string[] = []
    const proxy = createHttpServer((request, response) => {
      requests.push(request.url!)
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ success: true, result: [{ success: true, results: { rows: [["application note"]] } }] }))
    })
    const proxyUrl = await listenHttpServer(proxy)
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")
    const queryFile = join(rootDir, "server/query.ts")
    await writeFile(queryFile, [
      "import definition from './databases/config.ts'",
      "import { useDatabase } from '@vite-hub/database/drizzle'",
      "import { runWithActiveCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'",
      "export const query = (binding: unknown) => runWithActiveCloudflareEnv({ HOST_DB: binding }, async () => {",
      "  const { db, schema } = useDatabase('default')",
      "  return { definition: await definition.select().from(definition.schema.notes), registry: await db.select().from(schema.notes) }",
      "})",
      "",
    ].join("\n"))
    const nativeQueries: string[] = []
    const binding = {
      prepare(query: string) {
        nativeQueries.push(query)
        return { bind: () => ({ raw: async () => [["host note"]] }) }
      },
    }
    const plugin = hubDb({ binding: "HOST_DB", databaseId: "host-id", databaseName: "host-db", driver: "d1" })
    const server = await createViteServer({ configFile: false, plugins: [plugin], root: rootDir, server: { host: "127.0.0.1", port: 0, watch: null } })
    try {
      await server.listen()
      async function query() {
        // SAFETY: This fixture writes the module before Vite evaluates its public Database imports.
        const module = await server.ssrLoadModule(queryFile) as {
          query: (nativeBinding: typeof binding) => Promise<{ definition: Array<{ title: string }>, registry: Array<{ title: string }> }>
        }
        return module.query(binding)
      }
      await expect(query()).resolves.toEqual({ definition: [{ title: "host note" }], registry: [{ title: "host note" }] })
      expect(nativeQueries).toHaveLength(2)
      nativeQueries.length = 0

      await writeFile(definition, [
        "import { defineDatabase } from '@vite-hub/database'",
        "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
        "const notes = sqliteTable('notes', { title: text('title') })",
        `const cloudflare = { binding: 'HOST_DB', databaseId: 'application-id', databaseName: 'application-db', http: { authToken: 'application-token', url: ${JSON.stringify(`${proxyUrl}/application/raw`)} } }`,
        "export default defineDatabase({ cloudflare, schema: { notes } })",
        "",
      ].join("\n"))
      const changedModule = server.moduleGraph.getModuleById(definition)
      if (!changedModule) throw new Error("Expected Vite to track the Database Definition.")
      // Vite invalidates the edited file before it invokes the plugin's hot-update hook.
      server.moduleGraph.invalidateModule(changedModule)
      await resolveHotUpdate(plugin)({ file: definition, server })

      await expect(query()).resolves.toEqual({ definition: [{ title: "application note" }], registry: [{ title: "application note" }] })
      expect(nativeQueries).toEqual([])
      expect(requests).toEqual(["/application/raw", "/application/raw"])
    }
    finally {
      await Promise.all([server.close(), closeHttpServer(proxy)])
    }
  }, 30_000)

  it("exposes integration connection defaults to direct definitions", async () => {
    const plugin = hubDb({
      connection: {
        authToken: "token",
        url: "libsql://database.example.turso.io",
      },
    })
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ database: undefined, root: await createTempProject() })

    // SAFETY: These are Vite hook handlers returned by hubDb.
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    // SAFETY: These are Vite hook handlers returned by hubDb.
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>
    const id = await resolveId("#vitehub/database/definition-defaults")

    expect(await load(id!)).toContain("libsql://database.example.turso.io")
  })

  it("resolves discovered database definitions and writes generated artifacts", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ db: undefined, root: rootDir })

    expect(plugin.api.getConfig()).toMatchObject({
      databaseNames: ["default"],
      databases: {
        default: {
          connection: { url: "file:.vitehub/data/database/sqlite.db" },
          migrationsDir: "server/databases/migrations",
          mode: "default",
        },
      },
    })
    await expect(readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")).resolves.toContain("export const notes")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")).resolves.toContain("server/databases/migrations")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")).resolves.toContain("dbCredentials")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle/default.config.ts"), "utf8")).resolves.toContain("file:.vitehub/data/database/sqlite.db")
  })

  it("resolves discovery and generated artifacts from projectRoot", async () => {
    const rootDir = await createTempProject()
    const projectRoot = join(rootDir, "packages", "db")
    await writeDefinition(projectRoot, "server/databases/config.ts")

    const plugin = hubDb({ projectRoot: "packages/db" })
    // SAFETY: The test invokes Vite's config hook with its documented arguments.
    const configure = plugin.config as (config: unknown, env: unknown) => void
    configure({ [VITEHUB_SERVER_DIRS]: [join(rootDir, "server")] }, { command: "serve", mode: "test" })
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ database: undefined, root: rootDir })

    expect(plugin.api.getConfig()?.rootDir).toBe(projectRoot)
    await expect(readFile(join(projectRoot, ".vitehub/database/schema/default.ts"), "utf8"))
      .resolves.toContain("export const notes")
  })

  it("reads provision state from the Vite root when projectRoot is nested", async () => {
    const rootDir = await createTempProject()
    const databaseRoot = join(rootDir, "packages", "db")
    await writeDefinition(databaseRoot, "server/databases/config.ts", "notes", { cloudflare: "databaseName: 'database-name'," })
    await mkdir(join(rootDir, ".vitehub"))
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "provisioned-database-id" } } }))
    await mkdir(join(databaseRoot, ".vitehub"))
    await writeFile(join(databaseRoot, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "unrelated-nested-id" } } }))

    const plugin = hubDb({ projectRoot: "packages/db" })
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ database: undefined, root: rootDir })

    expect(plugin.vitehub?.inspect?.()?.providerOutput?.map(output => output.description)).toEqual(["Generated Cloudflare Database worker"])
    expect(plugin.api.getConfig()?.databases.default?.cloudflare?.databaseId).toBe("provisioned-database-id")
    expect(plugin.api.getConfig()?.definitionDefaults.cloudflareProjections.default).toEqual({
      binding: "DB",
      provisionedId: "provisioned-database-id",
      resource: "configured",
    })

    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "refreshed-database-id" } } }))
    expect((await plugin.api.refresh())?.databases.default?.cloudflare?.databaseId).toBe("refreshed-database-id")

    await rm(join(rootDir, ".vitehub/provision.json"))
    const unprovisioned = await plugin.api.refresh()
    expect(unprovisioned?.databases.default?.cloudflare?.databaseId).toBeUndefined()
    expect(unprovisioned?.definitionDefaults.cloudflareProjections.default?.provisionedId).toBeUndefined()
    expect(unprovisioned?.definitionDefaults.cloudflareProjections.default?.binding).toBeUndefined()
    expect(plugin.vitehub?.inspect?.()?.providerOutput).toEqual([])
  })

  it("writes one Drizzle config per named database migrations directory", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")
    await writeDefinition(rootDir, "server/databases/primary/config.ts", "notes")

    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ db: undefined, root: rootDir })

    const analyticsConfig = await readFile(join(rootDir, ".vitehub/database/drizzle/analytics.config.ts"), "utf8")
    const primaryConfig = await readFile(join(rootDir, ".vitehub/database/drizzle/primary.config.ts"), "utf8")

    expect(analyticsConfig).toContain("server/databases/analytics/migrations")
    expect(analyticsConfig).toContain("file:.vitehub/data/database/analytics.sqlite.db")
    expect(primaryConfig).toContain("server/databases/primary/migrations")
    expect(primaryConfig).toContain("file:.vitehub/data/database/primary.sqlite.db")
  })

  it("keeps env-sourced Drizzle credentials as runtime expressions", async () => {
    const rootDir = await createTempProject()
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    const originalUrl = process.env.TURSO_DATABASE_URL
    process.env.TURSO_AUTH_TOKEN = "secret-token"
    process.env.TURSO_DATABASE_URL = "libsql://secret.example.turso.io"

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: process.env.TURSO_DATABASE_URL,",
        ].join("\n"),
      })

      const plugin = hubDb()
      const configResolved = resolveConfigResolved(plugin)
      await configResolved({ db: undefined, root: rootDir })

      const drizzleConfig = await readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")
      expect(drizzleConfig).toContain("authToken: process.env[\"TURSO_AUTH_TOKEN\"]")
      expect(drizzleConfig).toContain("url: process.env[\"TURSO_DATABASE_URL\"]")
      expect(drizzleConfig).not.toContain("secret-token")
      expect(drizzleConfig).not.toContain("secret.example")
    }
    finally {
      if (originalAuthToken === undefined) delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
      if (originalUrl === undefined) delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = originalUrl
    }
  })

  it("writes Cloudflare D1 HTTP credentials for Drizzle Kit", async () => {
    const rootDir = await createTempProject()
    const originalDatabaseId = process.env.CLOUDFLARE_D1_DATABASE_ID
    process.env.CLOUDFLARE_D1_DATABASE_ID = "secret-database-id"

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        cloudflare: [
          "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
          "    http: true,",
        ].join("\n"),
      })

      const plugin = hubDb()
      const configResolved = resolveConfigResolved(plugin)
      await configResolved({ db: undefined, root: rootDir })

      const drizzleConfig = await readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")
      expect(drizzleConfig).toContain("driver: \"d1-http\"")
      expect(drizzleConfig).toContain("accountId: process.env[\"CLOUDFLARE_ACCOUNT_ID\"]")
      expect(drizzleConfig).toContain("databaseId: process.env[\"CLOUDFLARE_D1_DATABASE_ID\"]")
      expect(drizzleConfig).toContain("token: process.env[\"CLOUDFLARE_API_TOKEN\"]")
      expect(drizzleConfig).not.toContain("secret-database-id")
    }
    finally {
      if (originalDatabaseId === undefined) delete process.env.CLOUDFLARE_D1_DATABASE_ID
      else process.env.CLOUDFLARE_D1_DATABASE_ID = originalDatabaseId
    }
  })

  it("keeps Drizzle Kit on libSQL when D1 HTTP is not selected", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      cloudflare: "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
      connection: [
        "    authToken: 'libsql-token',",
        "    url: 'libsql://database.example.turso.io',",
      ].join("\n"),
    })

    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ db: undefined, root: rootDir })

    const drizzleConfig = await readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")
    expect(drizzleConfig).toContain("url: \"libsql://database.example.turso.io\"")
    expect(drizzleConfig).toContain("authToken: \"libsql-token\"")
    expect(drizzleConfig).not.toContain("driver: \"d1-http\"")
  })

  it("lets top-level config disable the database plugin", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ database: false, root: rootDir })

    expect(plugin.api.getConfig()).toBeUndefined()
  })

  it("does not contribute the DB CLI namespace when top-level config disables the database plugin", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ database: false, root: rootDir })

    await expect(resolveCliContributor(plugin)).resolves.toBeUndefined()
  })

  it("contributes provisioning but no CLI namespaces when resolved config disables database CLI", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ database: { cli: false }, root: rootDir })

    const contributor = await resolveCliContributor(plugin)
    expect(contributor?.namespaces).toEqual([])
    expect(contributor?.provision?.map(step => step.id)).toEqual(["database:cloudflare-d1"])
  })

  it("exposes default schema and database registry through stable ViteHub import paths", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ root: rootDir })

    // SAFETY: These are Vite hook handlers returned by hubDb.
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    // SAFETY: These are Vite hook handlers returned by hubDb.
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    const resolvedSchemaId = await resolveId(DB_VIRTUAL_SCHEMA_ID)
    const resolvedDatabasesId = await resolveId(DB_VIRTUAL_DATABASES_ID)
    const schemaCode = await load(resolvedSchemaId!)
    const databasesCode = await load(resolvedDatabasesId!)

    expect(schemaCode).toContain("export { default, schema }")
    expect(schemaCode).toContain(join(rootDir, ".vitehub/database/schema/default.ts"))
    expect(databasesCode).toContain(definition)
    expect(databasesCode).toContain("\"default\"")
    expect(databasesCode).toContain("\"server/databases/migrations\"")
    const generatedTypesFile = join(rootDir, ".vitehub/types/database.d.ts")
    const generatedTypes = await readFile(generatedTypesFile, "utf8")
    expect(generatedTypes).toContain('declare module "@vite-hub/database/drizzle"')
    expect(generatedTypes).toContain('declare module "vite-hub/database/drizzle"')
    expect(generatedTypes).toContain("type DefaultDatabaseSchema = typeof database_0.schema")
    expect(generatedTypes).toContain('declare module "#vitehub/database/schema" {\n  interface DatabaseSchema extends DefaultDatabaseSchema {}')

    await configResolved({ database: false, root: rootDir })
    await expect(readFile(generatedTypesFile, "utf8")).resolves.toBe("export {}\n")
  })

  it("refreshes cached direct Definition defaults when HMR changes resource ownership", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      cloudflare: "binding: 'HOST_DB', databaseId: 'application-id', databaseName: 'application',",
    })
    const plugin = hubDb({ driver: "d1", binding: "HOST_DB", databaseId: "host-id", databaseName: "host" })
    const server = await createViteServer({
      configFile: false,
      plugins: [plugin],
      root: rootDir,
      server: { hmr: false, middlewareMode: true, watch: null },
    })
    const runtimeFile = resolve(import.meta.dirname, "../src/runtime/definition-config.ts")
    const evaluatedDefinition = {
      drizzle: {},
      name: "default",
      schema: {},
      cloudflare: { binding: "HOST_DB", databaseId: "application-id", databaseName: "application" },
    }
    const loadRuntime = async () => {
      // SAFETY: This source module exports the direct Definition runtime config resolver.
      return await server.ssrLoadModule(runtimeFile) as typeof import("../src/runtime/definition-config.ts")
    }

    try {
      expect((await loadRuntime()).runtimeConfig(evaluatedDefinition).cloudflare?.binding).toBe("HOST_DB")
      await writeFile(definition, [
        "import { defineDatabase } from '@vite-hub/database'",
        "const cloudflare = { binding: 'HOST_DB', databaseId: 'application-id', databaseName: 'application' }",
        "export default defineDatabase({ name: 'default', cloudflare, schema: {} })",
      ].join("\n"))
      await resolveHotUpdate(plugin)({ file: definition, server })

      const updated = (await loadRuntime()).runtimeConfig(evaluatedDefinition)
      expect(updated.cloudflare?.databaseId).toBe("application-id")
      expect(updated.cloudflare?.binding).toBeUndefined()

      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        cloudflare: "binding: 'HOST_DB', databaseId: 'application-id', databaseName: 'application',",
      })
      await resolveHotUpdate(plugin)({ file: definition, server })
      expect((await loadRuntime()).runtimeConfig(evaluatedDefinition).cloudflare?.binding).toBe("HOST_DB")
    }
    finally {
      await server.close()
    }
  })

  it("refreshes generated artifacts during definition hot updates", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ root: rootDir })

    const handleHotUpdate = resolveHotUpdate(plugin)

    await writeFile(definition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const tasks = sqliteTable('tasks', { title: text('title') })",
      "export default defineDatabase({ schema: { tasks } })",
      "",
    ].join("\n"))
    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${DB_VIRTUAL_SCHEMA_ID}` || id === `\0${DB_VIRTUAL_DATABASES_ID}`) {
              return { id }
            }
          },
          invalidateModule(module: { id: string }) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${DB_VIRTUAL_SCHEMA_ID}`, `\0${DB_VIRTUAL_DATABASES_ID}`])
    await expect(readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")).resolves.toContain("export const tasks")
  })

  it("normalizes definition paths before matching hot updates", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ root: rootDir })

    const config = plugin.api.getConfig()!
    config.definitions[0]!.handler = config.definitions[0]!.handler.replaceAll("/", "\\")

    const handleHotUpdate = resolveHotUpdate(plugin)

    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${DB_VIRTUAL_SCHEMA_ID}` || id === `\0${DB_VIRTUAL_DATABASES_ID}`) {
              return { id }
            }
          },
          invalidateModule(module: { id: string }) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${DB_VIRTUAL_SCHEMA_ID}`, `\0${DB_VIRTUAL_DATABASES_ID}`])
  })
})
