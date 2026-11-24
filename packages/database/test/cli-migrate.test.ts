import { spawn as spawnProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

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

async function seedDatabase(rootDir: string, sql: string) {
  await mkdir(join(rootDir, ".vitehub/data/database"), { recursive: true })
  const client = createClient({ url: `file:${join(rootDir, ".vitehub/data/database/sqlite.db")}` })
  try {
    await client.executeMultiple(sql)
  }
  finally {
    client.close()
  }
}

async function rows(rootDir: string, sql: string) {
  const client = createClient({ url: `file:${join(rootDir, ".vitehub/data/database/sqlite.db")}` })
  try {
    const result = await client.execute(sql)
    return result.rows.map(row => result.columns.map((_, index) => row[index]))
  }
  finally {
    client.close()
  }
}

async function folder(migrationsDir: string, tag: string, sql: string) {
  await mkdir(join(migrationsDir, tag), { recursive: true })
  await writeFile(join(migrationsDir, tag, "migration.sql"), sql)
}

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

function realSpawn(command: string, args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv, stdin?: "ignore" | "inherit", stdout?: "inherit" | "pipe" } = {}) {
  return new Promise<{ exitCode: number | null, stdout?: string }>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", exitCode => resolve({ exitCode, ...(options.stdout === "pipe" ? { stdout: Buffer.concat(stdout).toString("utf8") } : {}) }))
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

  async function run(feature: "generate" | "migrate" | "reset" | "up", args: string[] = [], env: NodeJS.ProcessEnv = process.env, spawn: typeof realSpawn = realSpawn) {
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

  it("records the unique indexes of 0.x .unique() columns as constraints, so generate keeps the tables", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await cp(join(import.meta.dirname, "fixtures/drizzle-kit-0x-unique"), migrationsDir, { recursive: true })
    // Drizzle Kit 0.x made `members_email_unique` for `.unique()`. `members_slug_idx` stays an index in the schema.
    await writeFile(join(project.rootDir, "schema.ts"), [
      "import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'",
      "export const members = sqliteTable('members', { id: integer('id').primaryKey(), email: text('email').notNull().unique(), slug: text('slug').notNull() }, table => [uniqueIndex('members_slug_idx').on(table.slug)])",
      "",
    ].join("\n"))

    const converted = await project.run("up")
    expect(converted).toMatchObject({ exitCode: 0, stderr: "" })
    const tags = await migrationTags(migrationsDir)
    await expect(project.run("generate")).resolves.toMatchObject({ exitCode: 0 })
    // Without the conversion, Drizzle Kit writes a migration that rebuilds `members` with `email` UNIQUE.
    await expect(migrationTags(migrationsDir)).resolves.toEqual(tags)
    expect(converted.stdout).toContain("[vitehub] Database \"default\": the snapshots record 1 unique index of `.unique()` columns as UNIQUE constraints")
  }, 120_000)

  it("repairs folders that drizzle-kit up converted before ViteHub recorded the constraints, so generate keeps the tables", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await cp(join(import.meta.dirname, "fixtures/drizzle-kit-0x-unique"), migrationsDir, { recursive: true })
    await writeFile(join(project.rootDir, "schema.ts"), [
      "import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'",
      "export const members = sqliteTable('members', { id: integer('id').primaryKey(), email: text('email').notNull().unique(), slug: text('slug').notNull() }, table => [uniqueIndex('members_slug_idx').on(table.slug)])",
      "",
    ].join("\n"))
    // An older ViteHub, or `drizzle-kit up` alone, converted the folder and kept `members_email_unique` as an index.
    const kit = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.js")
    await expect(realSpawn(process.execPath, [kit, "up", "--dialect", "sqlite", "--out", migrationsDir], { cwd: project.rootDir })).resolves.toEqual({ exitCode: 0 })
    await expect(project.run("up")).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("already uses the layout of Drizzle Kit 1.0") })
    const tags = await migrationTags(migrationsDir)

    const generated = await project.run("generate")
    expect(generated).toMatchObject({ exitCode: 0 })
    // Without the repair, Drizzle Kit writes a migration that rebuilds `members` with `email` UNIQUE.
    await expect(migrationTags(migrationsDir)).resolves.toEqual(tags)
    expect(generated.stdout).toContain("[vitehub] Database \"default\": the snapshots record 1 unique index of `.unique()` columns as UNIQUE constraints")
    const snapshot = JSON.parse(await readFile(join(migrationsDir, tags[0]!, "snapshot.json"), "utf8")) as { ddl: { entityType: string, name: string }[] }
    expect(snapshot.ddl.filter(entity => entity.entityType === "indexes").map(entity => entity.name)).toEqual(["members_slug_idx"])

    // The repair runs once: the next generate finds no index of a `.unique()` column.
    const again = await project.run("generate")
    expect(again).toMatchObject({ exitCode: 0 })
    expect(again.stdout).not.toContain("unique index")
    await expect(migrationTags(migrationsDir)).resolves.toEqual(tags)
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
    expect(refused.stderr).toContain("has drizzle-kit 0.31.4. Install the version that ViteHub uses, for example with `pnpm add -D drizzle-kit@1.0.0-rc.6`")
    await expect(readdir(project.database.migrationsDir)).resolves.toContain("meta")
  })

  /** A folder of hand-written Wrangler migrations, as `wrangler d1 migrations create` names them. */
  async function writeWranglerFolder(migrationsDir: string) {
    await mkdir(migrationsDir, { recursive: true })
    // Wrangler runs each file as one script. The trigger body has its own semicolon.
    await writeFile(join(migrationsDir, "0000_init.sql"), [
      "-- Notes and their history.",
      "CREATE TABLE `notes` (`id` integer PRIMARY KEY NOT NULL, `title` text); CREATE TABLE `note_events` (`note_id` integer);",
      "CREATE TRIGGER `notes_insert` AFTER INSERT ON `notes` BEGIN INSERT INTO `note_events` (`note_id`) VALUES (NEW.`id`); END;",
      "",
    ].join("\n"))
    await writeFile(join(migrationsDir, "0001_add_body.sql"), "ALTER TABLE `notes` ADD `body` text;\n")
    await writeFile(join(migrationsDir, "0002_add_tags.sql"), "ALTER TABLE `notes` ADD `tags` text;\n")
  }

  it("converts a folder of hand-written Wrangler SQL files, which migrate refuses before, and keeps their Wrangler names", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    project.database.cloudflare = { binding: "DB", migrationsDir }
    await writeWranglerFolder(migrationsDir)
    await writeFile(join(project.rootDir, "schema.ts"), `${notesSchema(["title", "body", "tags"])}export const noteEvents = sqliteTable('note_events', { noteId: integer('note_id') })\n`)

    // Drizzle Kit 1.0 skips flat files, so a local database would start without tables.
    const refused = await project.run("migrate")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("DATABASE_MIGRATIONS_OLD_LAYOUT")
    expect(refused.stderr).toContain("Run `vitehub database up` once")

    const converted = await project.run("up")
    expect(converted).toMatchObject({ exitCode: 0, stderr: "" })
    expect(converted.stdout).toContain("[vitehub] Database \"default\": converted 3 SQL files in migrations to migration folders. Commit the new folders.")
    const tags = await migrationTags(migrationsDir)
    expect(tags).toEqual([expect.stringMatching(/^\d{14}_0000_init$/), expect.stringMatching(/^\d{14}_0001_add_body$/), expect.stringMatching(/^\d{14}_0002_add_tags$/)])
    await expect(readFile(join(migrationsDir, tags[1]!, "migration.sql"), "utf8")).resolves.toBe("ALTER TABLE `notes` ADD `body` text;\n")
    // Wrangler applied these files under their names, so D1 keeps them.
    expect(listD1Migrations(migrationsDir).map(file => file.name)).toEqual(["0000_init.sql", "0001_add_body.sql", "0002_add_tags.sql"])
    expect(JSON.parse(await readFile(join(migrationsDir, d1MigrationNamesFile), "utf8"))).toEqual(Object.fromEntries(tags.map(tag => [tag, `${tag.slice(15)}.sql`])))
    const staged = join(project.rootDir, "wrangler")
    await copyD1MigrationFiles(migrationsDir, staged)
    const wrangler = createClient({ url: ":memory:" })
    try {
      await wrangler.executeMultiple(await readFile(join(staged, "0000_init.sql"), "utf8"))
      await wrangler.execute("INSERT INTO notes (id) VALUES (1)")
      await expect(wrangler.execute("SELECT note_id FROM note_events")).resolves.toMatchObject({ rows: [{ note_id: 1 }] })
    }
    finally {
      wrangler.close()
    }

    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body", "tags"])
    // Drizzle runs every statement of a file, not only the first one.
    const client = createClient({ url: `file:${join(project.rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      await client.execute("INSERT INTO notes (id, title) VALUES (1, 'Hello')")
      await expect(client.execute("SELECT note_id FROM note_events")).resolves.toMatchObject({ rows: [{ note_id: 1 }] })
    }
    finally {
      client.close()
    }
    // The newest folder has the snapshot of the replayed SQL, so Drizzle Kit has no migration to write.
    await expect(project.run("generate")).resolves.toMatchObject({ exitCode: 0 })
    await expect(migrationTags(migrationsDir)).resolves.toEqual(tags)
  }, 120_000)

  it("keeps Definition changes pending after converting flat SQL", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await mkdir(migrationsDir)
    await writeFile(join(migrationsDir, "0000_init.sql"), "CREATE TABLE notes (id integer PRIMARY KEY NOT NULL);")
    await writeFile(join(project.rootDir, "schema.ts"), notesSchema(["body"]))

    await expect(project.run("up")).resolves.toMatchObject({ exitCode: 0 })
    await nextSecond()
    await expect(project.run("generate", ["--name", "add_body"])).resolves.toMatchObject({ exitCode: 0 })
    const tags = await migrationTags(migrationsDir)
    expect(tags).toHaveLength(2)
    await expect(readFile(join(migrationsDir, tags[1]!, "migration.sql"), "utf8")).resolves.toMatch(/ALTER TABLE .*notes.* ADD .*body/i)
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.columns()).resolves.toEqual(["id", "body"])
  }, 120_000)

  it("converts SQL-only history with an empty Definition", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await mkdir(migrationsDir)
    await writeFile(join(migrationsDir, "0000_init.sql"), "CREATE TABLE notes (id integer PRIMARY KEY NOT NULL);")
    await writeFile(join(project.rootDir, "schema.ts"), "export const schema = {}\n")
    await expect(project.run("up")).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.columns()).resolves.toEqual(["id"])
  }, 120_000)

  it("leaves a hand-written Postgres function unchanged", async () => {
    const project = await createProject()
    project.database.dialect = "postgresql"
    const migrationsDir = project.database.migrationsDir
    const sql = "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;"
    await mkdir(migrationsDir)
    await writeFile(join(migrationsDir, "0000_init.sql"), sql)
    const converted = await project.run("up")
    expect(converted.exitCode).toBe(1)
    expect(converted.stderr).toContain("Only SQLite and D1 support conversion of hand-written SQL")
    await expect(readdir(migrationsDir)).resolves.toEqual(["0000_init.sql"])
    await expect(readFile(join(migrationsDir, "0000_init.sql"), "utf8")).resolves.toBe(sql)
  })

  it("converts hand-written SQL files next to an incomplete Drizzle Kit 0.x journal, and keeps what Wrangler applied", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await writeWranglerFolder(migrationsDir)
    // Drizzle Kit wrote one migration and its first snapshot. The other files were written by hand.
    await mkdir(join(migrationsDir, "meta"))
    await writeFile(join(migrationsDir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries: [{ idx: 0, version: "6", when: 1794258506219, tag: "0001_add_body", breakpoints: true }] }))
    await cp(join(drizzleKit0xFixture, "meta/0000_snapshot.json"), join(migrationsDir, "meta/0000_snapshot.json"))
    await project.writeSchema(["title", "body", "tags"])
    // `wrangler d1 migrations apply --local` applied the first two files.
    await mkdir(join(project.rootDir, ".vitehub/data/database"), { recursive: true })
    const client = createClient({ url: `file:${join(project.rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      await client.executeMultiple([
        await readFile(join(migrationsDir, "0000_init.sql"), "utf8"),
        await readFile(join(migrationsDir, "0001_add_body.sql"), "utf8"),
        "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        "INSERT INTO d1_migrations (name) VALUES ('0000_init.sql'), ('0001_add_body.sql');",
      ].join("\n"))
    }
    finally {
      client.close()
    }

    // `drizzle-kit up` fails here with "No snapshot was found", because the journal names a snapshot that does not exist.
    const converted = await project.run("up")
    expect(converted).toMatchObject({ exitCode: 0, stderr: "" })
    const tags = await migrationTags(migrationsDir)
    expect(tags).toHaveLength(3)
    await expect(readdir(migrationsDir)).resolves.toEqual(tags)

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun.stdout).toContain(`1 pending migration.\n  Applied before, as d1_migrations lists: ${tags[0]}, ${tags[1]}\n`)
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body", "tags"])
  }, 120_000)

  it("leaves the folder as it was when Drizzle Kit cannot read the Definitions", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await writeWranglerFolder(migrationsDir)
    await writeFile(join(project.rootDir, "schema.ts"), "export const notes = (\n")

    const failed = await project.run("up")
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("DATABASE_MIGRATION_CONVERSION_FAILED")
    expect(failed.stderr).toContain("Drizzle Kit could not read the current Database Definitions")
    await expect(readdir(migrationsDir)).resolves.toEqual(["0000_init.sql", "0001_add_body.sql", "0002_add_tags.sql"])
  }, 120_000)

  it.each([1_000, 3_000])("preserves a Drizzle 0.x ledger with journal entries %i ms apart", async (gap) => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    const journal = join(migrationsDir, "meta", "_journal.json")
    const first = 1_700_000_000_000
    const init = "CREATE TABLE notes (id integer PRIMARY KEY NOT NULL);"
    const addBody = "ALTER TABLE notes ADD body text;"
    const files = ["0000_init.sql", "0001_add_title.sql", "0002_add_body.sql"]
    await mkdir(dirname(journal), { recursive: true })
    await writeFile(join(migrationsDir, files[0]!), init)
    await writeFile(join(migrationsDir, files[1]!), "ALTER TABLE notes ADD title text;")
    await writeFile(join(migrationsDir, files[2]!), addBody)
    await writeFile(journal, JSON.stringify({ entries: [{ tag: "0000_init", when: first }, { tag: "0002_add_body", when: first + gap }] }))
    await writeFile(join(project.rootDir, "schema.ts"), notesSchema(["title", "body"]))

    await mkdir(join(project.rootDir, ".vitehub/data/database"), { recursive: true })
    const client = createClient({ url: `file:${join(project.rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      await client.executeMultiple(`${init} ${addBody} CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at numeric);`)
      for (const [sql, when] of [[init, first], [addBody, first + gap]] as const) {
        await client.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [createHash("sha256").update(sql).digest("hex"), when] })
      }
      const converted = await project.run("up")
      if (gap === 1_000) {
        expect(converted.exitCode).toBe(1)
        expect(converted.stderr).toContain("DATABASE_MIGRATION_CONVERSION_FAILED")
        expect(converted.stderr).toContain("without changing its recorded timestamp")
        await expect(readdir(migrationsDir)).resolves.toEqual([...files, "meta"])
        await expect(project.columns()).resolves.toEqual(["id", "body"])
      }
      else {
        expect(converted).toMatchObject({ exitCode: 0, stderr: "" })
        const dryRun = await project.run("migrate", ["--dry-run"])
        expect(dryRun.exitCode).toBe(0)
        expect(dryRun.stdout).toContain("1 pending migration.")
        expect(dryRun.stdout).toContain("0001_add_title")
        await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })
        await expect(project.columns()).resolves.toEqual(["id", "body", "title"])
      }
    }
    finally {
      client.close()
    }
  }, 120_000)

  it("stops migrate on start and test mode at a folder of Wrangler SQL files", async () => {
    const project = await createProject()
    await writeWranglerFolder(project.database.migrationsDir)
    const config = { databaseNames: ["default"], databases: { default: project.database }, rootDir: project.rootDir } as unknown as ResolvedDBViteConfig

    expect(() => renderMigrateOnStartPlugin(config, { databases: ["default"], registryImport: "db", migrationsImport: "migrations", runtimeImport: "runtime" })).toThrow(expect.objectContaining({ code: "DATABASE_MIGRATIONS_OLD_LAYOUT" }))
    const client = createTestDatabaseClient(project.rootDir, "migrations")
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_OLD_LAYOUT" })
  })

  it("stops migrate on start and test mode at a Drizzle Kit 0.x folder", async () => {
    const project = await createProject()
    await cp(drizzleKit0xFixture, project.database.migrationsDir, { recursive: true })
    const config = { databaseNames: ["default"], databases: { default: project.database }, rootDir: project.rootDir } as unknown as ResolvedDBViteConfig

    expect(() => renderMigrateOnStartPlugin(config, { databases: ["default"], registryImport: "db", migrationsImport: "migrations", runtimeImport: "runtime" })).toThrow(expect.objectContaining({
      code: "DATABASE_MIGRATIONS_OLD_LAYOUT",
      why: expect.stringContaining(`The migrations of the database "default" in ${project.database.migrationsDir} use the layout of Drizzle Kit 0.x`),
    }))
    const shipped = JSON.parse(renderShippedMigrationsModule(config, { allowDataLoss: false }).replace(/^export default /, ""))
    expect(shipped.databases.default).toEqual({ problem: expect.stringContaining(`The migrations of the database "default" in ${project.database.migrationsDir} use the layout of Drizzle Kit 0.x`) })
    const client = createTestDatabaseClient(project.rootDir, "migrations")
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_OLD_LAYOUT" })
  })
})

describe("vitehub database generate", () => {
  async function projectWithAmbiguousChange() {
    const project = await createProject()
    await project.writeSchema(["title", "body"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await project.writeSchema(["title", "content"])
    await nextSecond()
    return project
  }

  it("fails without a terminal with the changes to answer, and writes no migration", async () => {
    const project = await projectWithAmbiguousChange()
    const before = await migrationTags(project.database.migrationsDir)

    const result = await project.run("generate", ["--name", "notes_content"])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("DATABASE_GENERATE_AMBIGUOUS_CHANGE")
    expect(result.stderr).toContain("The Definitions of the database \"default\" add a column or table and remove another one")
    expect(result.stderr).toContain("The changes to answer:\n  - column public.notes.content")
    expect(result.stderr).toContain(`rename: vitehub database generate --name notes_content --hints '[{"type":"rename","kind":"column","from":["public","notes","<old_name>"],"to":["public","notes","content"]}]'`)
    expect(result.stderr).toContain(`create: vitehub database generate --name notes_content --hints '[{"type":"create","kind":"column","entity":["public","notes","content"]}]'`)
    expect(result.stderr).not.toContain("drizzle-kit generate failed")
    await expect(migrationTags(project.database.migrationsDir)).resolves.toEqual(before)
  }, 120_000)

  it("writes the migration that --hints chooses", async () => {
    const project = await projectWithAmbiguousChange()
    const rename = [{ type: "rename", kind: "column", from: ["public", "notes", "body"], to: ["public", "notes", "content"] }]
    await expect(project.run("generate", ["--name", "rename_body", "--hints", JSON.stringify(rename)])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    const renamed = (await migrationTags(project.database.migrationsDir)).at(-1)!
    expect(renamed).toMatch(/_rename_body$/)
    await expect(readFile(join(project.database.migrationsDir, renamed, "migration.sql"), "utf8")).resolves.toBe("ALTER TABLE `notes` RENAME COLUMN `body` TO `content`;")
  }, 120_000)

  it("reads --hints-file and keeps it in the commands of the error", async () => {
    const project = await projectWithAmbiguousChange()
    const file = join(project.rootDir, "hints.json")
    await writeFile(file, "[]")
    const missing = await project.run("generate", ["--hints-file", file])
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain(`Add one answer per change to the array in ${file}, then run vitehub database generate --hints-file ${file}:`)
    expect(missing.stderr).toContain(`create: {"type":"create","kind":"column","entity":["public","notes","content"]}`)

    await writeFile(file, JSON.stringify([{ type: "create", kind: "column", entity: ["public", "notes", "content"] }]))
    await expect(project.run("generate", ["--name", "new_content", "--hints-file", file])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    const created = (await migrationTags(project.database.migrationsDir)).at(-1)!
    const sql = await readFile(join(project.database.migrationsDir, created, "migration.sql"), "utf8")
    expect(sql).toContain("ADD `content` text")
    expect(sql).toContain("DROP COLUMN `body`")
  }, 120_000)

  it("generates a change that needs no answer with CI set, and never lets Drizzle Kit read stdin", async () => {
    const project = await createProject()
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await project.writeSchema(["title", "body"])
    await nextSecond()

    const spawn = vi.fn(realSpawn)
    await expect(project.run("generate", ["--name", "add_body"], { ...process.env, CI: "1" }, spawn)).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![2]).toMatchObject({ stdin: "ignore" })
    const added = (await migrationTags(project.database.migrationsDir)).at(-1)!
    await expect(readFile(join(project.database.migrationsDir, added, "migration.sql"), "utf8")).resolves.toBe("ALTER TABLE `notes` ADD `body` text;")
  }, 120_000)

  it("gives Drizzle Kit the terminal for its questions, unless CI is set", async () => {
    const project = await createProject()
    const spawn = vi.fn<typeof realSpawn>(async () => ({ exitCode: 0 }))
    const env = { ...process.env, CI: undefined }
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
    try {
      await project.run("generate", [], env, spawn)
      await project.run("generate", [], { ...env, CI: "false" }, spawn)
      await project.run("generate", [], { ...env, CI: "true" }, spawn)
    }
    finally {
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
    }
    expect(spawn.mock.calls.map(([, , options]) => options?.stdin)).toEqual([undefined, undefined, "ignore"])
  })

  it("fails for the removed --non-interactive and names what replaces it", async () => {
    const project = await createProject()
    const spawn = vi.fn<typeof realSpawn>(async () => ({ exitCode: 0 }))
    const result = await project.run("generate", ["--non-interactive"], process.env, spawn)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--non-interactive was removed")
    expect(result.stderr).toContain("CI=1")
    expect(spawn).not.toHaveBeenCalled()
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

  it("applies every statement of a custom migration written without breakpoints", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await project.writeSchema(["title"])
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await nextSecond()
    await expect(project.run("generate", ["--custom", "--name", "seed"])).resolves.toMatchObject({ exitCode: 0 })
    const [, seed] = await migrationTags(migrationsDir)
    const file = join(migrationsDir, seed!, "migration.sql")
    const sql = [
      await readFile(file, "utf8"),
      "CREATE TABLE `note_events` (`note_id` integer);",
      "CREATE TRIGGER `notes_insert` AFTER INSERT ON `notes` BEGIN INSERT INTO `note_events` (`note_id`) VALUES (NEW.`id`); END;",
      "INSERT INTO `notes` (`id`, `title`) VALUES (1, 'Groceries');",
      "INSERT INTO `notes` (`id`, `title`) VALUES (2, 'Rent');",
      "",
    ].join("\n")
    await writeFile(file, sql)
    const config = { databaseNames: ["default"], databases: { default: project.database }, rootDir: project.rootDir } as unknown as ResolvedDBViteConfig

    const shipped = JSON.parse(renderShippedMigrationsModule(config, { allowDataLoss: false }).replace(/^export default /, ""))
    expect(shipped.databases.default.migrations[1].statements).toHaveLength(4)
    const testClient = createTestDatabaseClient(project.rootDir, "migrations")
    try {
      await expect(testClient.execute("SELECT note_id FROM note_events ORDER BY note_id")).resolves.toMatchObject({ rows: [{ note_id: 1 }, { note_id: 2 }] })
    }
    finally {
      testClient.close()
    }

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun.stdout).toContain("INSERT INTO `notes` (`id`, `title`) VALUES (2, 'Rent');")
    await expect(readFile(file, "utf8")).resolves.not.toContain("--> statement-breakpoint")

    const migrated = await project.run("migrate")
    expect(migrated).toMatchObject({ exitCode: 0, stderr: "" })
    expect(migrated.stdout).toContain(`[vitehub] Database "default": applied ${seed}.\n`)
    const client = createClient({ url: `file:${join(project.rootDir, ".vitehub/data/database/sqlite.db")}` })
    try {
      await expect(client.execute("SELECT note_id FROM note_events ORDER BY note_id")).resolves.toMatchObject({ rows: [{ note_id: 1 }, { note_id: 2 }] })
    }
    finally {
      client.close()
    }
    await expect(readFile(file, "utf8")).resolves.toBe(sql)
    await expect(rows(project.rootDir, `SELECT hash FROM __drizzle_migrations WHERE name = '${seed}'`)).resolves.toEqual([[createHash("sha256").update(sql).digest("hex")]])
  }, 120_000)

  it("matches a legacy ledger by the original hash when two folders share a second", async () => {
    const project = await createProject()
    const applied = "20231114221320_init"
    const pending = "20231114221320_seed"
    const init = "CREATE TABLE notes (id INTEGER PRIMARY KEY); INSERT INTO notes VALUES (1);"
    const seed = "INSERT INTO notes VALUES (2); INSERT INTO notes VALUES (3);"
    const hash = (sql: string) => createHash("sha256").update(sql).digest("hex")
    await folder(project.database.migrationsDir, applied, init)
    await folder(project.database.migrationsDir, pending, seed)
    await seedDatabase(project.rootDir, [
      init,
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);",
      `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash(init)}', ${Date.UTC(2023, 10, 14, 22, 13, 20)});`,
    ].join("\n"))

    await expect(project.run("migrate", ["--dry-run"])).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("1 pending migration.") })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(rows(project.rootDir, "SELECT id FROM notes ORDER BY id")).resolves.toEqual([[1], [2], [3]])
    await expect(rows(project.rootDir, "SELECT name, hash FROM __drizzle_migrations ORDER BY id")).resolves.toEqual([[applied, hash(init)], [pending, hash(seed)]])
    await expect(readFile(join(project.database.migrationsDir, applied, "migration.sql"), "utf8")).resolves.toBe(init)
    await expect(readFile(join(project.database.migrationsDir, pending, "migration.sql"), "utf8")).resolves.toBe(seed)
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

