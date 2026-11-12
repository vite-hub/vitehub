import { spawn as spawnProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createHash } from "node:crypto"

import { createDbCliContributor } from "../src/cli.ts"
import { createRuntimeEnvConfigValue } from "../src/config-value.ts"
import { copyD1MigrationFiles, d1MigrationNamesFile, listD1Migrations } from "../src/internal/d1-migrations.ts"
import { renderMigrateOnStartPlugin, renderShippedMigrationsModule } from "../src/internal/migrate-on-start.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { createTestDatabaseClient } from "../src/runtime/test-database.ts"

import type { InArgs } from "@libsql/client"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const databaseUrl = "file:.vitehub/data/database/sqlite.db"

/**
 * Waits for the next second. Drizzle Kit 1.0 names a SQLite migration folder by the current second only, and Drizzle
 * orders folders of the same second by name, so two generates in one second can apply in the wrong order.
 */
async function nextSecond() {
  await new Promise(resolve => setTimeout(resolve, 1_010 - Date.now() % 1_000))
}

/** The migration folders that Drizzle Kit 1.0 wrote, oldest first, such as `20261109183119_init`. */
async function migrationTags(migrationsDir: string) {
  return (await readdir(migrationsDir)).filter(name => /^\d{14}_/.test(name)).sort()
}

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

// The package root has drizzle-kit and @libsql/client in its dependencies, like a project that uses `vitehub database`.
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

  async function run(feature: "generate" | "migrate" | "up", args: string[] = [], env: NodeJS.ProcessEnv = process.env, spawn: typeof realSpawn = realSpawn) {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === feature)!
    const exitCode = await command.run(args, { env, rootDir, spawn, stderr, stdout } as never)
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

const drizzleKit0xFixture = join(import.meta.dirname, "fixtures/drizzle-kit-0x-migrations")

