import { spawn as spawnProcess } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"

import type { DbCliIo } from "../src/cli.ts"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

function realSpawn(command: string, args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", exitCode => resolve({ exitCode }))
  })
}

const schemas = {
  postgresql: "import { integer, pgTable, text } from 'drizzle-orm/pg-core'\nexport const notes = pgTable('notes', { id: integer('id').primaryKey(), title: text('title') })\n",
  sqlite: "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'\nexport const notes = sqliteTable('notes', { id: integer('id').primaryKey(), title: text('title') })\n",
}

const sqliteFile = ".vitehub/data/database/sqlite.db"
const pgliteDir = ".vitehub/data/database/pglite"

// The package root has drizzle-kit, @libsql/client, and PGlite in its dependencies, like a project that uses `vitehub database`.
async function createProject(dialect: "postgresql" | "sqlite", io: DbCliIo = {}) {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".db-reset-"))
  tempDirs.push(rootDir)
  const credentials = dialect === "sqlite" ? `dbCredentials: { url: 'file:${sqliteFile}' }` : `driver: 'pglite', dbCredentials: { url: '${pgliteDir}' }`
  await writeFile(join(rootDir, "drizzle.config.ts"), `export default { dialect: '${dialect}', out: './migrations', schema: './schema.ts', ${credentials} }\n`)
  await writeFile(join(rootDir, "schema.ts"), schemas[dialect])
  const database = {
    dialect,
    migrationsDir: join(rootDir, "migrations"),
    name: "default",
    ...dialect === "sqlite" ? { connection: { url: `file:${sqliteFile}` } } : { driver: "pglite" },
  } as ResolvedDrizzleDatabaseConfig
  const databases: Record<string, ResolvedDrizzleDatabaseConfig> = { default: database }
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: Object.keys(databases),
    databases,
    generatedDrizzleConfigFile: join(rootDir, "drizzle.config.ts"),
    generatedDrizzleConfigFilesByDatabase: Object.fromEntries(Object.keys(databases).map(name => [name, join(rootDir, "drizzle.config.ts")])),
    rootDir,
  }) as unknown as ResolvedDBViteConfig, undefined, io)!

  async function run(feature: "generate" | "migrate" | "reset", args: string[] = []) {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === feature)!
    const exitCode = await command.run(args, { env: process.env, rootDir, spawn: realSpawn, stderr, stdout } as never)
    const text = (write: ReturnType<typeof vi.fn>) => write.mock.calls.map(([chunk]) => String(chunk)).join("")
    return { exitCode, stderr: text(stderr.write), stdout: text(stdout.write) }
  }

  /** Runs SQL on the local database and returns the rows of the last statement. */
  async function query(sql: string): Promise<Record<string, unknown>[]> {
    if (dialect === "sqlite") {
      const client = createClient({ url: `file:${join(rootDir, sqliteFile)}` })
      try {
        const results = await client.batch(sql.split(";").filter(part => part.trim()), "write")
        return results.at(-1)!.rows.map(row => ({ ...row }))
      }
      finally {
        client.close()
      }
    }
    const client = new PGlite(join(rootDir, pgliteDir))
    try {
      const results = await client.exec(sql)
      return results.at(-1)!.rows as Record<string, unknown>[]
    }
    finally {
      await client.close()
    }
  }

  const tables = async () => (await query(dialect === "sqlite"
    ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    : "SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY name")).map(row => row.name)

  /** Adds a second database to the resolved config. */
  const addDatabase = (added: ResolvedDrizzleDatabaseConfig) => { databases[added.name] = added }

  return { addDatabase, database, query, rootDir, run, tables }
}

