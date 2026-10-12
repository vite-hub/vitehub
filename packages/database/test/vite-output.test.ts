import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterAll, describe, expect, it, vi } from "vitest"
import { build as buildWorker } from "esbuild"
import { contributeProviderRuntime, createDefaultCloudflareOutputRoot, createProviderOutputCatalog, getProviderRuntimeModule } from "@vite-hub/internal/build/deployment-output"

import { generateProviderOutputs as generateDatabaseProviderOutputs, prepareProviderOutputs as prepareDatabaseProviderOutputs } from "../src/internal/vite-build.ts"
import { renderDatabaseConfigExpression } from "../src/internal/runtime-config-expression.ts"
import { resolveDBViteConfig } from "../src/config.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"

import type { ResolvedDBViteConfig, RuntimeDrizzleDatabaseConfig } from "../src/types.ts"

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
    "    rolldownOptions: {",
    "      external: ['@vite-hub/blob', '@vite-hub/database/drizzle'],",
    "      input: resolve(import.meta.dirname, 'src/server.ts'),",
    "    },",
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

function createRuntimeConfig(rootDir: string, database: Pick<RuntimeDrizzleDatabaseConfig, "cloudflare" | "connection">): ResolvedDBViteConfig {
  const migrationsDir = "server/databases/primary/migrations"
  const generatedSchemaFile = join(rootDir, ".vitehub", "database", "primary-schema.ts")
  const handler = join(rootDir, "server", "databases", "primary", "config.ts")
  const cloudflare = database.cloudflare ? { binding: "DB_PRIMARY", ...database.cloudflare, migrationsDir } : undefined
  return {
    databaseNames: ["primary"],
    databases: {
      primary: {
        connection: {},
        dialect: "sqlite",
        drizzle: {},
        generatedSchemaFile,
        migrationsDir,
        mode: "named",
        name: "primary",
        orm: "drizzle",
        ...database,
        cloudflare,
      },
    },
    definitionDefaults: { cloudflareProjections: { primary: { resource: database.cloudflare ? "configured" : "inherited" } } },
    definitions: [{
      handler,
      mode: "named",
      name: "primary",
      source: handler,
      tableNames: [],
    }],
    generatedDrizzleConfigFile: join(rootDir, ".vitehub", "database", "drizzle.config.ts"),
    generatedDrizzleConfigFilesByDatabase: {},
    generatedSchemaFilesByDatabase: { primary: generatedSchemaFile },
    rootDir,
  }
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
    "    rolldownOptions: { input: resolve(import.meta.dirname, 'src/server.ts') },",
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
    "    rolldownOptions: { input: resolve(import.meta.dirname, 'src/server.ts') },",
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

async function runDbBuild(rootDir: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  return execFileAsync("vp", ["build", ...args], {
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
  it.each([
    { access: "http", binding: undefined, form: "identifier", resource: "application" },
    { access: "http", binding: undefined, form: "spread", resource: "application" },
    { access: "http", binding: undefined, form: "identifier", resource: "inherited" },
    { access: "http", binding: undefined, form: "spread", resource: "inherited" },
    { access: "http", binding: "HOST_DB", form: "identifier", resource: "application" },
    { access: "http", binding: "HOST_DB", form: "spread", resource: "application" },
    { access: "libsql", binding: "HOST_DB", form: "identifier", resource: "application" },
    { access: "libsql", binding: "HOST_DB", form: "spread", resource: "application" },
  ])("uses the evaluated $resource resource for an opaque $form D1 configuration through $access with binding $binding in prepared and Vite outputs", { timeout: 60_000 }, async ({ access, binding, form, resource }) => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-opaque-resource-")
    await rm(join(rootDir, "server/databases"), { recursive: true })
    await mkdir(join(rootDir, "server/databases"), { recursive: true })
    await writeFile(join(rootDir, "server/databases/config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const notes = sqliteTable('notes', { id: integer('id'), title: text('title') })",
      `const cloudflare = { ${resource === "application" ? "databaseId: 'application-id'," : ""} ${binding ? `binding: '${binding}',` : ""} ${access === "http" ? "http: true," : ""} }`,
      "const settings = { cloudflare, schema: { notes } }",
      `export default defineDatabase({ ${form === "identifier" ? "cloudflare, schema: { notes }," : "...settings,"} ${access === "libsql" ? "connection: { url: 'https://application.example' }," : ""} })`,
      "",
    ].join("\n"))
    const runtimeConfig = resolveDBViteConfig({
      binding: "HOST_DB",
      cloudflare: access === "http" ? { http: true } : undefined,
      databaseId: "host-id",
      databaseName: "host-db",
      driver: "d1",
    }, rootDir)!
    await writeGeneratedDatabaseArtifacts(runtimeConfig)
    let projectedCloudflare = false
    const artifacts = await generateDatabaseProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
      runtimeConfig,
    }, async (output) => { projectedCloudflare = Boolean(output.cloudflare) })
    expect(projectedCloudflare).toBe(true)

    await writeFile(join(rootDir, "src/server.ts"), [
      "import definition from '../server/databases/config.ts'",
      "import { useDatabase } from '@vite-hub/database/drizzle'",
      "export default { fetch: async () => Response.json({",
      "  definition: await definition.select().from(definition.schema.notes),",
      "  registry: await useDatabase('default').db.select().from(useDatabase('default').schema.notes),",
      "}) }",
      "",
    ].join("\n"))
    const workerFile = join(rootDir, "opaque-worker.mjs")
    await buildWorker({
      alias: {
        "#vitehub/database/definition-defaults": artifacts.definitionDefaultsFile,
        "@vite-hub/database/drizzle": artifacts.runtimeModuleFiles.cloudflare,
      },
      bundle: true,
      conditions: ["vitehub-hosted", "workerd", "worker", "browser", "default"],
      entryPoints: [artifacts.cloudflareWorkerFile],
      external: ["node:async_hooks"],
      format: "esm",
      outfile: workerFile,
      platform: "neutral",
    })
    async function assertOutput(file: string, provider: "cloudflare" | "vercel") {
      const runner = join(rootDir, "run-opaque-output.mjs")
      await writeFile(runner, [
        "import { createServer } from 'node:http'",
        `import worker from ${JSON.stringify(pathToFileURL(file).href)}`,
        "const requests = [], nativeQueries = []",
        "const binding = { prepare(query) {",
        "  nativeQueries.push(query)",
        "  return { bind: () => ({ raw: async () => [[0, 'host']] }) }",
        "} }",
        "process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account'",
        "process.env.CLOUDFLARE_API_TOKEN = 'test-token'",
        "const requestApp = globalThis.fetch",
        "globalThis.fetch = async (input) => {",
        "  const url = input.url ?? String(input)",
        "  requests.push(String(url))",
        ...(access === "libsql" ? [
          "  const request = await input.json()",
          "  const result = { cols: [{ name: 'id', decltype: 'INTEGER' }, { name: 'title', decltype: 'TEXT' }], rows: [[{ type: 'integer', value: '1' }, { type: 'text', value: 'application' }]], affected_row_count: 0, last_insert_rowid: null }",
          "  return Response.json({ baton: null, base_url: null, results: request.requests.map(entry => ({ type: 'ok', response: entry.type === 'execute' ? { type: 'execute', result } : { type: entry.type } })) })",
        ] : [
          "  const rows = String(url).includes('/application-id/') ? [[1, 'application']] : [[0, 'host']]",
          "  return Response.json({ success: true, result: [{ success: true, results: { rows } }] })",
        ]),
        "}",
        ...(provider === "cloudflare" ? [
          "const response = await worker.fetch(new Request('https://example.com'), { HOST_DB: binding }, {})",
          "console.log(JSON.stringify({ rows: await response.json(), requests, nativeQueries }))",
        ] : [
          "const app = createServer((request, response) => void Promise.resolve(worker(request, response)).catch(error => { response.statusCode = 500; response.end(String(error)) }))",
          "await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))",
          "try {",
          "  const response = await requestApp('http://127.0.0.1:' + app.address().port)",
          "  if (!response.ok) throw new Error(await response.text())",
          "  console.log(JSON.stringify({ rows: await response.json(), requests, nativeQueries }))",
          "} finally { await new Promise(resolve => app.close(resolve)) }",
        ]),
        "",
      ].join("\n"))
      const { stdout } = await execFileAsync(process.execPath, [runner], { cwd: rootDir })
      const result = JSON.parse(stdout)
      const expectedRows = resource === "application" ? [{ id: 1, title: "application" }] : [{ id: 0, title: "host" }]
      expect(result.rows).toEqual({ definition: expectedRows, registry: expectedRows })
      const usesRemote = resource === "application" || provider === "vercel"
      const databaseId = resource === "application" ? "application-id" : "host-id"
      const expectedRequest = access === "libsql" ? expect.stringMatching(/^https:\/\/application\.example\/v\d\/pipeline$/) : `https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/${databaseId}/raw`
      expect(result.requests).toEqual(usesRemote ? Array(2).fill(expectedRequest) : [])
      expect(result.nativeQueries).toHaveLength(usesRemote ? 0 : 2)
    }
    await assertOutput(workerFile, "cloudflare")

    await writeFile(join(rootDir, "vite.config.ts"), [
      "import { resolve } from 'node:path'",
      "import { defineConfig } from 'vite'",
      "import { hubDb } from '@vite-hub/database/vite'",
      "export default defineConfig({",
      "  appType: 'custom',",
      "  build: { outDir: 'dist/client', rolldownOptions: { input: resolve(import.meta.dirname, 'src/server.ts') }, ssr: true },",
      `  plugins: [hubDb({ binding: 'HOST_DB', ${access === "http" ? "cloudflare: { http: true }," : ""} databaseId: 'host-id', databaseName: 'host-db', driver: 'd1' })],`,
      "})",
      "",
    ].join("\n"))
    await runDbBuild(rootDir)
    const wrangler = await readCloudflareConfig(rootDir)
    expect(wrangler.d1_databases).toMatchObject([{ binding: "HOST_DB", database_id: "host-id", database_name: "host-db" }])
    const outputDir = (await readdir(join(rootDir, "dist"))).find(entry => entry !== "client")!
    await assertOutput(join(rootDir, "dist", outputDir, "index.js"), "cloudflare")
    await assertOutput(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "vercel")
  })

  it.each([
    { source: "integration", projectRoot: "." },
    { source: "definition", projectRoot: "." },
    { source: "integration", projectRoot: "packages/db" },
    { source: "definition", projectRoot: "packages/db" },
  ])("uses a provisioned D1 ID fallback in direct Vite output from $source configuration at $projectRoot", { timeout: 60_000 }, async ({ source, projectRoot }) => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-provisioned-http-")
    const databaseRoot = join(rootDir, projectRoot)
    await rm(join(rootDir, "server/databases"), { recursive: true })
    await mkdir(join(databaseRoot, "server/databases"), { recursive: true })
    await writeFile(join(databaseRoot, "server/databases/config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'",
      "const notes = sqliteTable('notes', { id: integer('id'), title: text('title') })",
      `export default defineDatabase({ ${source === "definition" ? "cloudflare: { databaseId: process.env.VITEHUB_PROVISIONED_HTTP_ID, databaseName: 'application-db', http: true }," : ""} schema: { notes } })`,
      "",
    ].join("\n"))
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "provisioned-id" } } }))
    if (projectRoot !== "." && source === "integration") {
      await mkdir(join(databaseRoot, ".vitehub"))
      await writeFile(join(databaseRoot, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { default: "unrelated-nested-id" } } }))
    }
    await writeFile(join(rootDir, "src/server.ts"), [
      `import definition from ${JSON.stringify(`../${projectRoot}/server/databases/config.ts`)}`,
      "import { useDatabase } from '@vite-hub/database/drizzle'",
      "export default { fetch: async () => Response.json({",
      "  definition: await definition.select().from(definition.schema.notes),",
      "  registry: await useDatabase('default').db.select().from(useDatabase('default').schema.notes),",
      "}) }",
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "vite.config.ts"), [
      "import { resolve } from 'node:path'",
      "import { defineConfig } from 'vite'",
      "import { hubDb } from '@vite-hub/database/vite'",
      "export default defineConfig({",
      "  appType: 'custom',",
      "  build: { outDir: 'dist/client', rolldownOptions: { input: resolve(import.meta.dirname, 'src/server.ts') }, ssr: true },",
      `  plugins: [hubDb({ driver: 'd1', projectRoot: ${JSON.stringify(projectRoot)}, ${source === "integration" ? "cloudflare: { http: true }, databaseId: { kind: 'env-variable', source: { kind: 'env', name: 'VITEHUB_PROVISIONED_HTTP_ID' } }, databaseName: 'application-db'," : ""} })],`,
      "})",
      "",
    ].join("\n"))
    await runDbBuild(rootDir)
    const wrangler = await readCloudflareConfig(rootDir)
    expect(wrangler.d1_databases).toMatchObject([{ binding: "DB", database_id: "provisioned-id", database_name: "application-db" }])
    const outputDir = (await readdir(join(rootDir, "dist"))).find(entry => entry !== "client")!
    const workerRunner = join(rootDir, "run-provisioned-cloudflare.mjs")
    await writeFile(workerRunner, [
      `import worker from ${JSON.stringify(pathToFileURL(join(rootDir, "dist", outputDir, "index.js")).href)}`,
      "const queries = []",
      "const binding = { prepare(query) { queries.push(query); return { bind: () => ({ raw: async () => [[1, 'application']] }) } } }",
      "const response = await worker.fetch(new Request('https://example.com'), { DB: binding }, {})",
      "console.log(JSON.stringify({ rows: await response.json(), queries }))",
      "",
    ].join("\n"))
    const workerEnv = { ...process.env }
    delete workerEnv.VITEHUB_PROVISIONED_HTTP_ID
    delete workerEnv.CLOUDFLARE_ACCOUNT_ID
    delete workerEnv.CLOUDFLARE_API_TOKEN
    const { stdout: workerStdout } = await execFileAsync(process.execPath, [workerRunner], { cwd: rootDir, env: workerEnv })
    expect(JSON.parse(workerStdout)).toEqual({
      queries: Array(2).fill('select "id", "title" from "notes"'),
      rows: { definition: [{ id: 1, title: "application" }], registry: [{ id: 1, title: "application" }] },
    })
    const runner = join(rootDir, "run-provisioned-vercel.mjs")
    await writeFile(runner, [
      "import { createServer } from 'node:http'",
      `import app from ${JSON.stringify(pathToFileURL(join(rootDir, ".vercel/output/functions/__server.func/index.mjs")).href)}`,
      "process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account'",
      "process.env.CLOUDFLARE_API_TOKEN = 'test-token'",
      "const requests = [], requestApp = globalThis.fetch",
      "globalThis.fetch = async url => { requests.push(String(url)); return Response.json({ success: true, result: [{ success: true, results: { rows: [[1, 'application']] } }] }) }",
      "const server = createServer((request, response) => void Promise.resolve(app(request, response)).catch(error => { response.statusCode = 500; response.end(String(error)) }))",
      "await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))",
      "try {",
      "  const response = await requestApp('http://127.0.0.1:' + server.address().port)",
      "  if (!response.ok) throw new Error(await response.text())",
      "  console.log(JSON.stringify({ rows: await response.json(), requests }))",
      "} finally { await new Promise(resolve => server.close(resolve)) }",
      "",
    ].join("\n"))
    for (const databaseId of [undefined, "runtime-id"]) {
      const env = { ...process.env }
      delete env.VITEHUB_PROVISIONED_HTTP_ID
      if (databaseId) env.VITEHUB_PROVISIONED_HTTP_ID = databaseId
      const { stdout } = await execFileAsync(process.execPath, [runner], { cwd: rootDir, env })
      expect(JSON.parse(stdout)).toEqual({
        requests: Array(2).fill(`https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/${databaseId ?? "provisioned-id"}/raw`),
        rows: { definition: [{ id: 1, title: "application" }], registry: [{ id: 1, title: "application" }] },
      })
    }
  })

  it.each([
    { access: "native", defaults: true, form: "identifier", resource: "application" },
    { access: "native", defaults: true, form: "spread", resource: "application" },
    { access: "native", defaults: true, form: "identifier", resource: "inherited" },
    { access: "native", defaults: true, form: "spread", resource: "inherited" },
    { access: "libsql", defaults: true, form: "identifier", resource: "application" },
    { access: "libsql", defaults: true, form: "spread", resource: "application" },
    { access: "native", defaults: false, form: "identifier", resource: "application" },
    { access: "native", defaults: false, form: "cloudflare-spread", resource: "application" },
    { access: "native", defaults: false, form: "spread", resource: "application" },
    { access: "native", defaults: false, form: "definition-identifier", resource: "application" },
  ])("validates opaque $resource D1 output with $access access in $form configuration with defaults $defaults before deployment", { timeout: 60_000 }, async ({ access, defaults, form, resource }) => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-opaque-native-")
    await rm(join(rootDir, "server/databases"), { recursive: true })
    await mkdir(join(rootDir, "server/databases"), { recursive: true })
    const connection = access === "libsql" ? "connection: { url: 'libsql://application.example' }," : ""
    await writeFile(join(rootDir, "server/databases/config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      `const cloudflare = { ${resource === "application" ? "databaseId: 'application-id', databaseName: 'application-db'," : ""} migrationsTable: '__application' }`,
      "const settings = { cloudflare, schema: {} }",
      `export default defineDatabase(${form === "identifier" ? `{ cloudflare, ${connection} schema: {} }` : form === "definition-identifier" ? "settings" : form === "cloudflare-spread" ? "{ cloudflare, ...settings }" : `{ ...settings, ${connection} }`})`,
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "src/server.ts"), "export default { fetch: () => new Response('ok') }\n")
    await writeFile(join(rootDir, "vite.config.ts"), [
      "import { resolve } from 'node:path'",
      "import { defineConfig } from 'vite'",
      "import { hubDb } from '@vite-hub/database/vite'",
      "export default defineConfig({",
      "  appType: 'custom',",
      "  build: { outDir: 'dist/client', rolldownOptions: { input: resolve(import.meta.dirname, 'src/server.ts') }, ssr: true },",
      `  plugins: [hubDb(${defaults ? "{ driver: 'd1', databaseId: 'host-id', databaseName: 'host-db' }" : form === "identifier" || form === "cloudflare-spread" ? "" : "{ driver: 'd1' }"})],`,
      "})",
      "",
    ].join("\n"))
    if (access === "native") {
      await expect(runDbBuild(rootDir)).rejects.toThrow("native D1 output requires a literal cloudflare block")
      expect(existsSync(join(rootDir, ".vercel/output/functions/__server.func/index.mjs"))).toBe(false)
    }
    else {
      await runDbBuild(rootDir)
      expect(existsSync(join(rootDir, ".vercel/output/functions/__server.func/index.mjs"))).toBe(true)
      expect((await readCloudflareConfig(rootDir)).d1_databases).toMatchObject([{ database_id: "host-id" }])
    }
  })

  it.each([
    { field: "databaseId", literal: "'   '" },
    { field: "databaseName", literal: "'   '" },
    { field: "databaseId", literal: String.raw`'\t'` },
    { field: "databaseName", literal: String.raw`"\u0020"` },
  ] as const)("rejects whitespace-only owned native $field $literal before hosted Vite output", { timeout: 60_000 }, async ({ field, literal }) => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-blank-native-")
    await rm(join(rootDir, "server/databases"), { recursive: true })
    await mkdir(join(rootDir, "server/databases"), { recursive: true })
    const databaseId = field === "databaseId" ? literal : "'application-id'"
    const databaseName = field === "databaseName" ? literal : "'application-db'"
    await writeFile(join(rootDir, "server/databases/config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      `export default defineDatabase({ cloudflare: { databaseId: ${databaseId}, databaseName: ${databaseName} }, schema: {} })`,
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "src/server.ts"), "export default { fetch: () => new Response('ok') }\n")

    await expect(runDbBuild(rootDir)).rejects.toThrow("DATABASE_B0005")
    expect(existsSync(join(rootDir, ".vitehub/database/cloudflare-runtime.mjs"))).toBe(false)
    expect(existsSync(join(rootDir, ".vercel/output/functions/__server.func/index.mjs"))).toBe(false)
  })

  it.each(["identifier", "spread"] as const)("supports opaque local SQLite %s Definitions without D1 defaults", { timeout: 60_000 }, async (form) => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-opaque-local-")
    await rm(join(rootDir, "server/databases"), { recursive: true })
    await mkdir(join(rootDir, "server/databases"), { recursive: true })
    await writeFile(join(rootDir, "server/databases/config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "const settings = { connection: { url: 'file:application.db' }, schema: {} }",
      `export default defineDatabase(${form === "identifier" ? "settings" : "{ ...settings }"})`,
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "src/server.ts"), "export default { fetch: () => new Response('ok') }\n")
    await runDbBuild(rootDir)
    expect(await readdir(join(rootDir, "dist"))).toEqual(["client"])
    expect(existsSync(join(rootDir, ".vercel/output/functions/__server.func/index.mjs"))).toBe(false)
  })

  it.each(["registry", "definition"])("queries a named D1 database through the binding emitted by Vite for %s access", { timeout: 60_000 }, async (access) => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-named-defaults-")
    await rm(join(rootDir, "server/databases/primary"), { recursive: true })
    await writeDatabaseDefinition(rootDir, "analytics")
    await writeFile(join(rootDir, "src/server.ts"), [
      "import { sql } from 'drizzle-orm'",
      access === "registry"
        ? "import { useDatabase } from '@vite-hub/database/drizzle'"
        : "import analytics from '../server/databases/analytics/config.ts'",
      "export default {",
      `  fetch: async () => new Response(JSON.stringify(await ${access === "registry" ? "useDatabase('analytics').db" : "analytics"}.all(sql\`SELECT 7 AS value\`))),`,
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
      "    rolldownOptions: { input: resolve(import.meta.dirname, 'src/server.ts') },",
      "    ssr: true,",
      "  },",
      "  plugins: [hubDb({ driver: 'd1', databaseId: 'analytics-id', databaseName: 'analytics-db' })],",
      "})",
      "",
    ].join("\n"))
    await runDbBuild(rootDir)
    const wrangler = await readCloudflareConfig(rootDir)
    expect(wrangler.d1_databases).toMatchObject([{
      binding: "DB_ANALYTICS",
      database_id: "analytics-id",
      database_name: "analytics-db",
    }])

    const outputDir = (await readdir(join(rootDir, "dist"))).find(entry => entry !== "client")!
    const runner = join(rootDir, "run-worker.mjs")
    await writeFile(runner, [
      `import worker from ${JSON.stringify(pathToFileURL(join(rootDir, "dist", outputDir, "index.js")).href)}`,
      "const queries = []",
      "const binding = {",
      "  prepare(query) {",
      "    queries.push(query)",
      "    return { bind: () => ({ all: async () => ({ results: [{ value: 7 }] }) }) }",
      "  },",
      "}",
      "const response = await worker.fetch(new Request('https://example.com'), { DB_ANALYTICS: binding }, {})",
      "console.log(JSON.stringify({ body: await response.json(), queries }))",
      "",
    ].join("\n"))
    const { stdout } = await execFileAsync(process.execPath, [runner], { cwd: rootDir })
    expect(JSON.parse(stdout)).toEqual({ body: [{ value: 7 }], queries: ["SELECT 7 AS value"] })
  })

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
    const providerOutput = createProviderOutputCatalog()

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

  it.each([
    { field: "databaseId", source: "literal" },
    { field: "databaseName", source: "literal" },
    { field: "databaseId", source: "env" },
    { field: "databaseName", source: "env" },
    { field: "databaseId", source: "provisioned" },
  ])("excludes inherited D1 output and runtime aliases for a blank $source $field", async ({ field, source }) => {
    const rootDir = await createWorkspaceTempDir("vitehub-db-vite-blank-inherited-")
    await writeDatabaseDefinition(rootDir, "primary")
    if (source === "provisioned") {
      await mkdir(join(rootDir, ".vitehub"), { recursive: true })
      await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({ cloudflare: { d1: { primary: " \t\n" } } }))
    }
    const envName = "VITEHUB_TEST_BLANK_INHERITED_IDENTITY"
    vi.stubEnv(envName, source === "env" ? " \t\n" : undefined)
    try {
      const runtimeConfig = resolveDBViteConfig({
        binding: "HOST_DB",
        databaseId: "native-id",
        databaseName: "native-db",
        driver: "d1",
        [field]: source === "literal" ? " \t\n" : { kind: "env-variable", source: { kind: "env", name: envName } },
      }, rootDir)!
      expect(runtimeConfig.definitionDefaults.cloudflareProjections.primary?.resource).toBe("inherited")
      const providerOutput = createProviderOutputCatalog()
      const artifacts = await prepareDatabaseProviderOutputs({ providerOutput, rootDir, runtimeConfig })
      expect(getProviderRuntimeModule(providerOutput, "database", "cloudflare")).toBeUndefined()
      expect(getProviderRuntimeModule(providerOutput, "database", "cloudflare-definition-defaults")).toBeUndefined()

      await generateDatabaseProviderOutputs({
        artifacts,
        clientOutDir: "dist/client",
        providerOutput,
        rootDir,
        runtimeConfig,
      }, async (output) => { expect(output.cloudflare).toBeUndefined() })
      expect(getProviderRuntimeModule(providerOutput, "database", "cloudflare")).toBeUndefined()
      expect(getProviderRuntimeModule(providerOutput, "database", "cloudflare-definition-defaults")).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps Blob runtime aliases local to the prepared Database generation", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-db-vite-blob-generation-")
    const providerOutput = createProviderOutputCatalog()
    const runtimeConfig = createRuntimeConfig(rootDir, {
      cloudflare: {
        databaseId: "primary-d1-id",
        databaseName: "primary",
        http: true,
      },
    })
    contributeProviderRuntime(providerOutput, {
      owner: "blob",
      runtimeModules: { cloudflare: "blob-old-cloudflare.mjs", vercel: "blob-old-vercel.mjs" },
    })
    const artifacts = await prepareDatabaseProviderOutputs({ providerOutput, rootDir, runtimeConfig })
    contributeProviderRuntime(providerOutput, {
      owner: "blob",
      runtimeModules: { cloudflare: "blob-new-cloudflare.mjs", vercel: "blob-new-vercel.mjs" },
    })

    await generateDatabaseProviderOutputs({
      artifacts,
      clientOutDir: "dist/client",
      providerOutput,
      rootDir,
      runtimeConfig,
    }, async (output) => {
      expect(output.cloudflare?.bundleOptions?.alias).toEqual(expect.objectContaining({
        "@vite-hub/blob": "blob-old-cloudflare.mjs",
      }))
      expect(output.vercel?.bundleOptions.alias).toEqual(expect.objectContaining({
        "@vite-hub/blob": "blob-old-vercel.mjs",
      }))
    })
  })

  it("uses the Definition name when hosted defaults have an empty binding", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-db-vite-definition-defaults-")
    const providerOutput = createProviderOutputCatalog()
    const runtimeConfig = createRuntimeConfig(rootDir, {})
    runtimeConfig.databaseNames = ["analytics"]
    runtimeConfig.databases.analytics = runtimeConfig.databases.primary!
    delete runtimeConfig.databases.primary
    runtimeConfig.definitionDefaults = { cloudflare: { binding: "  " }, cloudflareProjections: {} }
    runtimeConfig.definitions[0]!.name = "analytics"
    runtimeConfig.generatedSchemaFilesByDatabase.analytics = runtimeConfig.generatedSchemaFilesByDatabase.primary!

    await prepareDatabaseProviderOutputs({ providerOutput, rootDir, runtimeConfig })

    await expect(readFile(join(rootDir, ".vitehub/database/definition-defaults.mjs"), "utf8"))
      .resolves.toBe('export default {"cloudflare":{},"cloudflareProjections":{}}\n')
    const expression = renderDatabaseConfigExpression("analytics", runtimeConfig, "definition")
    const { resolveRuntimeCloudflareConfig } = await import("../src/internal/cloudflare.ts")
    const config = Function("definition", "resolveRuntimeCloudflareConfig", `return (${expression})`)({ connection: undefined, drizzle: {}, schema: {} }, resolveRuntimeCloudflareConfig)
    expect(config.cloudflare?.binding).toBe("DB_ANALYTICS")
  })

  it("preserves inherited Nuxt D1 identifiers with the named Definition binding", async () => {
    const rootDir = "/tmp/vitehub-d1-runtime-expression"
    const runtimeConfig = createRuntimeConfig(rootDir, {
      cloudflare: {
        binding: "NUXT_DB",
        databaseId: "nuxt-d1-id",
        databaseName: "nuxt-d1-name",
        previewDatabaseId: "nuxt-preview-id",
        migrationsTable: "__nuxt_migrations",
      },
    })
    runtimeConfig.definitionDefaults.cloudflareProjections.primary = { resource: "inherited" }
    const expression = renderDatabaseConfigExpression("primary", runtimeConfig, "definition")
    const { resolveRuntimeCloudflareConfig } = await import("../src/internal/cloudflare.ts")
    const config = Function("definition", "resolveRuntimeCloudflareConfig", `return (${expression})`)({ cloudflare: {}, connection: undefined, drizzle: {}, schema: {} }, resolveRuntimeCloudflareConfig)

    expect(config.cloudflare).toMatchObject({
      binding: "DB_PRIMARY",
      databaseId: "nuxt-d1-id",
      databaseName: "nuxt-d1-name",
      migrationsTable: "__nuxt_migrations",
      previewDatabaseId: "nuxt-preview-id",
    })
  })

  it.each([
    ["blob-db", "hubBlob({ driver: 'vercel-blob', token: 'vercel_blob_rw_test' }), hubDb()"],
    ["db-blob", "hubDb(), hubBlob({ driver: 'vercel-blob', token: 'vercel_blob_rw_test' })"],
  ])("composes direct Blob and Database provider output in $0 order", { timeout: 60_000 }, async (label, plugins) => {
    const rootDir = await createDbBlobBuildProject(`vitehub-db-blob-${label}-`, plugins)

    await runDbBuild(rootDir, {
      TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    }, ["--configLoader", "runner"])

    const cloudflareConfig = await readCloudflareConfig(rootDir)
    const cloudflareWorker = await readCloudflareWorker(rootDir)
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const vercelServerCode = await readFile(vercelServer, "utf8")

    expect(cloudflareConfig.d1_databases).toHaveLength(2)
    expect(cloudflareWorker).toContain("vitehub-blob-worker")
    expectNoRuntimeImport(cloudflareWorker, "@vite-hub/blob")
    expectNoRuntimeImport(cloudflareWorker, "@vite-hub/database/drizzle")
    expectNoRuntimeImport(vercelServerCode, "@vite-hub/blob")
    expectNoRuntimeImport(vercelServerCode, "@vite-hub/database/drizzle")
  })

  it("ignores stale sibling runtime files that were not prepared in the current build", async () => {
    const staleDatabaseMarker = "stale_database_runtime_marker"
    const blobRootDir = await createBlobBuildProject("vitehub-blob-stale-db-runtime-")
    await writeStaleRuntimeFiles(blobRootDir, "database", [
      `export const databases = { ${staleDatabaseMarker}: true }`,
      "export const db = {}",
      "export const schema = {}",
      "",
    ].join("\n"))

    await runDbBuild(blobRootDir)
    const blobOutput = await readFile(join(blobRootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(blobOutput).not.toContain(staleDatabaseMarker)

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
    expect(bundledServerCode.includes("runtime/virtual-databases.js")).toBe(false)
    expect(bundledServerCode.includes("var databases$1 = {};")).toBe(false)

    const cloudflareWorker = await readCloudflareWorker(rootDir)
    expect(cloudflareWorker).toContain("createAgentDatabase")
    expect(cloudflareWorker).toContain("useDatabase")
    expect(cloudflareWorker).toContain("Object.hasOwn(databases, name)")
    expect(cloudflareWorker).toMatch(/["']?analytics["']?\s*:/)
    expect(cloudflareWorker).toMatch(/["']?primary["']?\s*:/)

    const vercelServerCode = await readFile(vercelServer, "utf8")
    expect(vercelServerCode).toMatch(/["']?analytics["']?\s*:/)
    expect(vercelServerCode).toMatch(/["']?primary["']?\s*:/)
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