describe("vitehub database up", () => {
  it("converts a Drizzle Kit 0.x folder, which generate and migrate refuse before, then migrates it on libSQL", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await cp(drizzleKit0xFixture, migrationsDir, { recursive: true })
    await project.writeSchema(["title", "body"])

    for (const feature of ["migrate", "generate"] as const) {
      const refused = await project.run(feature)
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain("DATABASE_MIGRATIONS_OLD_LAYOUT")
      expect(refused.stderr).toContain("The migrations of the database \"default\" in migrations use the layout of Drizzle Kit 0.x")
      expect(refused.stderr).toContain("Run `vitehub database up` once")
    }
    expect(existsSync(join(project.rootDir, ".vitehub/data/database/sqlite.db"))).toBe(false)
    await expect(readdir(migrationsDir)).resolves.toEqual(["0000_init.sql", "0001_add_body.sql", "meta"])

    const converted = await project.run("up")
    expect(converted).toMatchObject({ exitCode: 0, stderr: "" })
    expect(converted.stdout).toContain("[vitehub] Database \"default\": converted migrations to the layout of Drizzle Kit 1.0. Commit the new folders.")
    const tags = await migrationTags(migrationsDir)
    expect(tags).toEqual([expect.stringMatching(/^\d{14}_init$/), expect.stringMatching(/^\d{14}_add_body$/)])
    await expect(readFile(join(migrationsDir, tags[0]!, "migration.sql"), "utf8")).resolves.toBe(await readFile(join(drizzleKit0xFixture, "0000_init.sql"), "utf8"))

    await expect(project.run("up")).resolves.toMatchObject({ exitCode: 0, stdout: "[vitehub] Every migrations folder already uses the layout of Drizzle Kit 1.0.\n" })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])
    // The converted snapshots match the schema, so Drizzle Kit has no migration to write.
    await expect(project.run("generate")).resolves.toMatchObject({ exitCode: 0 })
    await expect(migrationTags(migrationsDir)).resolves.toEqual(tags)
  }, 120_000)

  it("keeps the migrations that Drizzle Kit 0.x applied, and applies the next one", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await cp(drizzleKit0xFixture, migrationsDir, { recursive: true })
    // The database as `drizzle-kit migrate` 0.31 left it: both migrations applied, with 0.x ledger rows.
    const journal = JSON.parse(await readFile(join(drizzleKit0xFixture, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string, when: number }> }
    await mkdir(join(project.rootDir, ".vitehub/data/database"), { recursive: true })
    const client = createClient({ url: `file:${join(project.rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      await client.execute("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)")
      for (const entry of journal.entries) {
        const sql = await readFile(join(drizzleKit0xFixture, `${entry.tag}.sql`), "utf8")
        await client.executeMultiple(sql)
        await client.execute({ args: [createHash("sha256").update(sql).digest("hex"), entry.when], sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)" })
      }
    }
    finally {
      client.close()
    }

    await expect(project.run("up")).resolves.toMatchObject({ exitCode: 0 })
    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun.stdout).toContain("no pending migrations.")

    await project.writeSchema(["title", "body", "tags"])
    await nextSecond()
    await expect(project.run("generate", ["--name", "add_tags"])).resolves.toMatchObject({ exitCode: 0 })
    const applied = await project.run("migrate")
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body", "tags"])
    await expect(project.run("migrate", ["--dry-run"])).resolves.toMatchObject({ stdout: expect.stringContaining("no pending migrations.") })
  }, 120_000)

  it("asks for drizzle-kit 1.0 when the project has drizzle-kit 0.x", async () => {
    const project = await createProject()
    await cp(drizzleKit0xFixture, project.database.migrationsDir, { recursive: true })
    // The project root wins over the package's own drizzle-kit, as in an app that still pins 0.31.
    await mkdir(join(project.rootDir, "node_modules/drizzle-kit"), { recursive: true })
    await writeFile(join(project.rootDir, "node_modules/drizzle-kit/package.json"), JSON.stringify({ bin: "bin.cjs", name: "drizzle-kit", version: "0.31.4" }))
    await writeFile(join(project.rootDir, "node_modules/drizzle-kit/bin.cjs"), "process.exit(0)\n")

    const refused = await project.run("up")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("`vitehub database up` needs drizzle-kit 1.0, and")
    expect(refused.stderr).toContain("has drizzle-kit 0.31.4. Install the version that ViteHub uses, for example with `pnpm add -D drizzle-kit@1.0.0-rc.5`")
    await expect(readdir(project.database.migrationsDir)).resolves.toContain("meta")
  })

  it("stops migrate on start and test mode at a Drizzle Kit 0.x folder", async () => {
    const project = await createProject()
    await cp(drizzleKit0xFixture, project.database.migrationsDir, { recursive: true })
    const config = { databaseNames: ["default"], databases: { default: project.database }, rootDir: project.rootDir } as unknown as ResolvedDBViteConfig

    expect(() => renderMigrateOnStartPlugin(config, { databases: ["default"], drizzleImport: "db", migrationsImport: "migrations", runtimeImport: "runtime" })).toThrow(expect.objectContaining({
      code: "DATABASE_MIGRATIONS_OLD_LAYOUT",
      why: expect.stringContaining(`The migrations of the database "default" in ${project.database.migrationsDir} use the layout of Drizzle Kit 0.x`),
    }))
    const shipped = JSON.parse(renderShippedMigrationsModule(config, { allowDataLoss: false }).replace(/^export default /, ""))
    expect(shipped.databases.default).toEqual({ problem: expect.stringContaining(`The migrations of the database "default" in ${project.database.migrationsDir} use the layout of Drizzle Kit 0.x`) })
    const client = createTestDatabaseClient(project.rootDir, "migrations")
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_OLD_LAYOUT" })
  })
})

describe("vitehub database migrate", () => {
  it("prints pending migrations, refuses data loss, and applies it with --allow-data-loss", async () => {
    const project = await createProject()
    await project.writeSchema(["title", "body"])
    await nextSecond()
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })

    // A dry run on a database that does not exist yet lists the first migration and creates no file.
    const first = await project.run("migrate", ["--dry-run"])
    expect(first).toMatchObject({ exitCode: 0, stderr: "" })
    expect(first.stdout).toContain("[vitehub] Database \"default\" (local SQLite .vitehub/data/database/sqlite.db): 1 pending migration.")
    expect(first.stdout).toMatch(/\d{14}_init\n {4}CREATE TABLE `notes`/)
    expect(first.stdout).toContain("[vitehub] Dry run. No changes were made.")
    expect(existsSync(join(project.rootDir, ".vitehub/data/database/sqlite.db"))).toBe(false)

    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])

    await project.writeSchema(["title"])
    await nextSecond()
    await expect(project.run("generate", ["--name", "drop_body"])).resolves.toMatchObject({ exitCode: 0 })

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stdout).toContain("1 pending migration.")
    expect(dryRun.stdout).toMatch(/\d{14}_drop_body\n {4}ALTER TABLE `notes` DROP COLUMN `body`;\n {4}! Data loss: drops column "body" from "notes"\./)
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_DATA_LOSS")

    const refused = await project.run("migrate")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toMatch(/\d{14}_drop_body: drops column "body" from "notes": ALTER TABLE `notes` DROP COLUMN `body`;/)
    expect(refused.stderr).toContain("vitehub database migrate --allow-data-loss")
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])

    await expect(project.run("migrate", ["--dry-run", "--allow-data-loss"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])

    await expect(project.run("migrate", ["--allow-data-loss"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title"])

    const done = await project.run("migrate", ["--dry-run"])
    expect(done).toMatchObject({ exitCode: 0, stderr: "" })
    expect(done.stdout).toContain(": no pending migrations.")
  }, 120_000)

  it("does not start Drizzle Kit when the database has every migration", async () => {
    const project = await createProject()
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })

    const spawn = vi.fn(realSpawn)
    const again = await project.run("migrate", [], process.env, spawn)
    expect(again).toMatchObject({ exitCode: 0, stderr: "" })
    expect(again.stdout).toBe("[vitehub] Database \"default\" (local SQLite .vitehub/data/database/sqlite.db): no pending migrations.\n")
    expect(spawn).not.toHaveBeenCalled()

    await project.writeSchema(["title", "body"])
    await nextSecond()
    await expect(project.run("generate", ["--name", "add_body"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate", [], process.env, spawn)).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    expect(spawn).toHaveBeenCalledOnce()
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])
  }, 120_000)

  it("fails when an applied migration SQL file is missing", async () => {
    const project = await createProject()
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })

    const [init] = await migrationTags(project.database.migrationsDir)
    await rm(join(project.database.migrationsDir, init!, "migration.sql"))

    // Incomplete history fails even when every migration was applied or the data-loss check is bypassed.
    await expect(project.run("migrate", ["--allow-data-loss"])).resolves.toMatchObject({ exitCode: 1 })
    const result = await project.run("migrate")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("DATABASE_MIGRATION_CHECK_FAILED")
    expect(result.stderr).toContain(`${init}/migration.sql`)
    expect(result.stdout).not.toContain("no pending migrations")
  }, 120_000)

  it("migrates a Postgres Database on PGlite with Drizzle Kit, not the Postgres server migrator", async () => {
    const project = await createProject()
    Object.assign(project.database, { connection: undefined, dialect: "postgresql" })
    await mkdir(project.database.migrationsDir, { recursive: true })
    const spawn = vi.fn(async () => ({ exitCode: 0 }))

    // No URL and no PG* variables: the generated Kit config uses PGlite in .vitehub/data/database/pglite.
    await expect(project.run("migrate", [], {}, spawn)).resolves.toMatchObject({ exitCode: 0, stderr: "" })

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]).toEqual(expect.arrayContaining([expect.arrayContaining(["migrate"])]))
    expect(existsSync(join(project.rootDir, ".vitehub/data/database"))).toBe(true)
  })

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
    const [init] = await migrationTags(project.database.migrationsDir)
    return { database, init: init!, rootDir: project.rootDir }
  }

  it("reads a Drizzle Kit 0.x ledger as Drizzle 1.0 upgrades it, and fails on rows of no migration folder", async () => {
    const project = await createProject()
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    const [init] = await migrationTags(project.database.migrationsDir)
    // Drizzle Kit 0.x wrote the journal `when` in milliseconds. Drizzle 1.0 matches it to the folder of the same second.
    const createdAt = Date.UTC(Number(init!.slice(0, 4)), Number(init!.slice(4, 6)) - 1, Number(init!.slice(6, 8)), Number(init!.slice(8, 10)), Number(init!.slice(10, 12)), Number(init!.slice(12, 14))) + 417
    await mkdir(join(project.rootDir, ".vitehub/data/database"), { recursive: true })
    const client = createClient({ url: `file:${join(project.rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      await client.execute("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)")
      await client.execute({ args: [createdAt], sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('old-hash', ?)" })
      const options = { env: process.env, projectRoot: project.rootDir }
      await expect(readMigrationPlan(project.database, options)).resolves.toMatchObject([undefined, { pending: [] }])

      // A row of another Definition on the same database stops the upgrade in Drizzle 1.0, so the check fails first.
      await client.execute("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('other-hash', 1600000000000)")
      const [error] = await readMigrationPlan(project.database, options)
      expect(error?.code).toBe("DATABASE_MIGRATION_CHECK_FAILED")
      expect(error?.why).toContain("1 row(s) (id 2) that match no migration folder")
    }
    finally {
      client.close()
    }
  })

  it("fails clearly when D1 HTTP has no Cloudflare credentials", async () => {
    const { database, rootDir } = await d1Project()
    const request = vi.fn<typeof fetch>()

    const [error] = await readMigrationPlan(database, { env: {}, fetch: request, projectRoot: rootDir })

    expect(error?.code).toBe("DATABASE_MIGRATION_CHECK_FAILED")
    expect(error?.why).toContain("needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`")
    expect(request).not.toHaveBeenCalled()
  }, 60_000)

  it("reads Wrangler's migrations table of D1 over HTTP", async () => {
    const { database, rootDir } = await d1Project()
    // Wrangler names the first migration folder `0000_init.sql`, as Drizzle Kit 0.x named it.
    const d1 = await createFakeD1(rootDir, "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE); INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');")

    const [error, plan] = await readMigrationPlan(database, { env: d1Env, fetch: d1.fetch, projectRoot: rootDir })

    expect(error).toBeUndefined()
    expect(plan).toEqual({ applied: 1, database: "default", pending: [], target: "Cloudflare D1 database-id over HTTP" })
    expect(d1.fetch).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/accounts/account/d1/database/database-id/query", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
      method: "POST",
    }))
  }, 60_000)

  it("accepts the Cloudflare D1 array row response shape", async () => {
    const { database, init, rootDir } = await d1Project()
    const request = vi.fn<typeof fetch>(async () => Response.json({ result: [{ results: { columns: ["name"], rows: [] } }], success: true }))

    const [error, plan] = await readMigrationPlan(database, { env: d1Env, fetch: request, projectRoot: rootDir })

    expect(error).toBeUndefined()
    expect(plan?.pending.map(migration => migration.name)).toEqual([init])
  }, 60_000)
})

