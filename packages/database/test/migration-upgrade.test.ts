import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, expect, it } from "vitest"

import { readMigrations, readPendingMigration } from "../src/internal/migration-journal.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { migrateOnStart } from "../src/runtime/migrate-on-start.ts"

import type { StartMigrationDatabase } from "../src/runtime/migrate-on-start.ts"
import type { ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const kit = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project() {
  const root = await mkdtemp(join(import.meta.dirname, ".migration-upgrade-"))
  roots.push(root)
  const url = `file:${join(root, "app.sqlite")}`
  const migrationsDir = join(root, "migrations")
  await writeFile(join(root, "drizzle.config.ts"), `export default ${JSON.stringify({ dbCredentials: { url }, dialect: "sqlite", out: migrationsDir })}`)
  const database = { connection: { url }, dialect: "sqlite", generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" } satisfies ResolvedDrizzleDatabaseConfig
  return { database, root, url }
}

async function folder(dir: string, tag: string, sql: string) {
  await mkdir(join(dir, tag), { recursive: true })
  await writeFile(join(dir, tag, "migration.sql"), sql)
}

function startupMigrations(dir: string) {
  const entries = readMigrations(dir)
  return entries.map(entry => ({ ...readPendingMigration(dir, entry.tag, entries), hash: entry.hash, when: entry.when }))
}

it.each([false, true])("checks the execution order for shared-file migrations of the same second (reverse: %s)", async (reverse) => {
  const { database, root, url } = await project()
  const replacementDir = join(root, "replacement")
  await folder(database.migrationsDir, "20251201000000_init", "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);")
  const first = createClient({ url })
  const second = createClient({ url })
  try {
    await migrateOnStart([{ db: drizzle({ client: first }), dialect: "sqlite", migrations: startupMigrations(database.migrationsDir), name: "original" }], { log: () => {} })
    await first.execute("INSERT INTO notes VALUES (1, 'customer data')")
    await folder(database.migrationsDir, "20260101000000_a_drop", "DROP TABLE notes;")
    await folder(replacementDir, "20260101000000_z_recreate", "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);")
    const databases = [
      { db: drizzle({ client: second }), dialect: "sqlite", migrations: startupMigrations(replacementDir), name: "replacement" },
      { db: drizzle({ client: first }), dialect: "sqlite", migrations: startupMigrations(database.migrationsDir), name: "original" },
    ] satisfies StartMigrationDatabase[]
    if (reverse) databases.reverse()
    await expect(migrateOnStart(databases, { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_DATA_LOSS" })
    expect((await first.execute("SELECT title FROM notes")).rows.map(row => row[0])).toEqual(["customer data"])
    expect((await first.execute("SELECT count(*) FROM __drizzle_migrations")).rows[0]?.[0]).toBe(1)

    await migrateOnStart(databases, { allowDataLoss: true, log: () => {} })
    expect((await first.execute("SELECT * FROM notes")).rows).toEqual([])
  }
  finally {
    first.close()
    second.close()
  }
})

it.each([[false, false], [true, false], [true, true]])("backfills distinct NULL-ID legacy rows and remains compatible with Kit (pending: %s, hash fallback: %s)", async (pending, hashFallback) => {
  const { database, root, url } = await project()
  await folder(database.migrationsDir, "20231114221319_init", "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);")
  await folder(database.migrationsDir, "20231114221320_seed", "INSERT INTO notes VALUES (1, 'customer data');")
  const applied = startupMigrations(database.migrationsDir)
  const first = createClient({ url })
  const second = createClient({ url })
  try {
    await first.migrate([
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
      ...applied.flatMap(migration => [
        ...migration.statements,
        { args: [migration.hash, migration.when + (hashFallback ? 100_000 : 417)], sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)" },
      ]),
    ])
    expect((await first.execute("SELECT id FROM __drizzle_migrations")).rows.map(row => row[0])).toEqual([null, null])
    if (pending) await folder(database.migrationsDir, "20231114221321_body", "ALTER TABLE notes ADD COLUMN body TEXT;")
    const migrations = startupMigrations(database.migrationsDir)
    const databases = [
      { db: drizzle({ client: first }), dialect: "sqlite", migrations: migrations.slice(0, 1), name: "original" },
      { db: drizzle({ client: second }), dialect: "sqlite", migrations: migrations.slice(1), name: "rest" },
    ] satisfies StartMigrationDatabase[]
    await migrateOnStart(databases, { log: () => {} })
    expect((await first.execute("SELECT name FROM __drizzle_migrations ORDER BY name")).rows.map(row => row[0])).toEqual(migrations.map(migration => migration.name))
    // Both startup and the real RC.5 Kit must now find nothing to replay.
    await migrateOnStart(databases, { log: () => {} })
    await execFileAsync(process.execPath, [kit, "migrate", "--config", join(root, "drizzle.config.ts")], { cwd: root })
    expect((await first.execute("SELECT title FROM notes")).rows.map(row => row[0])).toEqual(["customer data"])
    expect((await first.execute("SELECT count(*) FROM __drizzle_migrations")).rows[0]?.[0]).toBe(migrations.length)
    await expect(readMigrationPlan(database, { env: {}, projectRoot: root })).resolves.toMatchObject([undefined, { pending: [] }])
  }
  finally {
    first.close()
    second.close()
  }
})

it("refuses overlapping legacy backfills before Kit can replay destructive SQL", async () => {
  const { database, root, url } = await project()
  await folder(database.migrationsDir, "20231114221319_init", "CREATE TABLE cache (value TEXT);")
  await folder(database.migrationsDir, "20231114221320_clear_cache", "DELETE FROM cache;")
  await folder(database.migrationsDir, "20231114221321_clear_cache_again", "DELETE FROM cache;")
  const applied = startupMigrations(database.migrationsDir)
  const client = createClient({ url })
  try {
    await client.migrate([
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
      ...applied.flatMap(migration => [
        ...migration.statements,
        { args: [migration.hash, migration.when], sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)" },
      ]),
      "INSERT INTO cache VALUES ('customer data')",
    ])
    await folder(database.migrationsDir, "20231114221321_index_cache", "CREATE INDEX cache_value_idx ON cache(value);")
    const [error, plan] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(error).toMatchObject({ code: "DATABASE_MIGRATION_CHECK_FAILED", why: expect.stringContaining("overlapping") })
    expect(plan).toBeUndefined()
    await expect(migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite", migrations: startupMigrations(database.migrationsDir), name: "default" }])).rejects.toThrow("overlapping")
    expect((await client.execute("SELECT value FROM cache")).rows.map(row => row[0])).toEqual(["customer data"])
    expect((await client.execute("PRAGMA table_info(__drizzle_migrations)")).rows.map(row => row.name)).not.toContain("name")

    // Prove the refusal against real Kit on a copy: its hash update renames both clear rows,
    // then the missing clear_cache name makes Kit run DELETE again.
    const copy = join(root, "kit.sqlite")
    await cp(join(root, "app.sqlite"), copy)
    const config = join(root, "kit.config.ts")
    await writeFile(config, `export default ${JSON.stringify({ dbCredentials: { url: `file:${copy}` }, dialect: "sqlite", out: database.migrationsDir })}`)
    await execFileAsync(process.execPath, [kit, "migrate", "--config", config], { cwd: root })
    const migrated = createClient({ url: `file:${copy}` })
    try {
      expect((await migrated.execute("SELECT * FROM cache")).rows).toEqual([])
      expect((await migrated.execute("SELECT name FROM __drizzle_migrations ORDER BY name")).rows.map(row => row[0])).toEqual([
        "20231114221319_init", "20231114221320_clear_cache", "20231114221321_clear_cache_again", "20231114221321_clear_cache_again", "20231114221321_index_cache",
      ])
    }
    finally {
      migrated.close()
    }
  }
  finally {
    client.close()
  }
})

it("predicts Kit's last-folder hash fallback and checks the SQL it will replay", async () => {
  const { database, root, url } = await project()
  await folder(database.migrationsDir, "20231114221319_init", "CREATE TABLE cache (value TEXT);")
  await folder(database.migrationsDir, "20231114221320_clear_cache", "DELETE FROM cache;")
  await folder(database.migrationsDir, "20231114221321_clear_cache_again", "DELETE FROM cache;")
  const migrations = startupMigrations(database.migrationsDir)
  const client = createClient({ url })
  try {
    await client.migrate([
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
      ...migrations[0]!.statements,
      { args: [migrations[0]!.hash, migrations[0]!.when], sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)" },
      // This timestamp has no local folder. Two folders have its SQL hash, and Kit chooses the later one.
      { args: [migrations[1]!.hash, 1_600_000_000_000], sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)" },
      "INSERT INTO cache VALUES ('customer data')",
    ])
    const [error, plan] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending.map(migration => migration.name)).toEqual(["20231114221320_clear_cache"])
    expect(plan?.pending[0]?.dataLoss).toHaveLength(1)
    await execFileAsync(process.execPath, [kit, "migrate", "--config", join(root, "drizzle.config.ts")], { cwd: root })
    expect((await client.execute("SELECT * FROM cache")).rows).toEqual([])
    expect((await client.execute("SELECT name FROM __drizzle_migrations ORDER BY name")).rows.map(row => row[0])).toEqual(migrations.map(migration => migration.name))
  }
  finally {
    client.close()
  }
})
