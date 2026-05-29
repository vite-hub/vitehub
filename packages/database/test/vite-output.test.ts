import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const viteBin = join(playgroundDir, "node_modules", ".bin", "vite")
const tempDirs: string[] = []

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
    "import { defineDatabase } from '@vitehub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${table} = sqliteTable('${name}_items', { title: text('title') })`,
    "export default defineDatabase({",
    ...(options.connection ? ["  connection: {", options.connection, "  },"] : []),
    ...(options.cloudflare ? ["  cloudflare: {", options.cloudflare, "  },"] : []),
    `  tables: { ${table} },`,
    "})",
    "",
  ].join("\n"))
}

async function createDbBuildProject(prefix: string) {
  const rootDir = await createWorkspaceTempDir(prefix)
  const nodeModules = join(playgroundDir, "node_modules")
  await mkdir(join(rootDir, "src"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")
  await writeFile(join(rootDir, "package.json"), "{\"type\":\"module\"}\n")
  await writeFile(join(rootDir, "src/server.ts"), [
    "import { databases } from '@vitehub/database/drizzle'",
    "export default {",
    "  fetch: () => new Response(Object.keys(databases).join(',')),",
    "}",
    "",
  ].join("\n"))
  await writeFile(join(rootDir, "vite.config.ts"), [
    "import { resolve } from 'node:path'",
    "import { defineConfig } from 'vite'",
    "import { hubDb } from '@vitehub/database/vite'",
    "export default defineConfig({",
    "  appType: 'custom',",
    "  build: {",
    "    outDir: 'dist/client',",
    "    rollupOptions: { input: resolve(import.meta.dirname, 'src/server.ts') },",
    "    ssr: true,",
    "  },",
    "  plugins: [hubDb()],",
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
    connection: [
      "    authToken: process.env.TURSO_AUTH_TOKEN,",
      "    url: process.env.TURSO_DATABASE_URL,",
    ].join("\n"),
  })
  await writeDatabaseDefinition(rootDir, "analytics", {
    cloudflare: [
      "    binding: 'DB_ANALYTICS',",
      "    databaseName: process.env.VITEHUB_D1_ANALYTICS_DATABASE_NAME || 'vitehub-playground-analytics',",
      "    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
      "    previewDatabaseId: process.env.VITEHUB_D1_ANALYTICS_PREVIEW_DATABASE_ID,",
    ].join("\n"),
    connection: [
      "    authToken: process.env.TURSO_AUTH_TOKEN,",
      "    url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,",
    ].join("\n"),
  })
  return rootDir
}

async function runDbBuild(rootDir: string, env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(viteBin, ["build"], {
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

function errorText(error: unknown) {
  return (error as { stderr?: string; message?: string } | undefined)?.stderr
    || (error as { message?: string } | undefined)?.message
    || String(error)
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite db provider outputs", () => {
  it("builds and emits named database Cloudflare and Vercel outputs", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-output-")

    await runDbBuild(rootDir, {
      TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    })

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
    const vercelServerCode = await readFile(vercelServer, "utf8")
    expect(vercelServerCode).toContain("process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL")
    expect(vercelServerCode).toContain("process.env.TURSO_DATABASE_URL")
    expect(vercelServerCode).not.toContain("libsql://analytics.example.turso.io")
    expect(vercelServerCode).not.toContain("libsql://database.example.turso.io")
  }, 30_000)

  it("skips Vercel output when a named database has no remote fallback URL", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-vercel-invalid-")
    await writeDatabaseDefinition(rootDir, "analytics", {
      cloudflare: [
        "    binding: 'DB_ANALYTICS',",
        "    databaseName: 'vitehub-playground-analytics',",
        "    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
      ].join("\n"),
    })

    await runDbBuild(rootDir, {
      TURSO_AUTH_TOKEN: "token",
      TURSO_DATABASE_URL: "libsql://database.example.turso.io",
      VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
      VITEHUB_D1_DATABASE_ID: "primary-d1-id",
    })

    const cloudflareConfig = await readCloudflareConfig(rootDir)
    expect(cloudflareConfig.d1_databases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: "DB_ANALYTICS",
        database_id: "analytics-d1-id",
        database_name: "vitehub-playground-analytics",
      }),
    ]))
    expect(existsSync(join(rootDir, ".vercel", "output"))).toBe(false)
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

  it("fails Cloudflare output when a D1 database ID is missing a database name", async () => {
    const rootDir = await createDbBuildProject("vitehub-db-vite-cloudflare-invalid-")
    await writeDatabaseDefinition(rootDir, "analytics", {
      cloudflare: [
        "    binding: 'DB_ANALYTICS',",
        "    databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
      ].join("\n"),
      connection: [
        "    authToken: process.env.TURSO_AUTH_TOKEN,",
        "    url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,",
      ].join("\n"),
    })

    let error: Error | undefined
    try {
      await runDbBuild(rootDir, {
        TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
        TURSO_AUTH_TOKEN: "token",
        TURSO_DATABASE_URL: "libsql://database.example.turso.io",
        VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
        VITEHUB_D1_DATABASE_ID: "primary-d1-id",
      })
    }
    catch (caught) {
      error = caught as Error
    }

    expect(error).toBeTruthy()
    expect(errorText(error)).toContain("Cloudflare output requires `db.cloudflare.databaseName` when `db.cloudflare.databaseId` is set for databases: analytics")
  }, 30_000)
})