describe.each(["sqlite", "postgresql"] as const)("vitehub database reset on %s", (dialect) => {
  it("drops every table after a yes, then applies the migrations again", async () => {
    const answers = [false, true]
    const confirm = vi.fn(async () => answers.shift()!)
    const project = await createProject(dialect, { confirm })
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await project.query("INSERT INTO notes (id, title) VALUES (1, 'Groceries'); CREATE TABLE scratch (id integer)")
    const before = await project.tables()
    expect(before).toEqual(expect.arrayContaining([expect.stringMatching(/notes$/), expect.stringMatching(/scratch$/)]))

    const refused = await project.run("reset")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("DATABASE_DROP_NOT_CONFIRMED")
    expect(refused.stderr).toContain("`vitehub database reset` drops every table of the database \"default\"")
    expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/^Drop 3 tables and views of the database "default" \((?:local SQLite|PGlite) .+\) and apply its migrations again\? All their data is lost\. \[y\/N\] $/))
    expect(await project.tables()).toEqual(before)
    expect(await project.query("SELECT title FROM notes")).toEqual([{ title: "Groceries" }])

    const reset = await project.run("reset")
    expect(reset).toMatchObject({ exitCode: 0, stderr: "" })
    expect(reset.stdout).toMatch(/dropped .*notes/)
    // The migrated tables are back and empty, and the table that no migration creates is gone.
    expect(await project.tables()).toEqual(before.filter(name => !String(name).endsWith("scratch")))
    expect(await project.query("SELECT title FROM notes")).toEqual([])
  }, 120_000)

  it("needs --yes without a terminal", async () => {
    const project = await createProject(dialect)
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })
    await project.query("INSERT INTO notes (id, title) VALUES (1, 'Groceries')")

    // Vitest has no terminal on stdin, so nothing can confirm.
    const refused = await project.run("reset")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("add `--yes`")
    expect(await project.query("SELECT title FROM notes")).toEqual([{ title: "Groceries" }])

    await expect(project.run("reset", ["--yes"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    expect(await project.query("SELECT title FROM notes")).toEqual([])
  }, 120_000)

  it("creates a database that does not exist yet", async () => {
    const project = await createProject(dialect)
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })

    const reset = await project.run("reset", ["--yes"])
    expect(reset).toMatchObject({ exitCode: 0, stderr: "" })
    expect(reset.stdout).toContain("it does not exist, so there is nothing to drop")
    expect(await project.query("SELECT title FROM notes")).toEqual([])
  }, 120_000)
})

describe("vitehub database reset refusals", () => {
  it("drops nothing when the migrations folder cannot be read", async () => {
    const project = await createProject("sqlite")
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })
    await project.query("INSERT INTO notes (id, title) VALUES (1, 'Groceries')")
    // A migration folder without its SQL file is incomplete history.
    await mkdir(join(project.database.migrationsDir, "20990101000000_broken"))

    const result = await project.run("reset", ["--yes"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("DATABASE_DROP_FAILED")
    expect(result.stderr).toContain("Its migrations cannot be read, so nothing was dropped.")
    expect(await project.query("SELECT title FROM notes")).toEqual([{ title: "Groceries" }])
  }, 120_000)

  it("resets one database of several when another one still has a Drizzle Kit 0.x folder", async () => {
    const project = await createProject("sqlite")
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })
    await project.query("INSERT INTO notes (id, title) VALUES (1, 'Groceries')")
    const legacyDir = join(project.rootDir, "legacy-migrations")
    await mkdir(join(legacyDir, "meta"), { recursive: true })
    await writeFile(join(legacyDir, "meta", "_journal.json"), JSON.stringify({ dialect: "sqlite", entries: [], version: "7" }))
    project.addDatabase({ connection: { url: "file:.vitehub/data/database/legacy.sqlite.db" }, dialect: "sqlite", migrationsDir: legacyDir, name: "legacy" } as ResolvedDrizzleDatabaseConfig)

    const reset = await project.run("reset", ["--database", "default", "--yes"])
    expect(reset).toMatchObject({ exitCode: 0, stderr: "" })
    expect(await project.query("SELECT title FROM notes")).toEqual([])

    // The 0.x folder of the database that `reset` rebuilds stops it before the drop.
    const refused = await project.run("reset", ["--database", "legacy", "--yes"])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("DATABASE_MIGRATIONS_OLD_LAYOUT")
    expect(refused.stdout).not.toContain("dropped")
  }, 120_000)

  it("refuses a remote database without --remote, and the deployed D1 database of a binding", async () => {
    const project = await createProject("sqlite")
    Object.assign(project.database, { connection: { url: "libsql://db.example.turso.io" } })
    const remote = await project.run("reset", ["--yes"])
    expect(remote.exitCode).toBe(1)
    expect(remote.stderr).toContain("DATABASE_DROP_FAILED")
    expect(remote.stderr).toContain("Add `--remote`")

    Object.assign(project.database, { cloudflare: { binding: "DB", databaseName: "notes-app" }, connection: undefined })
    const d1 = await project.run("reset", ["--remote", "--yes"])
    expect(d1.exitCode).toBe(1)
    expect(d1.stderr).toContain("`vitehub database migrate` does not apply migrations to the deployed D1 database of a binding.")
    expect(d1.stderr).toContain("`wrangler d1 migrations apply notes-app --remote`")
  })
})