describe("vitehub database migrate with an existing migrations table", () => {
  it("keeps the migrations that NuxtHub recorded in _hub_migrations, and applies the next one", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await cp(drizzleKit0xFixture, migrationsDir, { recursive: true })
    await project.writeSchema(["title", "body"])
    await expect(project.run("up")).resolves.toMatchObject({ exitCode: 0 })
    const tags = await migrationTags(migrationsDir)
    // NuxtHub applied both files and recorded each name without `.sql`.
    await seedDatabase(project.rootDir, [
      await readFile(join(drizzleKit0xFixture, "0000_init.sql"), "utf8"),
      await readFile(join(drizzleKit0xFixture, "0001_add_body.sql"), "utf8"),
      "CREATE TABLE _hub_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
      "INSERT INTO _hub_migrations (name) VALUES ('0000_init'), ('0001_add_body');",
    ].join("\n"))

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain(`no pending migrations.\n  Applied before, as _hub_migrations lists: ${tags.join(", ")}\n`)
    await expect(rows(project.rootDir, "SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'")).resolves.toEqual([])

    await project.writeSchema(["title", "body", "tags"])
    await nextSecond()
    await expect(project.run("generate", ["--name", "add_tags"])).resolves.toMatchObject({ exitCode: 0 })
    const applied = await project.run("migrate")
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    for (const tag of tags) expect(applied.stdout).toContain(`[vitehub] Database "default": recorded ${tag} as applied, as _hub_migrations lists it.`)
    await expect(project.columns()).resolves.toEqual(["id", "title", "body", "tags"])
    const all = await migrationTags(migrationsDir)
    await expect(rows(project.rootDir, "SELECT name FROM __drizzle_migrations ORDER BY id")).resolves.toEqual(all.map(tag => [tag]))

    const again = await project.run("migrate")
    expect(again).toMatchObject({ exitCode: 0, stderr: "", stdout: "[vitehub] Database \"default\" (local SQLite .vitehub/data/database/sqlite.db): no pending migrations.\n" })
  }, 120_000)

  it("keeps Wrangler's d1_migrations rows of old flat files and Drizzle Kit 0.x rows, and applies the rest", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    // The folders keep the old flat file names, such as `0000_init.sql`, after the timestamp.
    await folder(migrationsDir, "20261027095547_0000_init", "CREATE TABLE notes (id integer PRIMARY KEY, title text);")
    await folder(migrationsDir, "20261031111000_0001_add_body", "ALTER TABLE notes ADD body text;")
    await folder(migrationsDir, "20261031111000_0002_add_tags", "ALTER TABLE notes ADD tags text;")
    // Wrangler applied the first file. Drizzle Kit 0.x created its ledger, with no row yet.
    await seedDatabase(project.rootDir, [
      "CREATE TABLE notes (id integer PRIMARY KEY, title text);",
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
      "INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');",
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);",
    ].join("\n"))

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain("2 pending migrations.\n  Applied before, as d1_migrations lists: 20261027095547_0000_init\n")

    const applied = await project.run("migrate")
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    expect(applied.stdout).toContain("recorded 20261027095547_0000_init as applied, as d1_migrations lists it.")
    await expect(project.columns()).resolves.toEqual(["id", "title", "body", "tags"])
    // Drizzle 1.0 upgraded its ledger and named the adopted row.
    await expect(rows(project.rootDir, "SELECT name FROM __drizzle_migrations ORDER BY id")).resolves.toEqual([
      ["20261027095547_0000_init"], ["20261031111000_0001_add_body"], ["20261031111000_0002_add_tags"],
    ])
  }, 120_000)

  it("keeps a migration whose folder was renamed, by the SQL hash in Drizzle's ledger", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await folder(migrationsDir, "20261109120000_init", "CREATE TABLE notes (id integer PRIMARY KEY, title text);")
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await rm(join(migrationsDir, "20261109120000_init"), { recursive: true })
    await folder(migrationsDir, "20261109120500_create_notes", "CREATE TABLE notes (id integer PRIMARY KEY, title text);")
    await folder(migrationsDir, "20261109121000_add_body", "ALTER TABLE notes ADD body text;")

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun.stdout).toContain("1 pending migration.\n  Applied before, as __drizzle_migrations lists: 20261109120500_create_notes\n")

    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.columns()).resolves.toEqual(["id", "title", "body"])
    // The row of the old name gets the new name, so it cannot stand for a later migration with the same SQL.
    await expect(rows(project.rootDir, "SELECT name FROM __drizzle_migrations ORDER BY id")).resolves.toEqual([
      ["20261109120500_create_notes"], ["20261109121000_add_body"],
    ])

    await folder(migrationsDir, "20261109122000_clear_notes", "DELETE FROM notes;")
    await expect(project.run("migrate", ["--allow-data-loss"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await rm(join(migrationsDir, "20261109122000_clear_notes"), { recursive: true })
    await folder(migrationsDir, "20261109122500_clear_notes", "DELETE FROM notes;")
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await seedDatabase(project.rootDir, "INSERT INTO notes (title) VALUES ('added after the rename');")
    await folder(migrationsDir, "20261109123000_clear_notes_again", "DELETE FROM notes;")
    const again = await project.run("migrate", ["--dry-run", "--allow-data-loss"])
    expect(again.stdout).toContain("1 pending migration.\n\n  20261109123000_clear_notes_again\n")
    await expect(project.run("migrate", ["--allow-data-loss"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(rows(project.rootDir, "SELECT count(*) FROM notes")).resolves.toEqual([[0]])
  }, 120_000)

  it("upgrades a Drizzle Kit 0.x ledger before it records adopted rows, so Drizzle does not replay an applied migration", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    const migrations = [
      ["20231114221319_init", "CREATE TABLE cache (value TEXT);"],
      ["20231114221320_clear_cache", "DELETE FROM cache;"],
      ["20231114221321_clear_cache_again", "DELETE FROM cache;"],
      ["20231114221321_index_cache", "CREATE INDEX cache_value_idx ON cache (value);"],
    ] as const
    for (const [tag, sql] of migrations) await folder(migrationsDir, tag, sql)
    const hash = (sql: string) => createHash("sha256").update(sql).digest("hex")
    // A legacy ledger whose `SERIAL PRIMARY KEY` gives no ids. NuxtHub applied the third migration.
    await seedDatabase(project.rootDir, [
      "CREATE TABLE cache (value TEXT);",
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);",
      `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash(migrations[0][1])}', ${Date.UTC(2023, 10, 14, 22, 13, 19, 200)}), ('${hash(migrations[1][1])}', ${Date.UTC(2023, 10, 14, 22, 13, 20, 200)});`,
      "CREATE TABLE _hub_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);",
      "INSERT INTO _hub_migrations (name) VALUES ('0002_clear_cache_again');",
      "INSERT INTO cache (value) VALUES ('kept');",
    ].join("\n"))

    const dryRun = await project.run("migrate", ["--dry-run"])
    expect(dryRun.stdout).toContain("1 pending migration.\n  Applied before, as _hub_migrations lists: 20231114221321_clear_cache_again\n\n  20231114221321_index_cache\n")
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(rows(project.rootDir, "SELECT value FROM cache")).resolves.toEqual([["kept"]])
    await expect(rows(project.rootDir, "SELECT name FROM __drizzle_migrations ORDER BY rowid")).resolves.toEqual(migrations.map(([tag]) => [tag]))
  }, 120_000)

  it("fails the check when _hub_migrations lists a migration that now has another number", async () => {
    const project = await createProject()
    const migrationsDir = project.database.migrationsDir
    await folder(migrationsDir, "20261001000000_early", "SELECT 1;")
    await folder(migrationsDir, "20261109120000_init", "CREATE TABLE notes (id integer);")
    await seedDatabase(project.rootDir, "CREATE TABLE _hub_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE); INSERT INTO _hub_migrations (name) VALUES ('0000_init');")

    const [error] = await readMigrationPlan(project.database, { env: process.env, projectRoot: project.rootDir })
    expect(error?.code).toBe("DATABASE_MIGRATION_CHECK_FAILED")
    expect(error?.why).toContain(`The migrations table _hub_migrations lists 0000_init, but that migration is now 0001_init.sql (20261109120000_init), so ViteHub would apply it again.`)
    expect(error?.why).toContain(`set "20261109120000_init": "0000_init.sql" in it`)
    const refused = await project.run("migrate", ["--allow-data-loss"])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("DATABASE_MIGRATION_CHECK_FAILED")
    await expect(rows(project.rootDir, "SELECT name FROM sqlite_master WHERE name = 'notes'")).resolves.toEqual([])
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
    expect(plan).toEqual({ adopted: [], applied: 1, database: "default", pending: [], target: "Cloudflare D1 database-id over HTTP" })
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
      await client.executeMultiple(`BEGIN;\n${sql}\n;\nCOMMIT;`)
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

  it("resets a D1 HTTP database with flat SQL migrations", async () => {
    const project = await handwrittenD1Project({ "0000_init.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY);" })
    const d1 = await createFakeD1(project.rootDir, "CREATE TABLE notes (id INTEGER PRIMARY KEY); INSERT INTO notes VALUES (1);")
    vi.stubGlobal("fetch", d1.fetch)
    try {
      await expect(project.run("reset", ["--remote", "--yes"], d1Env)).resolves.toMatchObject({ exitCode: 0, stderr: "" })
      await expect(d1.rows("SELECT id FROM notes")).resolves.toEqual([])
      await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([["0000_init.sql"]])
    }
    finally {
      d1.client.close()
    }
  })

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

      await expect(project.migrate(["--allow-data-loss"], env)).resolves.toMatchObject({ exitCode: 0, stderr: "" })
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
    const kit = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.js")
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
        ["0000_careful_stature.sql"], ["0001_keep_sign_in_method.sql"], ["0002_sign_project_calls.sql"], ["0003_comments.sql"], ["0004_cli_auth.sql"], ["0005_site_access.sql"],
      ])
      const columns = (await d1.rows("SELECT name FROM pragma_table_info('console_projects')")).flat()
      expect(columns).toContain("key_sealed")
      expect(columns).toContain("public_key")
      expect(columns).not.toContain("token_sealed")
      await expect(project.run("migrate", ["--dry-run"], { ...process.env, ...d1Env })).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("no pending migrations.") })

      const staged = join(project.rootDir, "staged")
      await copyD1MigrationFiles(migrationsDir, staged)
      expect((await readdir(staged)).sort()).toEqual(["0000_careful_stature.sql", "0001_keep_sign_in_method.sql", "0002_sign_project_calls.sql", "0003_comments.sql", "0004_cli_auth.sql", "0005_site_access.sql"])
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

  it("records the migrations of NuxtHub's _hub_migrations in Wrangler's table", async () => {
    const project = await d1MigrateProject()
    const d1 = await createFakeD1(project.rootDir, `${project.init};\nCREATE TABLE _hub_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO _hub_migrations (name) VALUES ('0000_init');`)
    vi.stubGlobal("fetch", d1.fetch)
    try {
      const dryRun = await project.migrate(["--dry-run"])
      expect(dryRun.stdout).toContain(`1 pending migration.\n  Applied before, as _hub_migrations lists: ${project.initTag}\n`)

      const applied = await project.migrate()
      expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
      expect(applied.stdout).toContain(`recorded ${project.initTag} as applied, as _hub_migrations lists it.`)
      expect(applied.stdout).toContain("applied 0001_add_body.sql.")
      expect(applied.stdout).not.toContain("applied 0000_init.sql.")
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_add_body.sql"]])
      await expect(d1.rows("SELECT name FROM pragma_table_info('notes')")).resolves.toEqual([["id"], ["title"], ["body"]])
    }
    finally {
      d1.client.close()
    }
  }, 120_000)

  it("adds file names to a _hub_migrations table that Wrangler uses, so Wrangler does not apply NuxtHub's names again", async () => {
    const project = await d1MigrateProject("_hub_migrations")
    const d1 = await createFakeD1(project.rootDir, `${project.init};\nCREATE TABLE _hub_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO _hub_migrations (name) VALUES ('0000_init');`)
    vi.stubGlobal("fetch", d1.fetch)
    try {
      await expect(project.migrate()).resolves.toMatchObject({ exitCode: 0, stderr: "" })
      await expect(d1.rows("SELECT name FROM _hub_migrations ORDER BY id")).resolves.toEqual([["0000_init"], ["0000_init.sql"], ["0001_add_body.sql"]])
      await expect(d1.rows("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).resolves.toEqual([])
    }
    finally {
      d1.client.close()
    }
  }, 120_000)

  it("leaves the ledger as it was when a migration fails", async () => {
    const project = await d1MigrateProject()
    const d1 = await createFakeD1(project.rootDir, "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);")
    vi.stubGlobal("fetch", d1.fetch)

    const failed = await project.migrate(["--allow-data-loss"])

    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("DATABASE_D1_MIGRATION_FAILED")
    expect(failed.stderr).toContain("D1 migration failed for the database \"default\". Cloudflare D1 returned HTTP 400")
    await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([])
    d1.client.close()
  }, 120_000)
})
