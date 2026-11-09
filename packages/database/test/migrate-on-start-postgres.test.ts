// Runs only with a Postgres server, for example:
// docker run -d --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
// VITEHUB_TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:54329/postgres vitest run test/migrate-on-start-postgres.test.ts
// Each test creates its own database on that server and drops it after.
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { build } from "esbuild"
import postgres from "postgres"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { hubDb } from "../src/nuxt.ts"
import { migratePostgres, postgresMigrationLock } from "../src/runtime/migrate-on-start.ts"

import type { DatabaseNuxtIntegrationOptions, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const adminUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const init = {
  sql: "CREATE TABLE \"users\" (\n\t\"id\" integer PRIMARY KEY NOT NULL,\n\t\"name\" text NOT NULL\n);\n--> statement-breakpoint\nCREATE TABLE \"legacy\" (\"id\" integer);\n",
  tag: "0000_init",
  when: 1_700_000_000_000,
}
// A slow statement keeps the first server in its transaction while the others start, so they must wait for the lock.
const seed = { sql: "SELECT pg_sleep(0.5);\n--> statement-breakpoint\nINSERT INTO \"users\" (\"id\", \"name\") VALUES (7, 'Ada');", tag: "0001_seed", when: 1_700_000_001_000 }
const addEmail = { sql: "ALTER TABLE \"users\" ADD COLUMN \"email\" text;", tag: "0002_add_email", when: 1_700_000_002_000 }
const broken = { sql: "INSERT INTO \"missing_table\" VALUES (1);", tag: "0003_broken", when: 1_700_000_003_000 }

/** Creates an empty database on the test server and returns its URL. */
async function createDatabase() {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
  const name = `vitehub_mos_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  await admin.unsafe(`create database ${name}`)
  cleanups.push(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`)
    await admin.end()
  })
  const url = new URL(adminUrl!)
  url.pathname = `/${name}`
  return url.href
}

function connect(url: string) {
  const sql = postgres(url, { max: 2, onnotice: () => {} })
  cleanups.push(() => sql.end())
  return sql
}

async function createProject(migrations: Array<{ sql: string, tag: string, when: number }>) {
  const root = await mkdtemp(join(packageRoot, ".vitest-migrate-on-start-pg-"))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
  await mkdir(join(root, "server/databases"), { recursive: true })
  await writeFile(join(root, "server/databases/config.ts"), [
    'import { defineDatabase } from "@vite-hub/database"',
    'import { integer, pgTable, text } from "drizzle-orm/pg-core"',
    "export default defineDatabase({",
    '  connection: { url: process.env.MIGRATE_TEST_DATABASE_URL },',
    '  dialect: "postgresql",',
    '  schema: { users: pgTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() }) },',
    "})",
  ].join("\n"))
  const migrationsDir = await writeMigrations(root, migrations)
  return { migrationsDir, root }
}

async function writeMigrations(root: string, migrations: Array<{ sql: string, tag: string, when: number }>) {
  const dir = join(root, "server/databases/migrations")
  await rm(dir, { force: true, recursive: true })
  await mkdir(join(dir, "meta"), { recursive: true })
  await writeFile(join(dir, "meta/_journal.json"), JSON.stringify({
    dialect: "postgresql",
    entries: migrations.map((migration, idx) => ({ breakpoints: true, idx, tag: migration.tag, version: "7", when: migration.when })),
    version: "7",
  }))
  for (const migration of migrations) await writeFile(join(dir, `${migration.tag}.sql`), migration.sql)
  return dir
}

