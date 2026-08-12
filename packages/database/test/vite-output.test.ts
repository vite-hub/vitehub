import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"
import { createDefaultCloudflareOutputRoot, getProviderRuntimeModule, type ComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"

import { prepareProviderOutputs as prepareDatabaseProviderOutputs } from "../src/internal/vite-build.ts"

import type { ResolvedDBViteConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []

function resolvePlaygroundNodeModules() {
  const nodeModules = join(playgroundDir, "node_modules")
  return existsSync(nodeModules) ? nodeModules : resolve(playgroundDir, "../../node_modules")
}

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  const workspacePackagesDir = resolve(playgroundDir, "../../packages")
  await mkdir(baseDir, { recursive: true })
  if (!existsSync(join(baseDir, "packages"))) {
    await symlink(workspacePackagesDir, join(baseDir, "packages"), "dir")
  }
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDatabaseDefinition(rootDir: string, name: string, options: {
  cloudflare?: string
  connection?: string
  table?: string
} = {}) {
  const file = join(rootDir, "server", "databases", name, "config.ts")
  const table = options.table ?? `${name}Items`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${table} = sqliteTable('${name}_items', { title: text('title') })`,
    "export default defineDatabase({",
    `  name: ${JSON.stringify(name)},`,
    ...(options.connection ? ["  connection: {", options.connection, "  },"] : []),
    ...(options.cloudflare ? ["  cloudflare: {", options.cloudflare, "  },"] : []),
    `  schema: { ${table} },`,
    "})",
    "",
  ].join("\n"))
}

async function createDbBuildProject(prefix: string, options: { integrationConnection?: boolean, nitro?: boolean } = {}) {
  const rootDir = await createWorkspaceTempDir(prefix)
  const nodeModules = resolvePlaygroundNodeModules()
  await mkdir(join(rootDir, "src"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")
  await writeFile(join(rootDir, "package.json"), "{\"type\":\"module\"}\n")
  await writeFile(join(rootDir, "src/server.ts"), [
    "import { databases, useDatabase } from '@vite-hub/database/drizzle'",
    "export default {",
    "  fetch: () => new Response([Object.keys(databases), Object.keys(useDatabase('primary').schema)].join(':')),",
    "}",
    "",
  ].join("\n"))
  await writeFile(join(rootDir, "vite.config.ts"), [
    "import { resolve } from 'node:path'",
    "import { defineConfig } from 'vite'",
    "import { hubDb } from '@vite-hub/database/vite'",
    "export default defineConfig({",
    "  appType: 'custom',",
    "  build: {",
    "    outDir: 'dist/client',",
    "    rollupOptions: { input: resolve(import.meta.dirname, 'src/server.ts') },",
    "    ssr: true,",
    "  },",
    ...(options.integrationConnection
      ? [
          `  plugins: [${options.nitro ? "{ name: 'nitro:main' }, " : ""}hubDb({`,
          "    connection: {",
          "      authToken: { kind: 'env-variable', source: { kind: 'env', name: 'TURSO_AUTH_TOKEN' } },",
          "      url: { kind: 'env-variable', source: { kind: 'env', name: 'TURSO_DATABASE_URL' } },",
          "    },",
          "  })],",
        ]
      : [`  plugins: [${options.nitro ? "{ name: 'nitro:main' }, " : ""}hubDb()],`]),
    "})",
    "",
  ].join("\n"))
  await writeDatabaseDefinition(rootDir, "primary", {
    cloudflare: [
      "    binding: 'DB_PRIMARY',",
      "    databaseName: process.env.VITEHUB_D1_DATABASE_NAME || 'vitehub-playground-db',",
      "    databaseId: process.env.VITEHUB_D1_DATABASE_ID,",
      "    previewDatabaseId: process.env.VITEHUB_D1_PREVIEW_DATABASE_ID,",
    ].join("\n"),
    ...(!options.integrationConnection
      ? {
          connection: [
            "    authToken: process.env.TURSO_AUTH_TOKEN,",
            "    url: process.env.TURSO_DATABASE_URL,",
          ].join("\n"),
        }
      : {}),
  })
  await writeDatabaseDefinition(rootDir, "analytics", {
    cloudflare: [
      "    binding: 'DB_ANALYTICS',",
      "    databaseName: process.env.VITEHUB_D1_ANALYTICS_DATABASE_NAME || 'vitehub-playground-analytics',",
      "    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
      "    previewDatabaseId: process.env.VITEHUB_D1_ANALYTICS_PREVIEW_DATABASE_ID,",
    ].join("\n"),
    ...(!options.integrationConnection
      ? {
          connection: [
            "    authToken: process.env.TURSO_AUTH_TOKEN,",
            "    url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,",
          ].join("\n"),
        }
      : {}),
  })
  return rootDir
}

function createRuntimeConfig(rootDir: string, database: Record<string, unknown>): ResolvedDBViteConfig {
  return {
    databaseNames: ["primary"],
    databases: {
      primary: {
        connection: {},
        drizzle: {},
        migrationsDir: "server/databases/primary/migrations",
        ...database,
      },
    },
    definitions: [{
      handler: join(rootDir, "server", "databases", "primary", "config.ts"),
      name: "primary",
    }],
    generatedConfigFile: join(rootDir, ".vitehub", "database", "drizzle.config.ts"),
    generatedConfigFiles: [],
    generatedConfigFilesByDatabase: {},
    generatedSchemaFile: join(rootDir, ".vitehub", "database", "schema.ts"),
    generatedSchemaFilesByDatabase: {
      primary: join(rootDir, ".vitehub", "database", "primary-schema.ts"),
    },
  } as unknown as ResolvedDBViteConfig
}

async function createDbBlobBuildProject(prefix: string, plugins: string) {
  const rootDir = await createDbBuildProject(prefix)
  await writeFile(join(rootDir, "src/server.ts"), [
    "import { blob } from '@vite-hub/blob'",
    "import { databases } from '@vite-hub/database/drizzle'",
    "export default {",
    "  async fetch() {",
    "    const [putError] = await blob.put('proof.txt', Object.keys(databases).join(','))",
    "    if (putError) throw putError",
    "    const [getError, object] = await blob.get('proof.txt')",
    "    if (getError) throw getError",
    "    return new Response(await object?.text())",
    "  },",
    "}",
    "",
  ].join("\n"))
  await writeFile(join(rootDir, "vite.config.ts"), [
    "import { resolve } from 'node:path'",
    "import { defineConfig } from 'vite'",
    "import { hubBlob } from '@vite-hub/blob/vite'",
    "import { hubDb } from '@vite-hub/database/vite'",
    "export default defineConfig({",
    "  appType: 'custom',",
    "  build: {",
    "    outDir: 'dist/client',",
    "    rollupOptions: { input: resolve(import.meta.dirname, 'src/server.ts') },",
    "    ssr: true,",
    "  },",
    `  plugins: [${plugins}],`,
    "})",
    "",
  ].join("\n"))
  return rootDir
}

async function createBlobBuildProject(prefix: string) {
  const rootDir = await createWorkspaceTempDir(prefix)
  const nodeModules = resolvePlaygroundNodeModules()
  await mkdir(join(rootDir, "src"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")
  await writeFile(join(rootDir, "package.json"), "{\"type\":\"module\"}\n")
  await writeFile(join(rootDir, "src/server.ts"), [
    "import { blob } from '@vite-hub/blob'",
    "import { databases } from '@vite-hub/database/drizzle'",
    "export default {",
    "  async fetch() {",
    "    const [putError] = await blob.put('proof.txt', Object.keys(databases).join(','))",
    "    if (putError) throw putError",
    "    const [getError, object] = await blob.get('proof.txt')",
    "    if (getError) throw getError",
    "    return new Response(await object?.text())",
    "  },",
    "}",
    "",
  ].join("\n"))
  await writeFile(join(rootDir, "vite.config.ts"), [
    "import { resolve } from 'node:path'",
    "import { defineConfig } from 'vite'",
    "import { hubBlob } from '@vite-hub/blob/vite'",
    "export default defineConfig({",
    "  appType: 'custom',",
    "  build: {",
    "    outDir: 'dist/client',",
    "    rollupOptions: { input: resolve(import.meta.dirname, 'src/server.ts') },",
    "    ssr: true,",
    "  },",
    "  plugins: [hubBlob({ driver: 'cloudflare-r2', bucketName: 'assets' })],",
    "})",
    "",
  ].join("\n"))
  return rootDir
}

async function writeStaleRuntimeFiles(rootDir: string, product: string, code: string) {
  for (const provider of ["cloudflare", "vercel"]) {
    const file = join(rootDir, ".vitehub", product, `${provider}-runtime.mjs`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, code, "utf8")
  }
}

async function runDbBuild(rootDir: string, env: NodeJS.ProcessEnv = {}) {
  return execFileAsync("vp", ["build"], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env,
      VITEHUB_VITE_MODE: "db",
    },
  })
}

async function readCloudflareConfig(rootDir: string) {
  const distDir = join(rootDir, "dist")
  const entries = await readdir(distDir)
  const outputDir = entries.find(entry => entry !== "client")
  if (!outputDir) throw new Error("Cloudflare output directory was not generated.")
  return JSON.parse(await readFile(join(distDir, outputDir, "wrangler.json"), "utf8"))
}

async function readCloudflareWorker(rootDir: string) {
  const distDir = join(rootDir, "dist")
  const entries = await readdir(distDir)
  const outputDir = entries.find(entry => entry !== "client")
  if (!outputDir) throw new Error("Cloudflare output directory was not generated.")
  return await readFile(join(distDir, outputDir, "index.js"), "utf8")
}

function errorText(error: unknown) {
  return (error as { stderr?: string; message?: string } | undefined)?.stderr
    || (error as { message?: string } | undefined)?.message
    || String(error)
}

function outputText(output: Awaited<ReturnType<typeof runDbBuild>>) {
  return `${output.stdout}\n${output.stderr}`
}

function expectNoRuntimeImport(code: string, specifier: string) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  expect(code).not.toMatch(new RegExp(`\\b(?:from\\s+|import\\(|require\\()["']${escaped}["']`))
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP server address.")
  return `http://127.0.0.1:${address.port}`
}

async function close(server: ReturnType<typeof createServer>) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite db provider outputs", () => {
  it("resolves the hosted application entry from the Vite root", async () => {
    const appRootDir = await createWorkspaceTempDir("vitehub-db-vite-app-root-")
    const rootDir = join(appRootDir, "packages", "db")
    await mkdir(rootDir, { recursive: true })
    await mkdir(join(appRootDir, "src"), { recursive: true })
    await writeFile(join(appRootDir, "src", "server.ts"), "export default { fetch: () => new Response('app') }\n")

    const artifacts = await prepareDatabaseProviderOutputs({
      appRootDir,
      rootDir,
      runtimeConfig: createRuntimeConfig(rootDir, {}),
    })

    await expect(readFile(artifacts.cloudflareWorkerFile, "utf8"))
      .resolves.toContain("server.ts")
  })

  it("registers D1 HTTP as a supported Vercel database runtime", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-db-vite-vercel-registry-")
    const providerOutput = { runtimeModuleFilesByProduct: {} } satisfies ComposedProviderOutput

    await prepareDatabaseProviderOutputs({
      providerOutput,
      rootDir,
      runtimeConfig: createRuntimeConfig(rootDir, {
        cloudflare: {
          binding: "DB_PRIMARY",
          databaseId: "primary-d1-id",
          databaseName: "primary",
          http: true,
        },
      }),
    })

    expect(getProviderRuntimeModule(providerOutput, "database", "cloudflare")).toContain("cloudflare-runtime.mjs")
    expect(getProviderRuntimeModule(providerOutput, "database", "cloudflare-definition-defaults")).toContain("definition-defaults.mjs")
    expect(getProviderRuntimeModule(providerOutput, "database", "vercel")).toContain("vercel-runtime.mjs")
    expect(getProviderRuntimeModule(providerOutput, "database", "vercel-definition-defaults")).toContain("definition-defaults.mjs")
  })

  it("composes direct Blob and Database provider output in either plugin order", async () => {
    for (const [label, plugins] of [
      ["blob-db", "hubBlob({ driver: 'cloudflare-r2', bucketName: 'assets' }), hubDb()"],
      ["db-blob", "hubDb(), hubBlob({ driver: 'cloudflare-r2', bucketName: 'assets' })"],
    ]) {
      const rootDir = await createDbBlobBuildProject(`vitehub-db-blob-${label}-`, plugins)

      await runDbBuild(rootDir, {
        TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
        TURSO_AUTH_TOKEN: "token",
        TURSO_DATABASE_URL: "libsql://database.example.turso.io",
        VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
        VITEHUB_D1_DATABASE_ID: "primary-d1-id",
      })

      const cloudflareConfig = await readCloudflareConfig(rootDir)
      const cloudflareWorker = await readCloudflareWorker(rootDir)
      const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
      const vercelServerCode = await readFile(vercelServer, "utf8")

      expect(cloudflareConfig.r2_buckets).toContainEqual({ binding: "BLOB", bucket_name: "assets" })
      expect(cloudflareConfig.d1_databases).toHaveLength(2)
      expectNoRuntimeImport(cloudflareWorker, "@vite-hub/blob")
      expectNoRuntimeImport(cloudflareWorker, "@vite-hub/database/drizzle")
      expectNoRuntimeImport(vercelServerCode, "@vite-hub/blob")
      expectNoRuntimeImport(vercelServerCode, "@vite-hub/database/drizzle")
    }
  }, 60_000)

  it("ignores stale sibling runtime files that were not prepared in the current build", async () => {
    const staleDatabaseMarker = "stale_database_runtime_marker"
    const blobRootDir = await createBlobBuildProject("vitehub-blob-stale-db-runtime-")
    await writeStaleRuntimeFiles(blobRootDir, "database", [
      `export const databases = { ${staleDatabaseMarker}: true }`,
      "export const db = {}",
      "export const schema = {}",
      "",
    ].join("\n"))

    let blobError: Error | undefined
    try {
      await runDbBuild(blobRootDir)
    }
    catch (caught) {
      blobError = caught as Error
    }

    expect(errorText(blobError)).toContain('Could not resolve "node:path"')
    expect(errorText(blobError)).not.toContain(staleDatabaseMarker)

    const staleBlobMarker = "stale_blob_runtime_marker"
    const dbRootDir = await createDbBuildProject("vitehub-db-stale-blob-runtime-")
    await writeFile(join(dbRootDir, "src/server.ts"), [
      "import { blob } from '@vite-hub/blob'",
      "import { databases } from '@vite-hub/database/drizzle'",
      "export default {",
      "  fetch: () => new Response(`${Object.keys(databases).join(',')}:${String((blob as any).runtimeFlag)}`),",
      "}",
      "",
    ].join("\n"))
    await writeStaleRuntimeFiles(dbRootDir, "blob", [
      `export const blob = { runtimeFlag: ${JSON.stringify(staleBlobMarker)} }`,
      "export const ensureBlob = () => blob",
      "",
    ].join("\n"))

    await runDbBuild(dbRootDir, {
      TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    })

    const dbCloudflareWorker = await readCloudflareWorker(dbRootDir)
    const dbVercelServer = await readFile(join(dbRootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(dbCloudflareWorker).not.toContain(staleBlobMarker)
    expect(dbVercelServer).not.toContain(staleBlobMarker)
  }, 60_000)

  it("builds and emits named database Cloudflare and Vercel outputs", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-output-")

    const output = await runDbBuild(rootDir, {
      TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    })
    expect(outputText(output)).not.toMatch(/Duplicate key "(?:cloudflare|connection|url|drizzle)"/)

    const cloudflareConfig = await readCloudflareConfig(rootDir)
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")

    expect(cloudflareConfig.d1_databases).toEqual([
      expect.objectContaining({
        binding: "DB_ANALYTICS",
        database_id: "analytics-d1-id",
        database_name: "vitehub-playground-analytics",
      }),
      expect.objectContaining({
        binding: "DB_PRIMARY",
        database_id: "primary-d1-id",
        database_name: "vitehub-playground-db",
      }),
    ])
    expect(existsSync(vercelServer)).toBe(true)
    const bundledServerCode = await readFile(join(rootDir, "dist/client/server.js"), "utf8")
    expect(bundledServerCode.includes("\"analytics\"")).toBe(true)
    expect(bundledServerCode.includes("\"primary\"")).toBe(true)
    expect(bundledServerCode.includes("runtime/virtual-databases.js")).toBe(false)
    expect(bundledServerCode.includes("var databases$1 = {};")).toBe(false)

    const cloudflareRuntime = await readFile(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"), "utf8")
    expect(cloudflareRuntime).toContain("export const agentDb = createAgentDatabase(databases)")
    expect(cloudflareRuntime).toContain("export function useDatabase(name) { return databases[name] }")

    const vercelServerCode = await readFile(vercelServer, "utf8")
    expect(vercelServerCode).toContain("process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL")
    expect(vercelServerCode).toContain("process.env.TURSO_DATABASE_URL")
    expect(vercelServerCode).not.toContain("libsql://analytics.example.turso.io")
    expect(vercelServerCode).not.toContain("libsql://database.example.turso.io")
  }, 30_000)

  it("builds Vercel output from an integration-level external connection", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-external-", { integrationConnection: true })

    await runDbBuild(rootDir, {
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    })

    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    expect(existsSync(vercelServer)).toBe(true)
    const code = await readFile(vercelServer, "utf8")
    expect(code).toContain("TURSO_DATABASE_URL")
    expect(code).toContain("TURSO_AUTH_TOKEN")
  }, 30_000)

  it("runs a D1-backed database through generated Vercel output", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-vercel-invalid-")
    await writeDatabaseDefinition(rootDir, "analytics", {
      cloudflare: [
        "    binding: 'DB_ANALYTICS',",
        "    databaseName: 'vitehub-playground-analytics',",
        "    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
        "    http: {",
        "      authToken: process.env.VITEHUB_D1_HTTP_TOKEN,",
        "      url: process.env.VITEHUB_D1_HTTP_URL,",
        "    },",
      ].join("\n"),
    })
    await writeFile(join(rootDir, "src/server.ts"), [
      "import { databases } from '@vite-hub/database/drizzle'",
      "export default {",
      "  async fetch() {",
      "    const { db, schema } = databases.analytics",
      "    return Response.json(await db.select().from(schema.analyticsItems))",
      "  },",
      "}",
      "",
    ].join("\n"))

    await runDbBuild(rootDir, {
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
      VITEHUB_D1_HTTP_TOKEN: "proxy-secret-value",
      VITEHUB_D1_HTTP_URL: "https://d1.example.com/raw",
    })

    const cloudflareConfig = await readCloudflareConfig(rootDir)
    expect(cloudflareConfig.d1_databases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: "DB_ANALYTICS",
        database_id: "analytics-d1-id",
        database_name: "vitehub-playground-analytics",
      }),
    ]))
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    expect(existsSync(vercelServer)).toBe(true)
    const code = await readFile(vercelServer, "utf8")
    expect(code).toContain("VITEHUB_D1_HTTP_TOKEN")
    expect(code).toContain("VITEHUB_D1_HTTP_URL")
    expect(code).toContain("VITEHUB_D1_ANALYTICS_DATABASE_ID")
    expect(code).not.toContain("proxy-secret-value")
    expect(code).not.toContain("https://d1.example.com/raw")

    let proxyRequest: { authorization?: string, body?: unknown } = {}
    const proxy = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      proxyRequest = {
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      }
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({
        result: [{ results: { rows: [["page-view"]] }, success: true }],
        success: true,
      }))
    })
    const app = createServer()
    const originalDatabaseId = process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID
    const originalToken = process.env.VITEHUB_D1_HTTP_TOKEN
    const originalUrl = process.env.VITEHUB_D1_HTTP_URL

    try {
      process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID = "analytics-d1-id"
      process.env.VITEHUB_D1_HTTP_TOKEN = "runtime-proxy-token"
      process.env.VITEHUB_D1_HTTP_URL = await listen(proxy)
      const handler = (await import(`${pathToFileURL(vercelServer).href}?t=${Date.now()}`)).default
      app.on("request", (request, response) => void Promise.resolve(handler(request, response)).catch((error) => {
        response.statusCode = 500
        response.end(String(error))
      }))
      const appUrl = await listen(app)

      const response = await fetch(appUrl)
      await expect(response.json()).resolves.toEqual([{ title: "page-view" }])
      expect(proxyRequest).toMatchObject({
        authorization: "Bearer runtime-proxy-token",
        body: { params: [], sql: expect.stringContaining("analytics_items") },
      })
    }
    finally {
      await Promise.all([close(app), close(proxy)])
      if (typeof originalDatabaseId === "undefined") delete process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID
      else process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID = originalDatabaseId
      if (typeof originalToken === "undefined") delete process.env.VITEHUB_D1_HTTP_TOKEN
      else process.env.VITEHUB_D1_HTTP_TOKEN = originalToken
      if (typeof originalUrl === "undefined") delete process.env.VITEHUB_D1_HTTP_URL
      else process.env.VITEHUB_D1_HTTP_URL = originalUrl
    }
  }, 30_000)

  it("preserves Nitro Vercel output while emitting an isolated D1 database function", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-nitro-d1-", { nitro: true })
    await writeDatabaseDefinition(rootDir, "analytics", {
      cloudflare: [
        "    binding: 'DB_ANALYTICS',",
        "    databaseName: 'vitehub-playground-analytics',",
        "    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
        "    http: true,",
      ].join("\n"),
    })
    const outputRoot = join(rootDir, ".vercel", "output")
    const nitroFunction = join(outputRoot, "functions", "__server.func", "index.mjs")
    const nitroConfig = {
      routes: [{ src: "/(.*)", dest: "/__server" }],
      version: 3,
    }
    await mkdir(dirname(nitroFunction), { recursive: true })
    await writeFile(nitroFunction, "export default 'nitro'\n", "utf8")
    await writeFile(join(outputRoot, "config.json"), `${JSON.stringify(nitroConfig, null, 2)}\n`, "utf8")

    await runDbBuild(rootDir, {
      NITRO_PRESET: "vercel",
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    })

    await expect(readFile(nitroFunction, "utf8")).resolves.toBe("export default 'nitro'\n")
    await expect(readFile(join(outputRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual(nitroConfig)
    const databaseFunction = join(outputRoot, "functions", "__database.func", "index.mjs")
    expect(existsSync(databaseFunction)).toBe(true)
    await expect(readFile(databaseFunction, "utf8")).resolves.toContain("CLOUDFLARE_ACCOUNT_ID")
  }, 30_000)

  it("skips provider output for local-only databases", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-local-only-")
    await rm(join(rootDir, "server", "databases", "analytics"), { force: true, recursive: true })
    await writeDatabaseDefinition(rootDir, "primary")

    await runDbBuild(rootDir)

    const distEntries = await readdir(join(rootDir, "dist"))
    expect(distEntries).toEqual(["client"])
    expect(existsSync(join(rootDir, ".vercel", "output"))).toBe(false)
  }, 30_000)

  it("skips Cloudflare output when a Vercel D1 HTTP database has no Cloudflare database name", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-cloudflare-invalid-")
    const staleCloudflareOutput = join(createDefaultCloudflareOutputRoot(rootDir), "index.js")
    await mkdir(dirname(staleCloudflareOutput), { recursive: true })
    await writeFile(staleCloudflareOutput, "export default 'stale'\n")
    await writeDatabaseDefinition(rootDir, "analytics", {
      cloudflare: [
        "    binding: 'DB_ANALYTICS',",
        "    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
        "    http: true,",
      ].join("\n"),
      connection: [
        "    authToken: process.env.TURSO_AUTH_TOKEN,",
        "    url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,",
      ].join("\n"),
    })

    await runDbBuild(rootDir, {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "api-token",
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    })

    expect(existsSync(staleCloudflareOutput)).toBe(false)
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"))).toBe(true)
  }, 30_000)
})
