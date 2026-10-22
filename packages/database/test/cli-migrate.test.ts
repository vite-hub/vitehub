import { spawn as spawnProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"

import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const databaseUrl = "file:.vitehub/data/database/sqlite.db"

function realSpawn(command: string, args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", exitCode => resolve({ exitCode }))
  })
}

function notesSchema(columns: string[]) {
  return [
    "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `export const notes = sqliteTable('notes', { id: integer('id').primaryKey(), ${columns.map(column => `${column}: text('${column}')`).join(", ")} })`,
    "",
  ].join("\n")
}

// The package root has drizzle-kit and @libsql/client in its dependencies, like a project that uses `vitehub db`.
async function createProject() {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".drizzle-migrate-"))
  tempDirs.push(rootDir)
  await writeFile(join(rootDir, "drizzle.config.ts"), [
    "export default {",
    "  dialect: 'sqlite',",
    "  out: './migrations',",
    "  schema: './schema.ts',",
    `  dbCredentials: { url: '${databaseUrl}' },`,
    "}",
    "",
  ].join("\n"))
  const database = {
    connection: { url: databaseUrl },
    dialect: "sqlite",
    migrationsDir: join(rootDir, "migrations"),
    name: "default",
  } as ResolvedDrizzleDatabaseConfig
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: ["default"],
    databases: { default: database },
    generatedDrizzleConfigFile: join(rootDir, "drizzle.config.ts"),
    rootDir,
  }) as unknown as ResolvedDBViteConfig)!

  async function run(feature: "generate" | "migrate", args: string[] = []) {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === feature)!
    const exitCode = await command.run(args, { env: process.env, rootDir, spawn: realSpawn, stderr, stdout } as never)
    const text = (write: ReturnType<typeof vi.fn>) => write.mock.calls.map(([chunk]) => String(chunk)).join("")
    return { exitCode, stderr: text(stderr.write), stdout: text(stdout.write) }
  }

  async function columns() {
    const client = createClient({ url: `file:${join(rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      return (await client.execute("SELECT name FROM pragma_table_info('notes')")).rows.map(row => row[0])
    }
    finally {
      client.close()
    }
  }

  return { columns, database, rootDir, run, writeSchema: (columns: string[]) => writeFile(join(rootDir, "schema.ts"), notesSchema(columns)) }
}

describe("vitehub db migrate", () => {
  it("prints pending migrations, refuses data loss, and applies it with --allow-data-loss", async () => {
    const project = await createProject()
    await project.writeSchema(["title", "body"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })

    // A dry run on a database that does not exist yet lists the first migration and creates no file.
    const first = await project.run("migrate", ["--dry-run"])
    expect(first).toMatchObject({ exitCode: 0, stderr: "" })
    expect(first.stdout).toContain("[vitehub] Database \"default\" (local SQLite .vitehub/data/database/sqlite.db): 1 pending migration.")
    expect(first.stdout).toMatch(/0000_init\n {4}CREATE TABLE `notes`/)
    expect(first.stdout).toContain("[vitehub] Dry run. No changes were made.")
    expect(existsSync(join(project.rootDir, ".vitehub/data/database/sqlite.db"))).toBe(false)

    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])

    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "drop_body"])).resolves.toMatchObject({ exitCode: 0 })

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stdout).toContain("1 pending migration.")
    expect(dryRun.stdout).toContain("0001_drop_body\n    ALTER TABLE `notes` DROP COLUMN `body`;\n    ! Data loss: drops column \"body\" from \"notes\".")
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_DATA_LOSS")

    const refused = await project.run("migrate")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("0001_drop_body: drops column \"body\" from \"notes\": ALTER TABLE `notes` DROP COLUMN `body`;")
    expect(refused.stderr).toContain("vitehub db migrate --allow-data-loss")
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])

    await expect(project.run("migrate", ["--dry-run", "--allow-data-loss"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])

    await expect(project.run("migrate", ["--allow-data-loss"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title"])

    const done = await project.run("migrate", ["--dry-run"])
    expect(done).toMatchObject({ exitCode: 0, stderr: "" })
    expect(done.stdout).toContain(": no pending migrations.")
  }, 120_000)

  it("fails without a resolved Database config instead of skipping the check", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const stderr = { write: vi.fn() }
    const migrate = createDbCliContributor()!.namespaces[0]!.features.find(feature => feature.name === "migrate")!

    await expect(migrate.run([], { env: {}, rootDir: import.meta.dirname, spawn, stderr, stdout: { write: vi.fn() } } as never)).resolves.toBe(1)

    expect(spawn).not.toHaveBeenCalled()
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("DATABASE_MIGRATION_CHECK_FAILED"))
  })
})

describe("readMigrationPlan", () => {
  async function d1Project() {
    const project = await createProject()
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    const database = { ...project.database, cloudflare: { binding: "DB", databaseId: "database-id", http: true, migrationsDir: project.database.migrationsDir } } as ResolvedDrizzleDatabaseConfig
    return { database, rootDir: project.rootDir }
  }

  it("fails clearly when D1 HTTP has no Cloudflare credentials", async () => {
    const { database, rootDir } = await d1Project()
    const request = vi.fn<typeof fetch>()

    const [error] = await readMigrationPlan(database, { env: {}, fetch: request, projectRoot: rootDir })

    expect(error?.code).toBe("DATABASE_MIGRATION_CHECK_FAILED")
    expect(error?.why).toContain("needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`")
    expect(request).not.toHaveBeenCalled()
  }, 60_000)

  it("reads the Drizzle migrations table of D1 over HTTP", async () => {
    const { database, rootDir } = await d1Project()
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const { sql } = JSON.parse(String(init?.body)) as { sql: string }
      const rows = sql.includes("sqlite_master") ? [["__drizzle_migrations"]] : [[Number.MAX_SAFE_INTEGER]]
      return Response.json({ result: [{ results: { columns: [], rows } }], success: true })
    })

    const [error, plan] = await readMigrationPlan(database, {
      env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" },
      fetch: request,
      projectRoot: rootDir,
    })

    expect(error).toBeUndefined()
    expect(plan).toEqual({ database: "default", pending: [], target: "Cloudflare D1 database-id over HTTP" })
    expect(request).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/accounts/account/d1/database/database-id/raw", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
      method: "POST",
    }))
  }, 60_000)

  it("accepts the Cloudflare D1 object row response shape", async () => {
    const { database, rootDir } = await d1Project()
    const request = vi.fn<typeof fetch>(async () => Response.json({ result: [{ results: [{ name: "__drizzle_migrations" }] }], success: true }))

    const [error, plan] = await readMigrationPlan(database, {
      env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" },
      fetch: request,
      projectRoot: rootDir,
    })

    expect(error).toBeUndefined()
    expect(plan?.pending).toHaveLength(1)
  }, 60_000)
})