/** Runs the Nuxt module for a production Node build and bundles a server whose entry imports Nitro's plugins first. */
async function buildNodeServer(root: string, options: DatabaseNuxtIntegrationOptions) {
  const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
  await hubDb(options)(undefined, {
    hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
      if (event === "nitro:config") hooks.push(callback)
    },
    options: { buildDir: join(root, ".nuxt"), dev: false, nitro: { preset: "node-server" }, rootDir: root },
  })
  const config: Record<string, unknown> & { alias: Record<string, string>, plugins?: string[] } = { alias: {} }
  for (const hook of hooks) await hook(config)
  // Nitro runs modules after it resolves the preset.
  const nitroOptions: { plugins?: string[], preset: string } = { plugins: config.plugins, preset: "node-server" }
  for (const module of Array.isArray(config.modules) ? config.modules : []) {
    if (typeof module === "function") await module({ hooks: { hook: () => {} }, options: nitroOptions })
  }
  config.plugins = nitroOptions.plugins
  const entry = join(root, "server.mjs")
  await writeFile(entry, [
    ...(config.plugins ?? []).map(plugin => `import ${JSON.stringify(plugin)}`),
    'import { useDatabase } from "@vite-hub/database/drizzle"',
    'const { db, schema } = useDatabase("default")',
    "console.log(JSON.stringify(await db.select().from(schema.users)))",
    "await db.$client.end()",
  ].join("\n"))
  const output = join(root, "server.output.mjs")
  await build({
    alias: { ...config.alias, "@vite-hub/database": join(packageRoot, "src/index.ts") },
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: output,
    packages: "external",
    platform: "node",
    plugins: [{
      name: "node-file-imports",
      setup(plugin) {
        plugin.onResolve({ filter: /^file:\/\// }, args => plugin.resolve(fileURLToPath(args.path), { kind: args.kind, resolveDir: args.resolveDir }))
      },
    }],
  })
  return {
    config,
    start: (url: string) => execFileAsync(process.execPath, [output], { cwd: root, env: { ...process.env, MIGRATE_TEST_DATABASE_URL: url } }),
    /** Starts the server and resolves when its output contains `text`. */
    startUntil: (url: string, text: string) => {
      const child = spawn(process.execPath, [output], { cwd: root, env: { ...process.env, MIGRATE_TEST_DATABASE_URL: url } })
      let stdout = ""
      let stderr = ""
      child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString())
      const exited = new Promise<{ code: number | null, stderr: string, stdout: string }>(resolve => child.on("close", code => resolve({ code, stderr, stdout })))
      const seen = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString()
          if (stdout.includes(text)) resolve()
        })
        // A server that exits before it prints `text` fails the test with its output.
        child.on("close", code => reject(new Error(`The server exited with code ${code} before it printed "${text}".\n${stdout}${stderr}`)))
      })
      return { exited, seen }
    },
  }
}

