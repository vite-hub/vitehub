import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
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

async function createPlaygroundCopy(prefix: string) {
  const workspaceDir = await createWorkspaceTempDir(prefix)
  const rootDir = join(workspaceDir, "vite")
  const nodeModules = join(playgroundDir, "node_modules")

  await mkdir(rootDir, { recursive: true })
  await cp(join(playgroundDir, "package.json"), join(rootDir, "package.json"))
  await cp(join(playgroundDir, "build"), join(rootDir, "build"), { recursive: true })
  await cp(join(playgroundDir, "vite.config.ts"), join(rootDir, "vite.config.ts"))
  await cp(join(playgroundDir, "src"), join(rootDir, "src"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")

  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite db provider outputs", () => {
  it("builds the playground and emits multi-database Cloudflare and Vercel outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-db-vite-playground-")

    await execFileAsync("pnpm", ["exec", "vite", "build"], {
      cwd: rootDir,
      env: {
        ...process.env,
        TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
        TURSO_AUTH_TOKEN: "token",
        TURSO_DATABASE_URL: "libsql://db.example.turso.io",
        VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
        VITEHUB_D1_DATABASE_ID: "primary-d1-id",
        VITEHUB_VITE_MODE: "db",
      },
    })

    const cloudflareWorker = join(rootDir, "dist", "vite", "index.js")
    const cloudflareConfig = JSON.parse(await readFile(join(rootDir, "dist", "vite", "wrangler.json"), "utf8"))
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(cloudflareConfig.d1_databases).toEqual([
      expect.objectContaining({
        binding: "DB",
        database_name: "vitehub-playground-db",
        database_id: "primary-d1-id",
      }),
      expect.objectContaining({
        binding: "DB_ANALYTICS",
        database_name: "vitehub-playground-analytics",
        database_id: "analytics-d1-id",
      }),
    ])
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    const vercelServerCode = await readFile(vercelServer, "utf8")
    expect(vercelServerCode).toContain("libsql://db.example.turso.io")
    expect(vercelServerCode).toContain("libsql://analytics.example.turso.io")
    expect(vercelServerCode).toContain("/api/db/analytics")
    expect(vercelServerCode).not.toContain("@libsql/linux-x64-gnu")
  }, 30_000)

  it("fails the hosted build when a named D1 database has no Vercel fallback URL", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-db-vite-d1-only-")
    const viteConfigPath = join(rootDir, "vite.config.ts")
    const viteConfig = await readFile(viteConfigPath, "utf8")
    await writeFile(
      viteConfigPath,
      viteConfig.replaceAll(
        [
          "    analytics: {",
          "      connection: {",
          "        authToken: process.env.TURSO_AUTH_TOKEN,",
          "        url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,",
          "      },",
        ].join("\n"),
        "    analytics: {",
      ),
      "utf8",
    )

    let error: Error | undefined
    try {
      await execFileAsync("pnpm", ["exec", "vite", "build"], {
        cwd: rootDir,
        env: {
          ...process.env,
          TURSO_AUTH_TOKEN: "token",
          TURSO_DATABASE_URL: "libsql://db.example.turso.io",
          VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
          VITEHUB_VITE_MODE: "db",
        },
      })
    }
    catch (caught) {
      error = caught as Error
    }

    expect(error).toBeTruthy()
    expect((error as { stderr?: string; message?: string } | undefined)?.stderr || (error as { message?: string } | undefined)?.message || String(error)).toContain("Vercel output requires a remote libSQL `db.connection.url` for databases: analytics")
  }, 30_000)

  it("fails the hosted build when the default database falls back to local SQLite", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-db-vite-local-default-")

    let error: Error | undefined
    try {
      await execFileAsync("pnpm", ["exec", "vite", "build"], {
        cwd: rootDir,
        env: {
          ...process.env,
          TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
          VITEHUB_D1_DATABASE_ID: "primary-d1-id",
          VITEHUB_VITE_MODE: "db",
        },
      })
    }
    catch (caught) {
      error = caught as Error
    }

    expect(error).toBeTruthy()
    expect((error as { stderr?: string; message?: string } | undefined)?.stderr || (error as { message?: string } | undefined)?.message || String(error)).toContain("Vercel output requires a remote libSQL `db.connection.url` for databases: default")
  }, 30_000)

  it("fails the Cloudflare build when a hosted D1 database has no database ID or remote fallback URL", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-db-vite-cloudflare-missing-id-")
    const viteConfigPath = join(rootDir, "vite.config.ts")
    const viteConfig = await readFile(viteConfigPath, "utf8")
    await writeFile(
      viteConfigPath,
      viteConfig.replaceAll(
        [
          "      cloudflare: {",
          "        binding: \"DB_ANALYTICS\",",
          "        databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,",
          "        previewDatabaseId: process.env.VITEHUB_D1_ANALYTICS_PREVIEW_DATABASE_ID,",
          "      },",
        ].join("\n"),
        [
          "      cloudflare: {",
          "        binding: \"DB_ANALYTICS\",",
          "        previewDatabaseId: \"analytics-preview-id\",",
          "      },",
        ].join("\n"),
      ).replaceAll(
        [
          "      connection: {",
          "        authToken: process.env.TURSO_AUTH_TOKEN,",
          "        url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,",
          "      },",
        ].join("\n"),
        "",
      ),
      "utf8",
    )

    let error: Error | undefined
    try {
      await execFileAsync("pnpm", ["exec", "vite", "build"], {
        cwd: rootDir,
        env: {
          ...process.env,
          TURSO_AUTH_TOKEN: "token",
          TURSO_DATABASE_URL: "libsql://db.example.turso.io",
          VITEHUB_D1_DATABASE_ID: "primary-d1-id",
          VITEHUB_VITE_MODE: "db",
        },
      })
    }
    catch (caught) {
      error = caught as Error
    }

    expect(error).toBeTruthy()
    expect((error as { stderr?: string; message?: string } | undefined)?.stderr || (error as { message?: string } | undefined)?.message || String(error)).toContain("Cloudflare output requires `db.cloudflare.databaseId` or a remote libSQL `db.connection.url` for databases: analytics")
  }, 30_000)

  it("fails the Cloudflare build when the default database has no D1 binding and falls back to local SQLite", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-db-vite-cloudflare-local-default-")
    const viteConfigPath = join(rootDir, "vite.config.ts")
    const viteConfig = await readFile(viteConfigPath, "utf8")
    await writeFile(
      viteConfigPath,
      viteConfig
        .replace(
          [
            "  connection: {",
            "    authToken: process.env.TURSO_AUTH_TOKEN,",
            "    url: process.env.TURSO_DATABASE_URL,",
            "  },",
          ].join("\n"),
          "",
        )
        .replace(
          [
            "  cloudflare: {",
            "    binding: \"DB\",",
            "    databaseName: process.env.VITEHUB_D1_DATABASE_NAME || \"vitehub-playground-db\",",
            "    databaseId: process.env.VITEHUB_D1_DATABASE_ID,",
            "    previewDatabaseId: process.env.VITEHUB_D1_PREVIEW_DATABASE_ID,",
            "  },",
          ].join("\n"),
          "",
        ),
      "utf8",
    )

    let error: Error | undefined
    try {
      await execFileAsync("pnpm", ["exec", "vite", "build"], {
        cwd: rootDir,
        env: {
          ...process.env,
          TURSO_AUTH_TOKEN: "token",
          TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
          VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
          VITEHUB_VITE_MODE: "db",
        },
      })
    }
    catch (caught) {
      error = caught as Error
    }

    expect(error).toBeTruthy()
    expect((error as { stderr?: string; message?: string } | undefined)?.stderr || (error as { message?: string } | undefined)?.message || String(error)).toContain("Cloudflare output requires `db.cloudflare.databaseId` or a remote libSQL `db.connection.url` for databases: default")
  }, 30_000)

  it("fails the Cloudflare build when a D1 database ID is missing a database name", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-db-vite-cloudflare-missing-name-")
    const viteConfigPath = join(rootDir, "vite.config.ts")
    const viteConfig = await readFile(viteConfigPath, "utf8")
    await writeFile(
      viteConfigPath,
      viteConfig.replace(
        '        databaseName: process.env.VITEHUB_D1_ANALYTICS_DATABASE_NAME || "vitehub-playground-analytics",\n',
        "",
      ),
      "utf8",
    )

    let error: Error | undefined
    try {
      await execFileAsync("pnpm", ["exec", "vite", "build"], {
        cwd: rootDir,
        env: {
          ...process.env,
          TURSO_AUTH_TOKEN: "token",
          TURSO_DATABASE_URL: "libsql://db.example.turso.io",
          VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
          VITEHUB_D1_DATABASE_ID: "primary-d1-id",
          VITEHUB_VITE_MODE: "db",
        },
      })
    }
    catch (caught) {
      error = caught as Error
    }

    expect(error).toBeTruthy()
    expect((error as { stderr?: string; message?: string } | undefined)?.stderr || (error as { message?: string } | undefined)?.message || String(error)).toContain("Cloudflare output requires `db.cloudflare.databaseName` when `db.cloudflare.databaseId` is set for databases: analytics")
  }, 30_000)

  it("fails the Cloudflare build when a binding-only database has no database ID or remote fallback URL", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-db-vite-cloudflare-binding-only-")
    const viteConfigPath = join(rootDir, "vite.config.ts")
    const viteConfig = await readFile(viteConfigPath, "utf8")
    await writeFile(
      viteConfigPath,
      viteConfig.replaceAll(
        [
          "    analytics: {",
          "      connection: {",
          "        authToken: process.env.TURSO_AUTH_TOKEN,",
          "        url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,",
          "      },",
        ].join("\n"),
        "    analytics: {",
      ),
      "utf8",
    )

    let error: Error | undefined
    try {
      await execFileAsync("pnpm", ["exec", "vite", "build"], {
        cwd: rootDir,
        env: {
          ...process.env,
          TURSO_AUTH_TOKEN: "token",
          TURSO_DATABASE_URL: "libsql://db.example.turso.io",
          VITEHUB_VITE_MODE: "db",
        },
      })
    }
    catch (caught) {
      error = caught as Error
    }

    expect(error).toBeTruthy()
    expect((error as { stderr?: string; message?: string } | undefined)?.stderr || (error as { message?: string } | undefined)?.message || String(error)).toContain("Cloudflare output requires `db.cloudflare.databaseId` or a remote libSQL `db.connection.url` for databases: analytics")
  }, 30_000)
})