const d1Env = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" }

/** A D1 HTTP `/query` endpoint backed by a SQLite file. Like D1, a request with many statements changes all or nothing. */
async function createFakeD1(rootDir: string, setup?: string) {
  const client = createClient({ url: `file:${join(rootDir, "d1.db")}` })
  if (setup) await client.executeMultiple(setup)
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { params, sql } = JSON.parse(String(init?.body)) as { params: InArgs, sql: string }
    if (/^\s*SELECT/i.test(sql)) {
      const result = await client.execute({ args: params, sql })
      const results = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))
      return Response.json({ result: [{ results, success: true }], success: true })
    }
    try {
      await client.executeMultiple(`BEGIN;\n${sql}\nCOMMIT;`)
    }
    catch (error) {
      await client.execute("ROLLBACK").catch(() => {})
      return Response.json({ errors: [{ code: 7500, message: String(error) }], result: [], success: false }, { status: 400 })
    }
    return Response.json({ result: [{ results: [], success: true }], success: true })
  })
  const rows = async (sql: string) => {
    const result = await client.execute(sql)
    return result.rows.map(row => result.columns.map((_, index) => row[index]))
  }
  return { client, fetch, rows }
}

describe("vitehub database migrate with D1 over HTTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function handwrittenD1Project(files: Record<string, string>) {
    const project = await createProject()
    project.database.cloudflare = { binding: "DB", databaseId: "database-id", http: true, migrationsDir: project.database.migrationsDir }
    await mkdir(project.database.migrationsDir)
    await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(project.database.migrationsDir, name), sql)))
    return { ...project, migrate: (args: string[] = [], env: NodeJS.ProcessEnv = d1Env) => project.run("migrate", args, env) }
  }

  it.each(["literal", "environment"])("checks and applies migrations at the configured %s proxy target", async (mode) => {
    const project = await handwrittenD1Project({
      "0000_init.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);",
      "0001_add_body.sql": "ALTER TABLE notes ADD body TEXT;",
    })
    const url = "https://proxy.example.test/d1/raw?database=notes"
    project.database.cloudflare!.http = mode === "literal"
      ? { authToken: "proxy-token", url }
      : { authToken: createRuntimeEnvConfigValue(["D1_PROXY_TOKEN"]), url: createRuntimeEnvConfigValue(["D1_PROXY_URL"]) }
    const env = { ...(mode === "literal" ? d1Env : {}), D1_PROXY_TOKEN: "proxy-token", D1_PROXY_URL: url }
    const d1 = await createFakeD1(project.rootDir, "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE d1_migrations (name TEXT UNIQUE); INSERT INTO d1_migrations VALUES ('0000_init.sql');")
    vi.stubGlobal("fetch", d1.fetch)
    try {
      const dryRun = await project.migrate(["--dry-run"], env)
      expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
      expect(dryRun.stdout).toContain("(D1 HTTP proxy https://proxy.example.test/d1/raw): 1 pending migration.")
      expect(dryRun.stdout).toContain("1 pending migration.")
      expect(dryRun.stdout).toContain("0001_add_body")
      expect(dryRun.stdout).not.toContain("0000_init")
      await expect(d1.rows("SELECT name FROM pragma_table_info('notes')")).resolves.toEqual([["id"], ["title"]])

      await expect(project.migrate([], env)).resolves.toMatchObject({ exitCode: 0, stderr: "" })
      await expect(d1.rows("SELECT name FROM pragma_table_info('notes')")).resolves.toEqual([["id"], ["title"], ["body"]])
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY rowid")).resolves.toEqual([["0000_init.sql"], ["0001_add_body.sql"]])
      for (const [requestedUrl, init] of d1.fetch.mock.calls) {
        expect(requestedUrl).toBe(url)
        expect(init?.headers).toMatchObject({ Authorization: "Bearer proxy-token" })
      }
    }
    finally {
      d1.client.close()
    }
  })

  it("checks and applies numbered files in Wrangler order before unnumbered files", async () => {
    const project = await handwrittenD1Project({
      "!last.sql": "INSERT INTO notes (body) VALUES ('ready');",
      "0002_second.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY);",
      "10_tenth.sql": "ALTER TABLE notes ADD body TEXT;",
      "2_second.sql": "ALTER TABLE notes ADD title TEXT;",
      "z_last.sql": "INSERT INTO notes (body) VALUES ('done');",
    })
    const names = ["0002_second", "2_second", "10_tenth", "!last", "z_last"]
    const d1 = await createFakeD1(project.rootDir)
    vi.stubGlobal("fetch", d1.fetch)
    try {
      const [error, plan] = await readMigrationPlan(project.database, { env: d1Env, fetch: d1.fetch, projectRoot: project.rootDir })
      expect(error).toBeUndefined()
      expect(plan?.pending.map(migration => migration.name)).toEqual(names)

      await expect(project.migrate()).resolves.toMatchObject({ exitCode: 0, stderr: "" })
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual(names.map(name => [`${name}.sql`]))
      await expect(d1.rows("SELECT body FROM notes ORDER BY id")).resolves.toEqual([["ready"], ["done"]])
    }
    finally {
      d1.client.close()
    }
  })

  it("normalizes CRLF compound SQL without changing quoted values or identifiers", async () => {
    const lines = [
      "-- A comment with ' and \" quotes",
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);",
      "/* A comment with ' and [ quotes */",
      "CREATE TABLE audit (title TEXT, \"double\r\nquoted\" TEXT, `backtick\r\nquoted` TEXT, [bracket\r\nquoted] TEXT);",
      "CREATE TRIGGER log_note AFTER INSERT ON notes",
      "BEGIN",
      "  INSERT INTO audit (title) VALUES ('first\r\nsecond''s');",
      "  INSERT INTO audit (title) VALUES (NEW.title);",
      "END;",
      "INSERT INTO notes (title) VALUES ('hello');",
    ]
    const project = await handwrittenD1Project({ "0001_trigger.sql": lines.join("\r\n") })
    const d1 = await createFakeD1(project.rootDir)
    vi.stubGlobal("fetch", d1.fetch)
    try {
      await expect(project.migrate()).resolves.toMatchObject({ exitCode: 0, stderr: "" })
      const migration = d1.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { sql: string }).find(({ sql }) => sql.includes("CREATE TRIGGER"))
      expect(migration?.sql).toBe(`${lines.join("\n")}\n;\nINSERT INTO "d1_migrations" (name) VALUES ('0001_trigger.sql');`)
      await expect(d1.rows("SELECT title FROM audit ORDER BY rowid")).resolves.toEqual([["first\r\nsecond's"], ["hello"]])
      await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([["0001_trigger.sql"]])
    }
    finally {
      d1.client.close()
    }
  })

  async function d1MigrateProject(migrationsTable?: string) {
    const project = await createProject()
    project.database.cloudflare = { binding: "DB", databaseId: "database-id", http: true, migrationsDir: project.database.migrationsDir, ...(migrationsTable ? { migrationsTable } : {}) }
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    const [initTag] = await migrationTags(project.database.migrationsDir)
    const init = await readFile(join(project.database.migrationsDir, initTag!, "migration.sql"), "utf8")
    await project.writeSchema(["title", "body"])
    await nextSecond()
    await expect(project.run("generate", ["--name", "add_body"])).resolves.toMatchObject({ exitCode: 0 })
    const [, addBodyTag] = await migrationTags(project.database.migrationsDir)
    const env = { ...process.env, ...d1Env }
    return { ...project, addBodyTag: addBodyTag!, init, initTag: initTag!, migrate: (args: string[] = []) => project.run("migrate", args, env) }
  }

  it("applies only the migrations that Wrangler's ledger lacks", async () => {
    const project = await d1MigrateProject()
    // `wrangler d1 migrations apply` applied the first migration.
    const d1 = await createFakeD1(project.rootDir, `${project.init};\nCREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');`)
    vi.stubGlobal("fetch", d1.fetch)

    const dryRun = await project.migrate(["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain("(Cloudflare D1 database-id over HTTP): 1 pending migration.")
    expect(dryRun.stdout).toContain(`  ${project.addBodyTag}\n    ALTER TABLE \`notes\` ADD \`body\` text;`)

    const applied = await project.migrate()
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    expect(applied.stdout).toContain(`[vitehub] Database "default": applied 0001_add_body.sql.`)
    await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_add_body.sql"]])
    await expect(d1.rows("SELECT name FROM pragma_table_info('notes')")).resolves.toEqual([["id"], ["title"], ["body"]])
    await expect(d1.rows("SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'")).resolves.toEqual([])

    await expect(project.migrate(["--dry-run"])).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("no pending migrations.") })
    d1.client.close()
  }, 120_000)

  it("creates the configured migrations table on a new database", async () => {
    const project = await d1MigrateProject("custom_migrations")
    const d1 = await createFakeD1(project.rootDir)
    vi.stubGlobal("fetch", d1.fetch)

    await expect(project.migrate()).resolves.toMatchObject({ exitCode: 0, stderr: "" })

    await expect(d1.rows("SELECT name FROM custom_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_add_body.sql"]])
    await expect(d1.rows("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).resolves.toEqual([])
    d1.client.close()
  }, 120_000)

  it("keeps the Wrangler names of migrations that drizzle-kit up converted, so they do not run again", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    project.database.cloudflare = { binding: "DB", databaseId: "database-id", http: true, migrationsDir }
    // Drizzle Kit 0.31 wrote these, and Wrangler applied them as `0000_init.sql` and `0001_add_body.sql`.
    await cp(join(import.meta.dirname, "fixtures/drizzle-kit-0x-migrations"), migrationsDir, { recursive: true })
    const kit = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs")
    await expect(realSpawn(process.execPath, [kit, "up", "--dialect", "sqlite", "--out", migrationsDir], { cwd: project.rootDir })).resolves.toEqual({ exitCode: 0 })
    expect(existsSync(join(migrationsDir, "meta"))).toBe(false)
    await project.writeSchema(["title", "body", "tags"])
    await nextSecond()
    await expect(project.run("generate", ["--name", "add_tags"])).resolves.toMatchObject({ exitCode: 0 })

    const staged = join(project.rootDir, "staged")
    await copyD1MigrationFiles(migrationsDir, staged)
    expect((await readdir(staged)).sort()).toEqual(["0000_init.sql", "0001_add_body.sql", "0002_add_tags.sql"])
    expect(Object.values(JSON.parse(await readFile(join(migrationsDir, d1MigrationNamesFile), "utf8"))).sort()).toEqual(["0000_init.sql", "0001_add_body.sql", "0002_add_tags.sql"])
    await expect(readFile(join(staged, "0000_init.sql"), "utf8")).resolves.toBe(await readFile(join(import.meta.dirname, "fixtures/drizzle-kit-0x-migrations/0000_init.sql"), "utf8"))

    const d1 = await createFakeD1(project.rootDir, [
      "CREATE TABLE notes (id integer PRIMARY KEY NOT NULL, title text, body text);",
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
      "INSERT INTO d1_migrations (name) VALUES ('0000_init.sql'), ('0001_add_body.sql');",
    ].join("\n"))
    vi.stubGlobal("fetch", d1.fetch)
    try {
      const applied = await project.run("migrate", [], { ...process.env, ...d1Env })
      expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
      expect(applied.stdout).toContain("applied 0002_add_tags.sql.")
      expect(applied.stdout).not.toContain("applied 0000_init.sql.")
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_add_body.sql"], ["0002_add_tags.sql"]])
      await expect(d1.rows("SELECT name FROM pragma_table_info('notes')")).resolves.toEqual([["id"], ["title"], ["body"], ["tags"]])
    }
    finally {
      d1.client.close()
    }
  }, 120_000)

  it("upgrades the merged Console D1 history without replaying applied migrations", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    project.database.cloudflare = { binding: "DB", databaseId: "database-id", http: true, migrationsDir }
    await cp(join(import.meta.dirname, "../../console/server/databases/default/migrations"), migrationsDir, { recursive: true })
    const initial = await readFile(join(migrationsDir, "20261109200643_left_namorita/migration.sql"), "utf8")
    const triggers = await readFile(join(migrationsDir, "20261111050000_keep_sign_in_method/migration.sql"), "utf8")
    // Main applied these exact SQL files under these names before conversion to RC folders.
    const d1 = await createFakeD1(project.rootDir, [
      initial,
      triggers,
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
      "INSERT INTO d1_migrations (name) VALUES ('0000_careful_stature.sql'), ('0001_keep_sign_in_method.sql');",
    ].join("\n"))
    vi.stubGlobal("fetch", d1.fetch)
    try {
      const applied = await project.run("migrate", ["--allow-data-loss"], { ...process.env, ...d1Env })
      expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
      expect(applied.stdout).toContain("applied 0002_sign_project_calls.sql.")
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([
        ["0000_careful_stature.sql"], ["0001_keep_sign_in_method.sql"], ["0002_sign_project_calls.sql"],
      ])
      const columns = (await d1.rows("SELECT name FROM pragma_table_info('console_projects')")).flat()
      expect(columns).toContain("key_sealed")
      expect(columns).toContain("public_key")
      expect(columns).not.toContain("token_sealed")
      await expect(project.run("migrate", ["--dry-run"], { ...process.env, ...d1Env })).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("no pending migrations.") })

      const staged = join(project.rootDir, "staged")
      await copyD1MigrationFiles(migrationsDir, staged)
      expect((await readdir(staged)).sort()).toEqual(["0000_careful_stature.sql", "0001_keep_sign_in_method.sql", "0002_sign_project_calls.sql"])
      await expect(readFile(join(staged, "0000_careful_stature.sql"), "utf8")).resolves.toBe(initial)
    }
    finally {
      d1.client.close()
    }
  }, 120_000)

  it("keeps Wrangler names in d1-migrations.json, so a folder merged with an earlier timestamp takes the next number", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    const folder = async (tag: string, sql: string) => {
      await mkdir(join(migrationsDir, tag), { recursive: true })
      await writeFile(join(migrationsDir, tag, "migration.sql"), sql)
    }
    await folder("20261109120000_init", "CREATE TABLE notes (id integer);")
    // The build stages the folders and records their names. The user commits the file with the migrations.
    await copyD1MigrationFiles(migrationsDir, join(project.rootDir, "staged-1"))
    await expect(readFile(join(migrationsDir, d1MigrationNamesFile), "utf8")).resolves.toBe('{\n  "20261109120000_init": "0000_init.sql"\n}\n')

    // Another branch generated a folder before init's timestamp. It gets the next number, and init keeps its name.
    await folder("20261001000000_early", "SELECT 1;")
    expect(listD1Migrations(migrationsDir).map(file => [file.tag, file.name])).toEqual([["20261109120000_init", "0000_init.sql"], ["20261001000000_early", "0001_early.sql"]])
    await copyD1MigrationFiles(migrationsDir, join(project.rootDir, "staged-2"))
    expect((await readdir(join(project.rootDir, "staged-2"))).sort()).toEqual(["0000_init.sql", "0001_early.sql"])
    await expect(readFile(join(project.rootDir, "staged-2/0000_init.sql"), "utf8")).resolves.toBe("CREATE TABLE notes (id integer);")
    expect(JSON.parse(await readFile(join(migrationsDir, d1MigrationNamesFile), "utf8"))).toEqual({ "20261001000000_early": "0001_early.sql", "20261109120000_init": "0000_init.sql" })

    // A merge that gives two folders one name fails instead of staging one file over the other.
    await writeFile(join(migrationsDir, d1MigrationNamesFile), JSON.stringify({ "20261001000000_early": "0000_init.sql", "20261109120000_init": "0000_init.sql" }))
    expect(() => listD1Migrations(migrationsDir)).toThrow("gives two migrations the Wrangler name 0000_init.sql")

    // A merge conflict leaves markers in the file. The error names the file instead of a bare SyntaxError.
    await writeFile(join(migrationsDir, d1MigrationNamesFile), '{\n<<<<<<< HEAD\n  "20261001000000_early": "0001_early.sql"\n=======\n  "20261002000000_other": "0001_other.sql"\n>>>>>>> branch\n}\n')
    expect(() => listD1Migrations(migrationsDir)).toThrow(`${join(migrationsDir, d1MigrationNamesFile)} is not valid JSON. Fix the JSON.`)
  })

  it("records the Wrangler names when vitehub database generate writes a D1 migration", async () => {
    const project = await createProject()
    project.database.cloudflare = { binding: "DB", migrationsDir: project.database.migrationsDir }
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    const [init] = await migrationTags(project.database.migrationsDir)
    expect(JSON.parse(await readFile(join(project.database.migrationsDir, d1MigrationNamesFile), "utf8"))).toEqual({ [init!]: "0000_init.sql" })
  }, 60_000)

  it("refuses a migration folder that renumbers migrations Wrangler applied", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    project.database.cloudflare = { binding: "DB", databaseId: "database-id", http: true, migrationsDir }
    for (const [tag, sql] of [["20261109120000_init", "CREATE TABLE notes (id integer);"], ["20261001000000_early", "SELECT 1;"]]) {
      await mkdir(join(migrationsDir, tag!), { recursive: true })
      await writeFile(join(migrationsDir, tag!, "migration.sql"), sql!)
    }
    // `0000_init.sql` was applied when init was the only folder. The early folder now takes number 0000.
    const d1 = await createFakeD1(project.rootDir, "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE); INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');")
    try {
      const [error] = await readMigrationPlan(project.database, { env: d1Env, fetch: d1.fetch, projectRoot: project.rootDir })
      expect(error?.code).toBe("DATABASE_MIGRATION_CHECK_FAILED")
      expect(error?.why).toContain("lists 0000_init.sql, but that migration is now 0001_init.sql (20261109120000_init)")
    }
    finally {
      d1.client.close()
    }
  })

  it("keeps the migrations that Drizzle Kit applied before", async () => {
    const project = await d1MigrateProject()
    // ViteHub wrote Drizzle's ledger as Drizzle Kit 0.x did: no `name`, and `created_at` from the journal in milliseconds.
    const tag = project.initTag
    const folderTime = Date.UTC(Number(tag.slice(0, 4)), Number(tag.slice(4, 6)) - 1, Number(tag.slice(6, 8)), Number(tag.slice(8, 10)), Number(tag.slice(10, 12)), Number(tag.slice(12, 14)))
    const d1 = await createFakeD1(project.rootDir, `${project.init};\nCREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC); INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('hash', ${folderTime + 417});`)
    vi.stubGlobal("fetch", d1.fetch)

    await expect(project.migrate()).resolves.toMatchObject({ exitCode: 0, stderr: "" })

    await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_add_body.sql"]])
    d1.client.close()
  }, 120_000)

  it("leaves the ledger as it was when a migration fails", async () => {
    const project = await d1MigrateProject()
    const d1 = await createFakeD1(project.rootDir, "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);")
    vi.stubGlobal("fetch", d1.fetch)

    const failed = await project.migrate(["--allow-data-loss"])

    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("[vitehub] D1 migration failed for the database \"default\". Cloudflare D1 returned HTTP 400")
    await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([])
    d1.client.close()
  }, 120_000)
})