/** Takes the migration lock in a transaction of its own. Resolves when the lock is held; cleanup releases it. */
async function holdLock(sql: postgres.Sql) {
  let release!: () => void
  const released = new Promise<void>(resolve => release = resolve)
  let locked!: () => void
  const held = new Promise<void>(resolve => locked = resolve)
  const done = sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${postgresMigrationLock}))`
    locked()
    await released
  })
  cleanups.push(async () => {
    release()
    await done
  })
  await held
  return { release: async () => {
    release()
    await done
  } }
}

async function readLedger(sql: postgres.Sql) {
  return await sql<Array<{ created_at: string, hash: string, id: number }>>`select id, hash, created_at from drizzle.__drizzle_migrations order by id`
}

function postgresDatabase(url: string, migrationsDir: string): ResolvedDrizzleDatabaseConfig {
  return { connection: { url }, dialect: "postgresql", drizzle: {}, generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" }
}

describe.skipIf(!adminUrl)("database.migrateOnStart on Postgres", () => {
  it("applies each migration once when four servers start together, in Drizzle's ledger", { timeout: 120_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    // Postgres on Node migrates on start without the option.
    const server = await buildNodeServer(root, {})
    expect(server.config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])

    const runs = await Promise.all(Array.from({ length: 4 }, () => server.start(url)))
    const lines = runs.flatMap(run => run.stdout.trim().split("\n"))
    expect(lines.filter(line => line.includes("applied 0000_init"))).toEqual(['[vitehub] Database "default": applied 0000_init.'])
    expect(lines.filter(line => line.includes("applied 0001_seed"))).toEqual(['[vitehub] Database "default": applied 0001_seed.'])
    // The seed sleeps in the transaction, so the other servers find the lock taken and wait for it.
    expect(lines.filter(line => line.includes("Waiting for it to finish")).length).toBeGreaterThan(0)
    for (const run of runs) expect(run.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))

    const sql = connect(url)
    const ledger = await readLedger(sql)
    expect(ledger.map(row => Number(row.created_at))).toEqual([init.when, seed.when])

    // drizzle-orm's own migrator writes the same ledger rows on a second empty database.
    const reference = connect(await createDatabase())
    await migrate(drizzle({ client: reference }), { migrationsFolder: migrationsDir })
    expect(await readLedger(reference)).toEqual(ledger)
    // And it finds nothing to apply on the database that the servers migrated.
    await migrate(drizzle({ client: sql }), { migrationsFolder: migrationsDir })
    expect(await readLedger(sql)).toEqual(ledger)

    // A second boot applies nothing, and the seed row is not inserted twice.
    expect((await server.start(url)).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    const [error, plan] = await readMigrationPlan(postgresDatabase(url, migrationsDir), { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending).toEqual([])
  })

  it("applies only the migrations after drizzle-kit's last one", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    const sql = connect(url)
    await migrate(drizzle({ client: sql }), { migrationsFolder: migrationsDir })

    await writeMigrations(root, [init, seed, addEmail])
    const server = await buildNodeServer(root, {})
    const started = await server.start(url)
    expect(started.stdout.trim().split("\n")).toEqual([
      '[vitehub] Database "default": applied 0002_add_email.',
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when, seed.when, addEmail.when])
  })

  it("rolls back every pending migration when one fails, and the server does not start", { timeout: 60_000 }, async () => {
    const { root } = await createProject([init])
    const url = await createDatabase()
    const sql = connect(url)
    await (await buildNodeServer(root, {})).start(url)

    await writeMigrations(root, [init, seed, addEmail, broken])
    const failed = (await buildNodeServer(root, {})).start(url)
    await expect(failed).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/DATABASE_MIGRATION_FAILED[\s\S]*0003_broken[\s\S]*missing_table/),
    })
    // The seed and the new column ran before the broken migration in the same transaction, so none of them stays.
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when])
    expect(await sql`select count(*)::int as count from users`).toEqual([{ count: 0 }])
    expect(await sql`select column_name from information_schema.columns where table_name = 'users' and column_name = 'email'`).toEqual([])
  })

  it("refuses a migration that loses data unless allowDataLoss is set", { timeout: 60_000 }, async () => {
    const { root } = await createProject([init])
    const url = await createDatabase()
    const sql = connect(url)
    await (await buildNodeServer(root, {})).start(url)

    const dropLegacy = { sql: "DROP TABLE \"legacy\";", tag: "0001_drop_legacy", when: seed.when }
    await writeMigrations(root, [init, dropLegacy])
    await expect((await buildNodeServer(root, {})).start(url)).rejects.toMatchObject({ stderr: expect.stringContaining("DATABASE_MIGRATION_DATA_LOSS") })
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when])

    const allowed = await (await buildNodeServer(root, { migrateOnStart: { allowDataLoss: true } })).start(url)
    expect(allowed.stdout).toContain('[vitehub] Database "default": applied 0001_drop_legacy.')
  })

  it("does not migrate with migrateOnStart: false", async () => {
    const { root } = await createProject([init])
    const server = await buildNodeServer(root, { migrateOnStart: false })
    expect(server.config.plugins).toBeUndefined()
  })

  it("waits for the lock that `vitehub db migrate` and a starting server share", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    const sql = connect(url)
    const server = await buildNodeServer(root, {})

    // Hold the lock like a running `vitehub db migrate` would.
    const holder = await holdLock(sql)
    const booting = server.startUntil(url, "Waiting for it to finish")
    await booting.seen
    expect(await sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`).toEqual([{ name: null }])
    await holder.release()
    const { code, stdout } = await booting.exited
    expect(code).toBe(0)
    expect(stdout).toContain('[vitehub] Database "default": applied 0001_seed.')

    // `vitehub db migrate` takes the same lock: it waits for a server that migrates, then finds nothing pending.
    await writeMigrations(root, [init, seed, addEmail])
    const contributor = createDbCliContributor(undefined, () => ({
      databaseNames: ["default"],
      databases: { default: postgresDatabase(url, migrationsDir) },
      generatedDrizzleConfigFile: join(root, "drizzle.config.ts"),
      rootDir: root,
    }) as unknown as ResolvedDBViteConfig)!
    const command = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!
    const stdoutWrite = vi.fn()
    const stderrWrite = vi.fn()
    const otherHolder = await holdLock(sql)
    const running = command.run([], { env: process.env, rootDir: root, spawn: () => Promise.reject(new Error("drizzle-kit must not run")), stderr: { write: stderrWrite }, stdout: { write: stdoutWrite } } as never)
    await vi.waitFor(() => expect(stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Waiting for it to finish"), { interval: 50, timeout: 20_000 })
    // The CLI applies nothing while another process holds the lock.
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when, seed.when])
    await otherHolder.release()
    const exitCode = await running
    const out = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("")
    expect(stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe("")
    expect(exitCode).toBe(0)
    expect(out).toContain("another process is applying migrations")
    expect(out).toContain('[vitehub] Database "default": applied 0002_add_email.')
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when, seed.when, addEmail.when])
  })

  it("boots after `vitehub db migrate --allow-data-loss` commits a destructive migration under the lock", { timeout: 60_000 }, async () => {
    const { root } = await createProject([init])
    const url = await createDatabase()
    const sql = connect(url)
    await (await buildNodeServer(root, {})).start(url)

    const dropLegacy = { sql: "DROP TABLE \"legacy\";", tag: "0001_drop_legacy", when: seed.when }
    const migrationsDir = await writeMigrations(root, [init, dropLegacy])
    const server = await buildNodeServer(root, {})
    // The CLI holds the lock while it applies the drop. The server must read the ledger after that commit.
    const contributor = createDbCliContributor(undefined, () => ({
      databaseNames: ["default"],
      databases: { default: postgresDatabase(url, migrationsDir) },
      generatedDrizzleConfigFile: join(root, "drizzle.config.ts"),
      rootDir: root,
    }) as unknown as ResolvedDBViteConfig)!
    const command = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!
    // A holder stands in for a long migration: it takes the lock first, so the CLI and the server queue behind it.
    const holder = await holdLock(sql)
    const cliOut = vi.fn()
    const cli = command.run(["--allow-data-loss"], { env: process.env, rootDir: root, spawn: () => Promise.reject(new Error("drizzle-kit must not run")), stderr: { write: cliOut }, stdout: { write: cliOut } } as never)
    // Postgres queues lock requests in order. Start the server only when the CLI waits, so the CLI applies first.
    await vi.waitFor(() => expect(cliOut.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Waiting for it to finish"), { interval: 50, timeout: 20_000 })
    const booting = server.startUntil(url, "Waiting for it to finish")
    await booting.seen
    await holder.release()
    expect(await cli).toBe(0)
    const { code, stderr, stdout } = await booting.exited
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).not.toContain("applied 0001_drop_legacy")
    expect(cliOut.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("applied 0001_drop_legacy")
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when, dropLegacy.when])
  })

  it("migrates two Definitions on one database together, and refuses a history that Drizzle would skip", { timeout: 60_000 }, async () => {
    const url = await createDatabase()
    // Two URL spellings of one database, on separate connections.
    const other = new URL(url)
    other.hostname = other.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1"
    const first = connect(url)
    const second = connect(other.href)
    const entry = (name: string, when: number, statement: string) => ({ dataLoss: [], hash: `hash-${name}`, name, statements: [statement], when })
    const a0 = entry("a0", 1_000, "CREATE TABLE a0 (id int)")
    const a1 = entry("a1", 3_000, "CREATE TABLE a1 (id int)")
    const b0 = entry("b0", 2_000, "CREATE TABLE b0 (id int)")
    const log: string[] = []

    await migratePostgres([
      { client: first, database: { migrations: [a0, a1], name: "first" } },
      { client: second, database: { migrations: [b0], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual([
      '[vitehub] Database "first": applied a0.',
      '[vitehub] Database "second": applied b0.',
      '[vitehub] Database "first": applied a1.',
    ])
    expect((await readLedger(first)).map(row => Number(row.created_at))).toEqual([a0.when, b0.when, a1.when])

    // A new migration of "second" that is older than the newest row: Drizzle would skip it on every start.
    const b1 = entry("b1", 2_500, "CREATE TABLE b1 (id int)")
    await expect(migratePostgres([
      { client: first, database: { migrations: [a0, a1], name: "first" } },
      { client: second, database: { migrations: [b0, b1], name: "second" } },
    ], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED", why: expect.stringContaining("\"b1\"") })
    expect(await first`select to_regclass('public.b1')::text as name`).toEqual([{ name: null }])
  })
})
