import { spawn as spawnProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { createRuntimeEnvConfigValue } from "../src/config-value.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"

import type { InArgs } from "@libsql/client"
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

  async function run(feature: "generate" | "migrate", args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === feature)!
    const exitCode = await command.run(args, { env, rootDir, spawn: realSpawn, stderr, stdout } as never)
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

  it("reads Wrangler's migrations table of D1 over HTTP", async () => {
    const { database, rootDir } = await d1Project()
    const d1 = await createFakeD1(rootDir, "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE); INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');")

    const [error, plan] = await readMigrationPlan(database, { env: d1Env, fetch: d1.fetch, projectRoot: rootDir })

    expect(error).toBeUndefined()
    expect(plan).toEqual({ database: "default", pending: [], target: "Cloudflare D1 database-id over HTTP" })
    expect(d1.fetch).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/accounts/account/d1/database/database-id/query", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
      method: "POST",
    }))
  }, 60_000)

  it("accepts the Cloudflare D1 array row response shape", async () => {
    const { database, rootDir } = await d1Project()
    const request = vi.fn<typeof fetch>(async () => Response.json({ result: [{ results: { columns: ["name"], rows: [] } }], success: true }))

    const [error, plan] = await readMigrationPlan(database, { env: d1Env, fetch: request, projectRoot: rootDir })

    expect(error).toBeUndefined()
    expect(plan?.pending.map(migration => migration.name)).toEqual(["0000_init"])
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

describe("vitehub db migrate with D1 over HTTP", () => {
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
    const init = await readFile(join(project.database.migrationsDir, "0000_init.sql"), "utf8")
    await project.writeSchema(["title", "body"])
    await expect(project.run("generate", ["--name", "add_body"])).resolves.toMatchObject({ exitCode: 0 })
    const env = { ...process.env, ...d1Env }
    return { ...project, init, migrate: (args: string[] = []) => project.run("migrate", args, env) }
  }

  it("applies only the migrations that Wrangler's ledger lacks", async () => {
    const project = await d1MigrateProject()
    // `wrangler d1 migrations apply` applied the first migration.
    const d1 = await createFakeD1(project.rootDir, `${project.init};\nCREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');`)
    vi.stubGlobal("fetch", d1.fetch)

    const dryRun = await project.migrate(["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain("(Cloudflare D1 database-id over HTTP): 1 pending migration.")
    expect(dryRun.stdout).toContain("  0001_add_body\n    ALTER TABLE `notes` ADD `body` text;")

    const applied = await project.migrate()
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    expect(applied.stdout).toContain("[vitehub] Database \"default\": applied 0001_add_body.sql.")
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

  it("keeps the migrations that Drizzle Kit applied before", async () => {
    const project = await d1MigrateProject()
    const journal = JSON.parse(await readFile(join(project.database.migrationsDir, "meta/_journal.json"), "utf8")) as { entries: Array<{ when: number }> }
    const d1 = await createFakeD1(project.rootDir, `${project.init};\nCREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC); INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('hash', ${journal.entries[0]!.when});`)
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
