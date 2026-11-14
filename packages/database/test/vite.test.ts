import { createServer as createHttpServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { execFile, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer as createViteServer, resolveConfig, type ViteDevServer } from "vite"
import { VITEHUB_FEATURES, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"

import { supportsHostedDatabaseRuntime } from "../src/internal/vite-build.ts"
import { checkDurability } from "@vite-hub/runtime/durability"
import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

import {
  DB_VIRTUAL_DATABASES_ID,
  DB_VIRTUAL_SCHEMA_ID,
  hubDatabase,
} from "../src/vite.ts"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-vite-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, path: string, table = "notes", options: { cloudflare?: string, connection?: string } = {}) {
  const file = join(rootDir, path)
  const name = /(?:^|\/)src\/([^/]+)\.database\./.exec(path)?.[1]
    ?? /(?:^|\/)server\/databases\/([^/]+)\/index\./.exec(path)?.[1]
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

async function resolveCliContributor(plugin: ReturnType<typeof hubDatabase>) {
  const cli = plugin.vitehub?.cli
  return cli instanceof Function ? await cli() : cli
}

function resolveConfigResolved(plugin: ReturnType<typeof hubDatabase>): (config: unknown) => Promise<void> {
  // SAFETY: hubDatabase returns a Vite plugin whose configResolved property is the hook handler used by these tests.
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

function resolveHotUpdate(plugin: ReturnType<typeof hubDatabase>): (context: TestHotUpdateContext) => Promise<void> {
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

describe("hubDatabase", () => {
  it("reports evaluated Definition connection and Cloudflare overrides", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    await mkdir(join(rootDir, "server/databases"), { recursive: true })
    for (const [name, options] of Object.entries({
      default: '{ connection: { url: "file:instance.db" }, schema: {} }',
      remote: '{ connection: { url: { kind: "env-variable", source: { kind: "env", name: "REMOTE_URL" }, default: remoteDefault } }, schema: {} }',
      edge: '{ cloudflare, schema: {} }',
    })) {
      await writeFile(join(rootDir, `server/databases/${name}.ts`), [
        'import { defineDatabase } from "@vite-hub/database"',
        'const remoteDefault = "libsql://shared.example?authToken=secret"',
        'const cloudflare = { databaseId: "d1-id", http: true }',
        `const options = ${options.replace("{", `{ name: ${JSON.stringify(name)},`)}`,
        `export default defineDatabase(${name === "default" ? "options" : options.replace("{", `{ name: ${JSON.stringify(name)},`)})`,
      ].join("\n"))
    }
    const plugin = hubDatabase({ connection: { url: "libsql://integration.example?authToken=secret" } })
    await resolveConfigResolved(plugin)({ command: "build", root: rootDir })
    const contribution = plugin.vitehub?.durability?.()[0]
    expect(contribution).toBeDefined()
    const server = await createViteServer({ configFile: false, logLevel: "silent", root: rootDir, server: { middlewareMode: true, watch: null } })
    try {
      const module = await server.ssrLoadModule(contribution!.module) as { databaseDurability: (input: unknown, context: DurabilityContext) => Durability[] }
      const reports = module.databaseDurability(contribution!.input, { env: {}, find: () => undefined })
      expect(reports).toEqual(expect.arrayContaining([
        expect.objectContaining({ primitive: "database", store: "sqlite", scope: "host" }),
        expect.objectContaining({ name: "remote", store: "libsql", scope: "shared" }),
        expect.objectContaining({ name: "edge", store: "d1", scope: "shared" }),
      ]))
      expect(() => checkDurability(reports, { instances: 2, log: false })).toThrow(expect.objectContaining({ name: "RUNTIME_R0017" }))
      expect(() => checkDurability(reports.filter(report => report.name), { instances: 2, log: false })).not.toThrow()
      expect(JSON.stringify({ contribution, reports })).not.toContain("secret")
    }
    finally { await server.close() }
  })

  it("filters resolveId, load, and transform to the ids Database owns", () => {
    const plugin = hubDatabase()
    const matches = (hook: unknown, id: string) => {
      const filter = (hook as { filter: { id: RegExp | RegExp[] } }).filter.id
      return [filter].flat().some(pattern => pattern.test(id))
    }
    const virtualIds = [DB_VIRTUAL_SCHEMA_ID, DB_VIRTUAL_DATABASES_ID, "#vitehub/database/definition-defaults"]

    expect([...virtualIds, "virtual:vitehub/database/schema", "virtual:vitehub/database/databases", "#vitehub/database/libsql", "virtual:vitehub/database/definition-defaults", "virtual:vitehub/database/libsql", "#vitehub/database/other"]
      .map(id => matches(plugin.resolveId, id))).toEqual([true, true, true, true, true, true, false, false, false])
    expect(["@vite-hub/database", "vite-hub/database", "/app/node_modules/@vite-hub/database/dist/index.js", "C:\\app\\packages\\database\\dist\\index.js", "/app/node_modules/vite-hub/dist/database.js", "/app/server/database.js"]
      .map(id => matches(plugin.resolveId, id))).toEqual([true, true, true, true, true, false])
    expect([...virtualIds.map(id => `\0${id}`), DB_VIRTUAL_SCHEMA_ID].map(id => matches(plugin.load, id))).toEqual([true, true, true, false])
    expect(["/app/node_modules/@vite-hub/database/dist/runtime/registry.js", "C:\\app\\packages\\database\\dist\\runtime\\registry.js", "/app/node_modules/drizzle-orm/dist/registry.js", "/app/server/registry.js"]
      .map(id => matches(plugin.transform, id))).toEqual([true, true, false, false])
  })

  it("does not inspect provider output without enabled Database Definitions", async () => {
    const rootDir = await createTempProject()
    const plugin = hubDatabase()
    await resolveConfigResolved(plugin)({ root: rootDir })
    expect(plugin.vitehub?.inspect?.()).not.toHaveProperty("providerOutput")

    await writeDefinition(rootDir, "server/databases/default.ts")
    const disabled = hubDatabase(false)
    await resolveConfigResolved(disabled)({ root: rootDir })
    expect(disabled.vitehub?.inspect?.()).toBeUndefined()
  })

  it.each([
    { name: "local SQLite", connection: "url: 'file:local.db',", cloudflare: undefined, providers: [] },
    { name: "remote libSQL", connection: "url: 'libsql://database.example',", cloudflare: undefined, providers: ["cloudflare", "vercel"] },
    { name: "remote libSQL with unresolved D1 fallback", connection: "url: 'libsql://database.example',", cloudflare: "databaseId: '   ', databaseName: '   ',", providers: ["cloudflare", "vercel"] },
    { name: "D1 with a blank ID", connection: undefined, cloudflare: "databaseId: '   ', databaseName: 'database-name',", providers: [] },
    { name: "D1 with a blank name", connection: undefined, cloudflare: "databaseId: 'database-id', databaseName: '   ',", providers: [] },
    { name: "D1 binding", connection: undefined, cloudflare: "databaseId: 'database-id', databaseName: 'database-name',", providers: ["cloudflare"] },
    { name: "D1 HTTP", connection: undefined, cloudflare: "databaseId: 'database-id', databaseName: 'database-name', http: true,", providers: ["cloudflare", "vercel"] },
    { name: "D1 HTTP without a database name", connection: undefined, cloudflare: "databaseId: 'database-id', http: true,", providers: ["cloudflare", "vercel"] },
  ])("supports the hosted runtime on the expected hosts for $name", async ({ connection, cloudflare, providers }) => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { connection, cloudflare })
    const plugin = hubDatabase()
    await resolveConfigResolved(plugin)({ root: rootDir })
    const runtime = plugin.api.getConfig()!
    expect((["cloudflare", "vercel"] as const).filter(provider => supportsHostedDatabaseRuntime(provider, runtime, {}))).toEqual(providers)
  })

  it("requires every Database Definition to support a host", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/remote/index.ts", "notes", { connection: "url: 'libsql://database.example'," })
    await writeDefinition(rootDir, "server/databases/local/index.ts", "tasks", { connection: "url: 'file:local.db'," })
    const plugin = hubDatabase()
    await resolveConfigResolved(plugin)({ root: rootDir })
    const runtime = plugin.api.getConfig()!
    expect(supportsHostedDatabaseRuntime("cloudflare", runtime, {})).toBe(false)
    expect(supportsHostedDatabaseRuntime("vercel", runtime, {})).toBe(false)
  })

  it("reads provisioned D1 IDs for the Cloudflare hosted runtime", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: "databaseName: 'database-name'," })
    const plugin = hubDatabase()
    await resolveConfigResolved(plugin)({ root: rootDir })
    const runtime = plugin.api.getConfig()!
    expect(supportsHostedDatabaseRuntime("cloudflare", runtime, readProvisionStateSync(rootDir))).toBe(false)

    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "provisioned-database-id" } } }))
    expect(supportsHostedDatabaseRuntime("cloudflare", runtime, readProvisionStateSync(rootDir))).toBe(true)
  })

  it("merges discovered D1 bindings and migrations into Cloudflare Nitro output", async () => {
    const rootDir = await createTempProject()
    const serverDir = join(rootDir, ".output", "server")
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: "binding: 'DB', databaseName: 'app', databaseId: 'database-id'," })
    await mkdir(join(rootDir, "server/databases/default/migrations"), { recursive: true })
    await writeFile(join(rootDir, "server/databases/default/migrations/0001_init.sql"), "create table notes (title text);\n")
    const compiledHooks: Array<(...args: never[]) => unknown> = []
    const createNitro = (preset: string) => {
      const options: { cloudflare?: { wrangler?: { d1_databases?: unknown } }, output: { serverDir: string }, preset: string } = { output: { serverDir }, preset }
      return { hooks: { hook: (name: string, callback: (...args: never[]) => unknown) => { if (name === "compiled") compiledHooks.push(callback) } }, options }
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
    const cloudflarePlugin = hubDatabase()
    const vercelPlugin = hubDatabase()
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

  describe("migrateOnDeploy", () => {
    it.each([false, true])("resolves migration commands in the real Vite/Nitro lifecycle (HTTP: %s)", { timeout: 30_000 }, async (http) => {
      const { nitro } = await import("nitro/vite")
      const rootDir = await createTempProject()
      await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
        cloudflare: `binding: 'DB', databaseName: 'app', databaseId: 'database-id', http: ${http},`,
      })
      let instance: import("nitro/types").Nitro | undefined
      const configuration = resolveConfig({
        configFile: false,
        root: rootDir,
        plugins: [hubDatabase({ migrateOnDeploy: true }), nitro({
          preset: "cloudflare_module",
          compatibilityDate: "2026-10-01",
          commands: { deploy: "npx wrangler deploy --config ./server/wrangler.json" },
          modules: [{ setup(nitro) { instance = nitro } }],
        })],
      }, "build")
      try {
        if (http) {
          await expect(configuration).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED" })
        }
        else {
          await configuration
          expect(instance?.options.commands.deploy).toBe("npx wrangler d1 migrations apply DB --remote --config ./server/wrangler.json && npx wrangler deploy --config ./server/wrangler.json")
        }
      }
      finally {
        await instance?.close()
      }
    })

    async function buildCommand(options: { cloudflare?: string, preset?: string, serverDir?: string } = {}) {
      const rootDir = await createTempProject()
      await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: options.cloudflare ?? "binding: 'DB', databaseName: 'app', databaseId: 'database-id'," })
      await writeDefinition(rootDir, "server/databases/analytics/index.ts", "events", { cloudflare: "databaseName: 'analytics', databaseId: 'analytics-id'," })
      const buildBefore: Array<(...args: never[]) => unknown> = []
      const commands: Record<string, unknown> = { deploy: "npx wrangler deploy --config ./server/wrangler.json" }
      const nitro = {
        hooks: { hook: (name: string, callback: (...args: never[]) => unknown) => { if (name === "build:before") buildBefore.push(callback) } },
        options: {
          commands,
          output: { dir: join(rootDir, ".output"), serverDir: join(rootDir, ".output", options.serverDir ?? "server") },
          preset: options.preset ?? "cloudflare-module",
        },
      }
      const plugin = hubDatabase({ migrateOnDeploy: true })
      plugin.nitro.setup(nitro)
      await resolveConfigResolved(plugin)({ root: rootDir })
      return () => {
        for (const hook of buildBefore) hook()
        return nitro.options.commands.deploy
      }
    }

    it("applies the D1 migrations of each binding before the Cloudflare deploy", async () => {
      const build = await buildCommand()
      const command = [
        "npx wrangler d1 migrations apply DB_ANALYTICS --remote --config ./server/wrangler.json",
        "npx wrangler d1 migrations apply DB --remote --config ./server/wrangler.json",
        "npx wrangler deploy --config ./server/wrangler.json",
      ].join(" && ")
      expect(build()).toBe(command)
      // A second build of the same Nitro instance keeps one migrate step per binding.
      expect(build()).toBe(command)
    })

    it("runs the migrations from the shell after Nitro's deploy --prebuilt rewrite, and stops at the first failure", async () => {
      const build = await buildCommand({ serverDir: "cloudflare worker" })
      const command = String(build()).replace(/(^|[\s:])\.\/(\S*)/g, "$1.output/$2")
      const npx = 'npx() { printf "%s\\n" "$*"; if [ "$5" = "DB" ]; then return 1; fi; }\n'
      const result = spawnSync("sh", ["-c", npx + command], { encoding: "utf8" })

      expect(result.status).toBe(1)
      expect(result.stdout.trim().split("\n")).toEqual([
        "wrangler d1 migrations apply DB_ANALYTICS --remote --config .output/cloudflare worker/wrangler.json",
        "wrangler d1 migrations apply DB --remote --config .output/cloudflare worker/wrangler.json",
      ])
    })

    it("fails the build for another host or a database without a D1 binding", async () => {
      await expect(buildCommand({ preset: "vercel" })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED" })
      await expect(buildCommand({ cloudflare: "databaseId: 'database-id', http: true," })).rejects.toMatchObject({
        code: "DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED",
        why: expect.stringContaining("cannot migrate the database \"default\". It uses Cloudflare D1 over HTTP."),
      })
    })
  })

  async function buildStartForCloudflare(plugin: ReturnType<typeof hubDatabase>, rootDir: string, plugins: unknown[] = [], command = "build") {
    await resolveConfigResolved(plugin)({ build: { outDir: "dist" }, command, nitro: { preset: "cloudflare-module" }, plugins: [{ name: "nitro:main" }, ...plugins], root: rootDir })
    // SAFETY: hubDatabase exposes buildStart as a callable Vite hook.
    return () => Reflect.apply(plugin.buildStart as () => void, { environment: {} }, [])
  }

  it.each(["default", "orders"])("rejects D1 Definition %s without cloudflare options when Vite builds for Cloudflare", async (name) => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, name === "default" ? "server/databases/default.ts" : `server/databases/${name}/index.ts`)
    // `vitehub({ host: "cloudflare", database: true })` passes this to the Database plugin.
    const buildStart = await buildStartForCloudflare(hubDatabase({ driver: "d1" }), rootDir)

    expect(buildStart).toThrow(expect.objectContaining({
      code: "DATABASE_MISSING_D1_RESOURCE",
      why: expect.stringContaining("`cloudflare.databaseName`"),
    }))
  })

  it.each([
    { cloudflare: "databaseName: 'database-name',", missing: "cloudflare.databaseId" },
    { cloudflare: "databaseId: 'database-id',", missing: "cloudflare.databaseName" },
    { cloudflare: "databaseId: '   ', databaseName: 'database-name',", missing: "cloudflare.databaseId" },
    { cloudflare: "databaseId: 'database-id', databaseName: '   ',", missing: "cloudflare.databaseName" },
  ])("rejects incomplete native D1 resources in a Cloudflare Vite build: $cloudflare", async ({ cloudflare, missing }) => {
    for (const name of ["default", "orders"]) {
      const rootDir = await createTempProject()
      await writeDefinition(rootDir, name === "default" ? "server/databases/default.ts" : `server/databases/${name}/index.ts`, "notes", { cloudflare })
      const buildStart = await buildStartForCloudflare(hubDatabase({ driver: "d1" }), rootDir)

      expect(buildStart).toThrow(expect.objectContaining({
        code: "DATABASE_MISSING_D1_RESOURCE",
        why: expect.stringContaining(missing),
      }))
    }
  })

  it.each([
    { name: "a D1 binding", cloudflare: "databaseId: 'database-id', databaseName: 'database-name',", connection: undefined, provisioned: false },
    { name: "a provisioned D1 database", cloudflare: "databaseName: 'database-name',", connection: undefined, provisioned: true },
    { name: "D1 HTTP", cloudflare: "databaseId: 'database-id', http: true,", connection: undefined, provisioned: false },
    { name: "remote libSQL", cloudflare: undefined, connection: "url: 'libsql://database.example',", provisioned: false },
    { name: "remote libSQL with incomplete D1 options", cloudflare: "databaseName: 'database-name',", connection: "url: 'libsql://database.example',", provisioned: false },
  ])("builds a Cloudflare D1 Definition with $name", async ({ cloudflare, connection, provisioned }) => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare, connection })
    if (provisioned) {
      await mkdir(join(rootDir, ".vitehub"), { recursive: true })
      await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "provisioned-database-id" } } }))
    }
    const buildStart = await buildStartForCloudflare(hubDatabase({ driver: "d1" }), rootDir)

    expect(buildStart).not.toThrow()
  })

  it.each([undefined, "binding: 'DB',"])("checks the resolved runtime Env URL with Cloudflare options %s", async (cloudflare) => {
    vi.stubEnv("VITEHUB_VITE_TEST_REMOTE_URL", undefined)
    try {
      const rootDir = await createTempProject()
      await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare, connection: "url: process.env.VITEHUB_VITE_TEST_REMOTE_URL," })
      const plugin = hubDatabase({ driver: "d1" })
      const buildStart = await buildStartForCloudflare(plugin, rootDir)

      expect(plugin.api.getConfig()?.databases.default?.connection?.url).toEqual({
        kind: "env-variable",
        source: { kind: "env", name: "VITEHUB_VITE_TEST_REMOTE_URL" },
        default: "file:.vitehub/data/database/sqlite.db",
      })
      expect(supportsHostedDatabaseRuntime("cloudflare", plugin.api.getConfig()!, {})).toBe(false)
      expect(buildStart).toThrow(expect.objectContaining({ code: "DATABASE_MISSING_D1_RESOURCE" }))

      vi.stubEnv("VITEHUB_VITE_TEST_REMOTE_URL", "libsql://database.example")
      expect(supportsHostedDatabaseRuntime("cloudflare", plugin.api.getConfig()!, {})).toBe(true)
      expect(buildStart).not.toThrow()
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not check D1 resources in Vite development or on other hosts", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts")

    expect(await buildStartForCloudflare(hubDatabase({ driver: "d1" }), rootDir, [], "serve")).not.toThrow()
    const plugin = hubDatabase()
    await resolveConfigResolved(plugin)({ build: { outDir: "dist" }, command: "build", nitro: { preset: "node-server" }, plugins: [{ name: "nitro:main" }], root: rootDir })
    // SAFETY: hubDatabase exposes buildStart as a callable Vite hook.
    expect(() => Reflect.apply(plugin.buildStart as () => void, { environment: {} }, [])).not.toThrow()
  })

  it.each([
    ["no use", undefined],
    ["a Database use", { name: "@vite-hub/connections/vite", vitehub: { databases: () => [{ database: "default", name: "connections", reason: "Stores Connection grants." }] } }],
  ])("checks the implicit default D1 Database in a Vite build only when a plugin needs it: %s", async (_case, use) => {
    const rootDir = await createTempProject()
    const buildStart = await buildStartForCloudflare(hubDatabase({ driver: "d1" }), rootDir, use ? [use] : [])
    if (!use) return expect(buildStart).not.toThrow()

    expect(buildStart).toThrow(expect.objectContaining({
      code: "DATABASE_MISSING_D1_RESOURCE",
      why: expect.stringContaining("`database.databaseName`"),
    }))
  })

  it("keeps one D1 binding when the project's wrangler.json also declares it", { timeout: 30_000 }, async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: "binding: 'DB', databaseName: 'app', databaseId: 'database-id'," })
    await writeFile(join(rootDir, "wrangler.json"), JSON.stringify({ d1_databases: [{ binding: "DB", database_id: "database-id", preview_database_id: "preview-id" }] }))
    const plugin = hubDatabase()
    // Nitro 3's Cloudflare preset writes wrangler.json, merging the project file with defu, before module hooks run.
    const { createNitro } = await import("nitro/builder")
    const nitro = await createNitro({
      cloudflare: { deployConfig: true },
      compatibilityDate: "2026-10-01",
      dev: false,
      logLevel: 0,
      modules: [plugin.nitro],
      preset: "cloudflare-module",
      rootDir,
    })
    try {
      await resolveConfigResolved(plugin)({ root: rootDir })
      await nitro.hooks.callHook("compiled", nitro)
      const wrangler = JSON.parse(await readFile(join(nitro.options.output.serverDir, "wrangler.json"), "utf8")) as { d1_databases: unknown[] }
      expect(wrangler.d1_databases).toEqual([
        { binding: "DB", database_id: "database-id", database_name: "app", migrations_dir: ".vitehub/database/migrations/DB", preview_database_id: "preview-id" },
      ])
    }
    finally {
      await nitro.close()
    }
  })

  it("warns when the project's wrangler.json keeps NuxtHub's D1 migration history", { timeout: 30_000 }, async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: "binding: 'DB', databaseName: 'app', databaseId: 'database-id'," })
    await writeFile(join(rootDir, "wrangler.json"), JSON.stringify({ d1_databases: [{ binding: "DB", database_id: "database-id", migrations_table: "_hub_migrations", migrations_dir: ".output/server/db/migrations/sqlite/" }] }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const plugin = hubDatabase()
    const { createNitro } = await import("nitro/builder")
    const nitro = await createNitro({
      cloudflare: { deployConfig: true },
      compatibilityDate: "2026-10-01",
      dev: false,
      logLevel: 0,
      modules: [plugin.nitro],
      preset: "cloudflare-module",
      rootDir,
    })
    try {
      await resolveConfigResolved(plugin)({ root: rootDir })
      await nitro.hooks.callHook("compiled", nitro)
      const wrangler = JSON.parse(await readFile(join(nitro.options.output.serverDir, "wrangler.json"), "utf8")) as { d1_databases: unknown[] }
      expect(wrangler.d1_databases).toEqual([
        { binding: "DB", database_id: "database-id", database_name: "app", migrations_dir: ".vitehub/database/migrations/DB", migrations_table: "_hub_migrations" },
      ])
      expect(warn.mock.calls.filter(([message]) => String(message).includes("`_hub_migrations`"))).toEqual([
        [expect.stringContaining("The D1 binding \"DB\" uses NuxtHub's `_hub_migrations` table")],
      ])
    }
    finally {
      warn.mockRestore()
      await nitro.close()
    }
  })

  it("warns when the Database Definition sets NuxtHub's D1 migration history", { timeout: 30_000 }, async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: "binding: 'DB', databaseName: 'app', databaseId: 'database-id', migrationsTable: '_hub_migrations'," })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const plugin = hubDatabase()
    const { createNitro } = await import("nitro/builder")
    const nitro = await createNitro({ cloudflare: { deployConfig: true }, compatibilityDate: "2026-10-01", dev: false, logLevel: 0, modules: [plugin.nitro], preset: "cloudflare-module", rootDir })
    try {
      await resolveConfigResolved(plugin)({ root: rootDir })
      await nitro.hooks.callHook("compiled", nitro)
      expect(warn.mock.calls.filter(([message]) => String(message).includes("`_hub_migrations`"))).toEqual([
        [expect.stringContaining("or `cloudflare.migrationsTable` from the Database Definition")],
      ])
    }
    finally {
      warn.mockRestore()
      await nitro.close()
    }
  })

  it("merges Postgres Hyperdrive bindings into Cloudflare Nitro output", async () => {
    const rootDir = await createTempProject()
    await mkdir(join(rootDir, "server/databases"), { recursive: true })
    await writeFile(join(rootDir, "server/databases/default.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { pgTable, text } from 'drizzle-orm/pg-core'",
      "export default defineDatabase({",
      "  dialect: 'postgresql',",
      "  cloudflare: { binding: 'APP_HYPERDRIVE', hyperdriveId: 'hyperdrive-id' },",
      "  schema: { notes: pgTable('notes', { title: text('title') }) },",
      "})",
      "",
    ].join("\n"))
    const options: { cloudflare?: { wrangler?: { d1_databases?: unknown, hyperdrive?: unknown } }, handlers?: Array<{ handler: string, middleware?: boolean, route?: string }>, output: { serverDir: string }, preset: string } = {
      cloudflare: { wrangler: { hyperdrive: [{ binding: "APP_HYPERDRIVE", id: "stale-id" }] } },
      output: { serverDir: join(rootDir, ".output", "server") },
      preset: "cloudflare-module",
    }
    const plugin = hubDatabase()
    plugin.nitro.setup({ hooks: { hook: () => {} }, options })

    await resolveConfigResolved(plugin)({ root: rootDir })

    expect(options.cloudflare?.wrangler?.hyperdrive).toEqual([{ binding: "APP_HYPERDRIVE", id: "hyperdrive-id" }])
    expect(options.cloudflare?.wrangler?.d1_databases).toBeUndefined()
    const handler = join(rootDir, ".vitehub/nitro/database/request-scope.mjs")
    const statsHandler = join(rootDir, ".vitehub/nitro/database/request-stats.mjs")
    // The stats middleware comes first, so it also counts the calls of later middleware.
    expect(options.handlers).toEqual([{ handler: statsHandler, middleware: true }, { handler, middleware: true }])
    const middleware = (await import(pathToFileURL(handler).href)).default as (event: unknown, next: () => unknown) => unknown
    const { getActiveCloudflareRequestScope } = await import("@vite-hub/internal/runtime/cloudflare-env")
    const env = { APP_HYPERDRIVE: { connectionString: "postgres://hyperdrive/app" } }
    const request = (bindings: Record<string, unknown>) => ({ "~standard": { req: new Request("https://app.example/"), res: { headers: new Headers() }, runtime: { cloudflare: { env: bindings } }, vendor: "test" } })
    const scopes = [
      middleware(request(env), () => getActiveCloudflareRequestScope()),
      middleware(request(env), () => getActiveCloudflareRequestScope()),
    ]
    expect(scopes[0]).toBeDefined()
    expect(scopes[0]).not.toBe(scopes[1])
  })

  it("installs request scope middleware for D1 read replication without Postgres", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: "readReplication: true," })
    const options: { cloudflare?: { wrangler?: { d1_databases?: unknown } }, handlers?: Array<{ handler: string, middleware?: boolean, route?: string }>, output: { serverDir: string }, preset: string } = {
      output: { serverDir: join(rootDir, ".output", "server") },
      preset: "cloudflare-module",
    }
    const plugin = hubDatabase()
    plugin.nitro.setup({ hooks: { hook: () => {} }, options })

    await resolveConfigResolved(plugin)({ root: rootDir })

    expect(options.handlers).toEqual([
      { handler: join(rootDir, ".vitehub/nitro/database/request-stats.mjs"), middleware: true },
      { handler: join(rootDir, ".vitehub/nitro/database/request-scope.mjs"), middleware: true },
    ])
  })

  it("keeps request scope middleware for opaque D1 read replication", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/default.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const notes = sqliteTable('notes', { title: text('title') })",
      "const cloudflare = { readReplication: process.env.READ_REPLICATION === 'true' }",
      "export default defineDatabase({ name: 'default', cloudflare: { ...cloudflare }, schema: { notes } })",
      "",
    ].join("\n"))
    const options: { handlers?: Array<{ handler: string, middleware?: boolean }>, output: { serverDir: string }, preset: string } = {
      output: { serverDir: join(rootDir, ".output", "server") },
      preset: "cloudflare-module",
    }
    const plugin = hubDatabase()
    plugin.nitro.setup({ hooks: { hook: () => {} }, options })

    await resolveConfigResolved(plugin)({ root: rootDir })

    expect(options.handlers).toEqual([
      { handler: join(rootDir, ".vitehub/nitro/database/request-stats.mjs"), middleware: true },
      { handler: join(rootDir, ".vitehub/nitro/database/request-scope.mjs"), middleware: true },
    ])
  })

  it("keeps request scope middleware when a configured D1 readReplication is dynamic", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
      cloudflare: "databaseName: 'app', readReplication: process.env.READ_REPLICATION === 'true',",
    })
    const options: { handlers?: Array<{ handler: string, middleware?: boolean }>, output: { serverDir: string }, preset: string } = {
      output: { serverDir: join(rootDir, ".output", "server") },
      preset: "cloudflare-module",
    }
    const plugin = hubDatabase()
    plugin.nitro.setup({ hooks: { hook: () => {} }, options })

    await resolveConfigResolved(plugin)({ root: rootDir })

    expect(options.handlers).toEqual([
      { handler: join(rootDir, ".vitehub/nitro/database/request-stats.mjs"), middleware: true },
      { handler: join(rootDir, ".vitehub/nitro/database/request-scope.mjs"), middleware: true },
    ])
  })

  it("routes Vite development queries through configured Cloudflare D1 HTTP", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    let proxyRequest: { authorization?: string, body?: unknown, method?: string, path?: string } = {}
    const proxy = createHttpServer(async (request, response) => {
      // Other local tools can probe a new port with `GET /`. D1 HTTP calls always send a token.
      if (!request.headers.authorization) return response.end()
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

    await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
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
      "import { useDatabase } from '@vite-hub/database'",
      "export const query = () => {",
      "  const { db, schema } = useDatabase('default')",
      "  return db.select().from(schema.notes)",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "index.html"), "<div>ViteHub Database</div>")

    const server = await createViteServer({
      configFile: false,
      plugins: [hubDatabase()],
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

  it("sends a remote: true Database to its real D1 database in Vite development, not to a local binding", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    const definition = join(rootDir, "server/databases/default.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const notes = sqliteTable('notes', { title: text('title') })",
      "export default defineDatabase({ cloudflare: { binding: 'DB', databaseId: 'real-database-id' }, remote: true, schema: { notes } })",
      "",
    ].join("\n"))
    const queryFile = join(rootDir, "server/query.ts")
    await writeFile(queryFile, [
      "import { useDatabase } from '@vite-hub/database'",
      "import { runWithActiveCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'",
      "export const query = (binding: unknown) => runWithActiveCloudflareEnv({ DB: binding }, async () => {",
      "  const { db, schema } = useDatabase('default')",
      "  return { registry: await db.select().from(schema.notes) }",
      "})",
      "",
    ].join("\n"))
    const requests: Array<{ authorization: string | null, url: string }> = []
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ authorization: new Headers(init?.headers).get("authorization"), url: String(input) })
      return Response.json({ result: [{ results: { rows: [["real note"]] }, success: true }], success: true })
    })
    vi.stubGlobal("fetch", fakeFetch)
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "api-token")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const nativeQueries: string[] = []
    const localBinding = {
      prepare(query: string) {
        nativeQueries.push(query)
        return { bind: () => ({ raw: async () => [["local note"]] }) }
      },
    }
    const server = await createViteServer({ configFile: false, logLevel: "silent", plugins: [hubDatabase()], root: rootDir, server: { middlewareMode: true, watch: null } })
    try {
      // SAFETY: This fixture writes the module before Vite evaluates its public Database imports.
      const module = await server.ssrLoadModule(queryFile) as {
        query: (binding: typeof localBinding) => Promise<{ registry: Array<{ title: string }> }>
      }
      await expect(module.query(localBinding)).resolves.toEqual({ registry: [{ title: "real note" }] })
      expect(nativeQueries).toEqual([])
      expect(requests).toEqual([{
        authorization: "Bearer api-token",
        url: "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/real-database-id/raw",
      }])
      expect(warn).toHaveBeenCalledWith("[vitehub] Database \"default\" is remote: `vite dev` queries the real D1 database real-database-id over HTTP. Writes change real data.")
    }
    finally {
      await server.close()
      warn.mockRestore()
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  }, 30_000)

  it.each([true, { url: "https://d1.example.com" }] as const)("inspects inherited cloudflare.http as remote: %j", async (http) => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts")
    const plugin = hubDatabase({ cloudflare: { http }, driver: "d1" })
    await resolveConfigResolved(plugin)({ root: rootDir })
    const inspect = plugin.vitehub?.inspect
    const inspection = typeof inspect === "function" ? await inspect() : undefined
    const [definition] = await inspection!.definitions![0]!.list()
    expect(definition?.fields).toContainEqual({
      label: "Development",
      value: "Remote. `vite dev` queries the real D1 database over HTTP, so writes change real data.",
    })
  })

  it.each([true, false])("inspects a constant remote switch: %s", async (remote) => {
    const rootDir = await createTempProject()
    const file = await writeDefinition(rootDir, "server/databases/default.ts")
    await writeFile(file, [
      `const useRemote = ${remote} as const`,
      "const remote = useRemote",
      (await readFile(file, "utf8")).replace("  schema:", "  remote,\n  schema:"),
    ].join("\n"))
    const plugin = hubDatabase()
    await resolveConfigResolved(plugin)({ root: rootDir })
    const inspect = plugin.vitehub?.inspect
    const inspection = typeof inspect === "function" ? await inspect() : undefined
    const [definition] = await inspection!.definitions![0]!.list()
    expect(definition?.fields?.some(field => field.label === "Development")).toBe(remote)
  })

  it("ignores remote in builds", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", { cloudflare: "databaseId: 'real-database-id'," })
    const definition = join(rootDir, "server/databases/default.ts")
    await writeFile(definition, (await readFile(definition, "utf8")).replace("  schema:", "  remote: true,\n  schema:"))
    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const load = (plugin: ReturnType<typeof hubDatabase>) => (plugin.load as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler
    const render = async (command: "build" | "serve") => {
      const plugin = hubDatabase()
      await resolveConfigResolved(plugin)({ command, root: rootDir })
      return {
        databases: await load(plugin)(`\0${DB_VIRTUAL_DATABASES_ID}`),
        defaults: await load(plugin)("\0#vitehub/database/definition-defaults"),
      }
    }

    const build = await render("build")
    expect(build.databases).not.toContain("resolveDevRemoteConfig")
    expect(build.defaults).not.toContain("\"dev\"")
    const dev = await render("serve")
    expect(dev.databases).toContain("config: resolveDevRemoteConfig({")
    expect(dev.defaults).toContain("\"dev\":true")
  })

  it("refreshes direct Definition resource projections during Vite development hot updates", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    const requests: string[] = []
    const proxy = createHttpServer((request, response) => {
      // Other local tools can probe a new port with `GET /`. D1 HTTP calls always send a token.
      if (!request.headers.authorization) return response.end()
      requests.push(`${request.method} ${request.url}`)
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ success: true, result: [{ success: true, results: { rows: [["application note"]] } }] }))
    })
    const proxyUrl = await listenHttpServer(proxy)
    const definition = await writeDefinition(rootDir, "server/databases/default.ts")
    const queryFile = join(rootDir, "server/query.ts")
    await writeFile(queryFile, [
      "import { useDatabase } from '@vite-hub/database'",
      "import { runWithActiveCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'",
      "export const query = (binding: unknown) => runWithActiveCloudflareEnv({ HOST_DB: binding }, async () => {",
      "  const { db, schema } = useDatabase('default')",
      "  return { registry: await db.select().from(schema.notes) }",
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
    const plugin = hubDatabase({ binding: "HOST_DB", databaseId: "host-id", databaseName: "host-db", driver: "d1" })
    const server = await createViteServer({ configFile: false, plugins: [plugin], root: rootDir, server: { host: "127.0.0.1", port: 0, watch: null } })
    try {
      await server.listen()
      async function query() {
        // SAFETY: This fixture writes the module before Vite evaluates its public Database imports.
        const module = await server.ssrLoadModule(queryFile) as {
          query: (nativeBinding: typeof binding) => Promise<{ registry: Array<{ title: string }> }>
        }
        return module.query(binding)
      }
      await expect(query()).resolves.toEqual({ registry: [{ title: "host note" }] })
      expect(nativeQueries).toHaveLength(1)
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

      await expect(query()).resolves.toEqual({ registry: [{ title: "application note" }] })
      expect(nativeQueries).toEqual([])
      expect(requests).toEqual(["POST /application/raw"])
    }
    finally {
      await Promise.all([server.close(), closeHttpServer(proxy)])
    }
  }, 30_000)


  it("refreshes imported schema resources during Vite development hot updates", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    const schemaFile = join(rootDir, "server/databases/default/schema.ts")
    const definition = join(rootDir, "server/databases/default/index.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(schemaFile, [
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "export const notes = sqliteTable('notes', { title: text('title') })",
      "",
    ].join("\n"))
    await writeFile(definition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import * as tables from './schema.ts'",
      "export default defineDatabase({ schema: { ...tables } })",
      "",
    ].join("\n"))
    // The generated schema exports one binding per table for drizzle-kit. Only a refresh adds a new table there.
    const queryFile = join(rootDir, "server/query.ts")
    await writeFile(queryFile, [
      `import * as generated from ${JSON.stringify(DB_VIRTUAL_SCHEMA_ID)}`,
      "export const tables = () => Object.keys(generated).filter(key => key !== 'default' && key !== 'relations' && key !== 'schema').toSorted()",
      "",
    ].join("\n"))

    const plugin = hubDatabase()
    const server = await createViteServer({
      configFile: false,
      plugins: [plugin],
      root: rootDir,
      server: { host: "127.0.0.1", port: 0, watch: null },
    })
    try {
      await server.listen()
      async function query() {
        const module = await server.ssrLoadModule(queryFile) as { tables: () => string[] }
        return module.tables()
      }

      await expect(query()).resolves.toEqual(["notes"])

      await writeFile(schemaFile, [
        "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
        "export const notes = sqliteTable('notes', { title: text('title') })",
        "export const tasks = sqliteTable('tasks', { title: text('title') })",
        "",
      ].join("\n"))
      const changedModule = server.moduleGraph.getModuleById(schemaFile)
      if (!changedModule) throw new Error("Expected Vite to track the imported schema.")
      server.moduleGraph.invalidateModule(changedModule)
      await resolveHotUpdate(plugin)({ file: schemaFile, server })

      await expect(query()).resolves.toEqual(["notes", "tasks"])
    }
    finally {
      await server.close()
    }
  }, 30_000)

  it("exposes integration connection defaults to direct definitions", async () => {
    const plugin = hubDatabase({
      connection: {
        authToken: "token",
        url: "libsql://database.example.turso.io",
      },
    })
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ [VITEHUB_FEATURES]: { database: undefined }, root: await createTempProject() })

    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const resolveId = (plugin.resolveId as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler
    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const load = (plugin.load as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler
    const id = await resolveId("#vitehub/database/definition-defaults")

    expect(await load(id!)).toContain("libsql://database.example.turso.io")
  })

  it("resolves discovered database definitions and writes generated artifacts", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts")

    const plugin = hubDatabase()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ db: undefined, root: rootDir })

    expect(plugin.api.getConfig()).toMatchObject({
      databaseNames: ["default"],
      databases: {
        default: {
          connection: { url: "file:.vitehub/data/database/sqlite.db" },
          migrationsDir: "server/databases/default/migrations",
          mode: "default",
        },
      },
    })
    await expect(readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")).resolves.toContain("export { table_0 as notes }")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")).resolves.toContain("server/databases/default/migrations")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")).resolves.toContain("dbCredentials")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle/default.config.ts"), "utf8")).resolves.toContain("file:.vitehub/data/database/sqlite.db")
  })

  it("warns during config resolution but fails database generate when a Definition cannot load", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/default.ts")
    await writeFile(definition, `import "./missing.ts"\n${await readFile(definition, "utf8")}`)
    const warn = vi.fn()
    const spawn = vi.fn(async () => ({ exitCode: 0 }))

    const plugin = hubDatabase()
    await resolveConfigResolved(plugin)({ logger: { warn }, resolve: { alias: [] }, root: rootDir })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("The Database Definition \""))
    await expect(readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")).resolves.toContain("export { table_0 as notes }")
    const generate = (await resolveCliContributor(plugin))!.namespaces[0]!.features.find(feature => feature.name === "generate")!
    await expect(generate.run([], {
      rootDir,
      spawn,
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    } as never)).rejects.toMatchObject({ code: "DATABASE_SCHEMA_LOAD_FAILED" })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("emits prototype-named databases as own virtual registry entries", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "src/__proto__.database.ts")
    const plugin = hubDatabase(undefined)
    await resolveConfigResolved(plugin)({ root: rootDir })

    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const resolveId = (plugin.resolveId as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler
    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const load = (plugin.load as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler
    const code = await load((await resolveId(DB_VIRTUAL_DATABASES_ID))!)
    const evaluable = code!.replace(/^import .+$/gm, "").replace("export const databases", "const databases").replace("export default databases", "return databases")
    const registry = new Function("definition_0", "schema_0", "relations_0", "resolveRuntimeCloudflareConfig", evaluable)({ name: "__proto__", schema: {} }, { notes: "schema-marker" }, { notes: "relations-marker" }, (value: unknown) => value) as Record<string, { relations: unknown, schema: unknown }>

    expect(Object.hasOwn(registry, "__proto__")).toBe(true)
    expect(registry["__proto__"]?.schema).toEqual({ notes: "schema-marker" })
    expect(registry["__proto__"]?.relations).toEqual({ notes: "relations-marker" })
  })

  it("resolves discovery and generated artifacts from projectRoot", async () => {
    const rootDir = await createTempProject()
    const projectRoot = join(rootDir, "packages", "db")
    await writeDefinition(projectRoot, "server/databases/default.ts")

    const plugin = hubDatabase({ projectRoot: "packages/db" })
    // SAFETY: The test invokes Vite's config hook with its documented arguments.
    const configure = plugin.config as (config: unknown, env: unknown) => void
    configure({ [VITEHUB_SERVER_DIRS]: [join(rootDir, "server")] }, { command: "serve", mode: "test" })
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ [VITEHUB_FEATURES]: { database: undefined }, root: rootDir })

    expect(plugin.api.getConfig()?.rootDir).toBe(projectRoot)
    await expect(readFile(join(projectRoot, ".vitehub/database/schema/default.ts"), "utf8"))
      .resolves.toContain("export { table_0 as notes }")
  })

  it("reads provision state from the Vite root when projectRoot is nested", async () => {
    const rootDir = await createTempProject()
    const databaseRoot = join(rootDir, "packages", "db")
    await writeDefinition(databaseRoot, "server/databases/default.ts", "notes", { cloudflare: "databaseName: 'database-name'," })
    await mkdir(join(rootDir, ".vitehub"))
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "provisioned-database-id" } } }))
    await mkdir(join(databaseRoot, ".vitehub"))
    await writeFile(join(databaseRoot, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "unrelated-nested-id" } } }))

    const plugin = hubDatabase({ projectRoot: "packages/db" })
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ [VITEHUB_FEATURES]: { database: undefined }, root: rootDir })

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
  })

  it("writes one Drizzle config per named database migrations directory", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/analytics/index.ts", "events")
    await writeDefinition(rootDir, "server/databases/primary/index.ts", "notes")

    const plugin = hubDatabase()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ db: undefined, root: rootDir })

    const analyticsConfig = await readFile(join(rootDir, ".vitehub/database/drizzle/analytics.config.ts"), "utf8")
    const primaryConfig = await readFile(join(rootDir, ".vitehub/database/drizzle/primary.config.ts"), "utf8")

    expect(analyticsConfig).not.toContain("import databaseDefinition")
    expect(analyticsConfig).toContain("server/databases/analytics/migrations")
    expect(analyticsConfig).toContain("file:.vitehub/data/database/analytics.sqlite.db")
    expect(primaryConfig).not.toContain("import databaseDefinition")
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
      await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: process.env.TURSO_DATABASE_URL,",
        ].join("\n"),
      })

      const plugin = hubDatabase()
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
      await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
        cloudflare: [
          "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
          "    http: true,",
        ].join("\n"),
      })

      const plugin = hubDatabase()
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
    await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
      cloudflare: "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
      connection: [
        "    authToken: 'libsql-token',",
        "    url: 'libsql://database.example.turso.io',",
      ].join("\n"),
    })

    const plugin = hubDatabase()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ db: undefined, root: rootDir })

    const drizzleConfig = await readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")
    expect(drizzleConfig).toContain("url: \"libsql://database.example.turso.io\"")
    expect(drizzleConfig).toContain("authToken: \"libsql-token\"")
    expect(drizzleConfig).not.toContain("driver: \"d1-http\"")
  })

  it("writes snake_case columns of snakeCase tables into migration folders and queries", async () => {
    await mkdir(join(import.meta.dirname, "../../../.vitest-tmp"), { recursive: true })
    const rootDir = await mkdtemp(join(import.meta.dirname, "../../../.vitest-tmp/drizzle-casing-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server/databases/default"), { recursive: true })
    await writeFile(join(rootDir, "server/databases/default/schema.ts"), [
      "import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core'",
      "export const userProfiles = snakeCase.table('user_profiles', {",
      "  id: integer().primaryKey(),",
      "  displayName: text().notNull(),",
      "})",
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "server/databases/default/index.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { userProfiles } from './schema.ts'",
      "export default defineDatabase({ schema: { userProfiles } })",
      "",
    ].join("\n"))

    await resolveConfigResolved(hubDatabase())({ root: rootDir })
    await mkdir(join(rootDir, ".vitehub/data/database"), { recursive: true })
    for (const command of ["generate", "migrate"]) {
      await execFileAsync(process.execPath, [
        join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
        command,
        "--config",
        ".vitehub/database/drizzle.config.ts",
      ], { cwd: rootDir })
    }

    const migrationsDir = join(rootDir, "server/databases/default/migrations")
    const [folder] = await readdir(migrationsDir)
    expect(folder).toMatch(/^\d{14}_/)
    const migration = await readFile(join(migrationsDir, folder!, "migration.sql"), "utf8")
    expect(migration).toContain("`display_name` text NOT NULL")
    expect(migration).not.toContain("displayName")

    const { userProfiles } = await import(join(rootDir, "server/databases/default/schema.ts"))
    const client = createClient({ url: `file:${join(rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      const db = drizzle({ client })
      await db.insert(userProfiles).values({ displayName: "Ada", id: 1 })
      await expect(db.select().from(userProfiles)).resolves.toEqual([{ displayName: "Ada", id: 1 }])
    }
    finally {
      client.close()
    }
  })

  it("routes several databases to their own Drizzle configs", async () => {
    await mkdir(join(import.meta.dirname, "../../../.vitest-tmp"), { recursive: true })
    const rootDir = await mkdtemp(join(import.meta.dirname, "../../../.vitest-tmp/drizzle-several-databases-"))
    tempDirs.push(rootDir)
    // Both Databases use snake_case tables, so only the per-Database credentials and migrations tell them apart.
    for (const name of ["accounts", "billing"] as const) {
      await mkdir(join(rootDir, "server/databases", name), { recursive: true })
      await writeFile(join(rootDir, "server/databases", name, "index.ts"), [
        "import { defineDatabase } from '@vite-hub/database'",
        "import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core'",
        `const ${name} = snakeCase.table('${name}', { id: integer().primaryKey(), displayName: text().notNull() })`,
        "export default defineDatabase({",
        `  name: '${name}',`,
        `  name: '${name}',`,
        `  schema: { ${name} },`,
        "})",
        "",
      ].join("\n"))
    }

    await resolveConfigResolved(hubDatabase())({ root: rootDir })
    const generate = (config: string) => execFileAsync(process.execPath, [
      join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
      "generate",
      "--config",
      config,
    ], { cwd: rootDir })

    await expect(generate(".vitehub/database/drizzle.config.ts")).rejects.toMatchObject({
      stderr: expect.stringContaining("more than one Database"),
    })
    for (const name of ["accounts", "billing"]) {
      await generate(`.vitehub/database/drizzle/${name}.config.ts`)
      const migrationsDir = join(rootDir, "server/databases", name, "migrations")
      const [folder] = await readdir(migrationsDir)
      const migration = await readFile(join(migrationsDir, folder!, "migration.sql"), "utf8")
      expect(migration).toContain(`CREATE TABLE \`${name}\``)
      expect(migration).toContain("`display_name` text NOT NULL")
      expect(migration).not.toContain(name === "accounts" ? "`billing`" : "`accounts`")
    }
  })

  it("uses and inspects the implicit default Database when the app has no Database Definition", async () => {
    const rootDir = await createTempProject()

    const plugin = hubDatabase({ connection: { url: "file:/data/database/sqlite.db" } })
    await resolveConfigResolved(plugin)({ root: rootDir })

    expect(plugin.api.getConfig()?.databases.default).toMatchObject({
      connection: { url: "file:/data/database/sqlite.db" },
      migrationsDir: "server/databases/default/migrations",
    })
    const inspect = plugin.vitehub?.inspect
    const inspection = typeof inspect === "function" ? await inspect() : undefined
    const [definition] = await inspection!.definitions![0]!.list()
    expect(definition).toMatchObject({ name: "default", source: "implicit-default" })
    expect(definition?.fields).toContainEqual(expect.objectContaining({ label: "Definition", value: expect.stringContaining("Implicit") }))
  })

  it("lets top-level config disable the database plugin", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts")

    const plugin = hubDatabase(false)
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ root: rootDir })

    expect(plugin.api.getConfig()).toBeUndefined()
  })

  it("does not contribute the DB CLI namespace when top-level config disables the database plugin", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts")

    const plugin = hubDatabase(false)
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ root: rootDir })

    await expect(resolveCliContributor(plugin)).resolves.toBeUndefined()
  })

  it("contributes provisioning but no CLI namespaces when resolved config disables database CLI", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/default.ts")

    const plugin = hubDatabase({ cli: false })
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ root: rootDir })

    const contributor = await resolveCliContributor(plugin)
    expect(contributor?.namespaces).toEqual([])
    expect(contributor?.provision?.map(step => step.id)).toEqual(["database:cloudflare-d1"])
  })

  it("exposes default schema and database registry through stable ViteHub import paths", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/default.ts")

    const plugin = hubDatabase()
    const configResolved = resolveConfigResolved(plugin)
    await configResolved({ root: rootDir })

    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const resolveId = (plugin.resolveId as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler
    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const load = (plugin.load as { handler: (id: string) => string | undefined | Promise<string | undefined> }).handler

    const resolvedSchemaId = await resolveId(DB_VIRTUAL_SCHEMA_ID)
    const resolvedDatabasesId = await resolveId(DB_VIRTUAL_DATABASES_ID)
    const schemaCode = await load(resolvedSchemaId!)
    const databasesCode = await load(resolvedDatabasesId!)

    expect(schemaCode).toContain("export { default, schema }")
    expect(schemaCode).toContain(join(rootDir, ".vitehub/database/schema/default.ts"))
    expect(databasesCode).toContain(definition)
    expect(databasesCode).toContain("\"default\"")
    expect(databasesCode).toContain("\"server/databases/default/migrations\"")
    const generatedTypesFile = join(rootDir, ".vitehub/types/database.d.ts")
    const generatedTypes = await readFile(generatedTypesFile, "utf8")
    expect(generatedTypes).toContain('declare module "@vite-hub/database"')
    expect(generatedTypes).toContain('declare module "vite-hub/database"')
    expect(generatedTypes).toContain("type DefaultDatabaseSchema = typeof database_0.schema")
    expect(generatedTypes).toContain('declare module "#vitehub/database/schema" {\n  interface DatabaseSchema extends DefaultDatabaseSchema {}')

    await resolveConfigResolved(hubDatabase(false))({ root: rootDir })
    await expect(readFile(generatedTypesFile, "utf8")).resolves.toBe("export {}\n")
  })

  it("refreshes cached direct Definition defaults when HMR changes resource ownership", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
      cloudflare: "binding: 'HOST_DB', databaseId: 'application-id', databaseName: 'application',",
    })
    const plugin = hubDatabase({ driver: "d1", binding: "HOST_DB", databaseId: "host-id", databaseName: "host" })
    const server = await createViteServer({
      configFile: false,
      plugins: [plugin],
      root: rootDir,
      server: { hmr: false, middlewareMode: true, watch: null },
    })
    const runtimeFile = resolve(import.meta.dirname, "../src/runtime/definition-config.ts")
    const evaluatedDefinition = {
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

      await writeDefinition(rootDir, "server/databases/default.ts", "notes", {
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
    const definition = await writeDefinition(rootDir, "server/databases/default.ts")

    const invalidated: string[] = []
    const plugin = hubDatabase()
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
    await expect(readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")).resolves.toContain("export { table_0 as tasks }")
  })

  it("normalizes definition paths before matching hot updates", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/default.ts")

    const invalidated: string[] = []
    const plugin = hubDatabase()
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
