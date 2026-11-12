// Runs only with a Postgres server, for example:
// docker run -d --rm -e POSTGRES_PASSWORD=test -p 54329:5432 -v /tmp/pg-socket:/var/run/postgresql postgres:17-alpine
// VITEHUB_TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:54329/postgres VITEHUB_TEST_POSTGRES_SOCKET_DIR=/tmp/pg-socket \
//   vitest run test/migrate-on-start-postgres.test.ts
// Each test creates its own database on that server and drops it after.
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
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
import { ensureDatabaseMigrations, migratePostgres, postgresMigrationLock } from "../src/runtime/migrate-on-start.ts"

import type { DatabaseNuxtIntegrationOptions, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const adminUrl = process.env.VITEHUB_TEST_POSTGRES_URL
// A host folder with the server's Unix socket, for example `-v /tmp/pg-socket:/var/run/postgresql` on the container.
const socketDir = process.env.VITEHUB_TEST_POSTGRES_SOCKET_DIR
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const init = {
  sql: "CREATE TABLE \"users\" (\n\t\"id\" integer PRIMARY KEY NOT NULL,\n\t\"name\" text NOT NULL\n);\n--> statement-breakpoint\nCREATE TABLE \"legacy\" (\"id\" integer);\n",
  tag: "20231114221320_init",
  when: 1_700_000_000_000,
}
// A slow statement keeps the first server in its transaction while the others start, so they must wait for the lock.
const seed = { sql: "SELECT pg_sleep(0.5);\n--> statement-breakpoint\nINSERT INTO \"users\" (\"id\", \"name\") VALUES (7, 'Ada');", tag: "20231114221321_seed", when: 1_700_000_001_000 }
const addEmail = { sql: "ALTER TABLE \"users\" ADD COLUMN \"email\" text;", tag: "20231114221322_add_email", when: 1_700_000_002_000 }
const broken = { sql: "INSERT INTO \"missing_table\" VALUES (1);", tag: "20231114221323_broken", when: 1_700_000_003_000 }

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
  await writeFile(join(root, "server/databases/default.ts"), [
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
  // Drizzle Kit 1.0 writes `<YYYYMMDDHHmmss>_<name>/migration.sql`. The folder time is the `when` of each fixture.
  const dir = join(root, "server/databases/default/migrations")
  await rm(dir, { force: true, recursive: true })
  for (const migration of migrations) {
    await mkdir(join(dir, migration.tag), { recursive: true })
    await writeFile(join(dir, migration.tag, "migration.sql"), migration.sql)
  }
  return dir
}

/** Runs the Nuxt module for a production Node build and bundles a server whose entry imports Nitro's plugins first, then runs `before`. */
async function buildNodeServer(root: string, options: DatabaseNuxtIntegrationOptions, before: string[] = []) {
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
    ...before,
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

/** Drizzle 1.0's ledger rows. `applied_at` is a time, so only whether it is set is compared. */
async function readLedger(sql: postgres.Sql) {
  return await sql<Array<{ applied: boolean, created_at: string, hash: string, id: number, name: string | null }>>`select id, hash, created_at, name, applied_at is not null as applied from drizzle.__drizzle_migrations order by id`
}

/** The columns of the ledger table, to compare the table that ViteHub creates or upgrades with Drizzle's. */
async function readLedgerColumns(sql: postgres.Sql) {
  return await sql`select column_name, data_type, column_default, is_nullable from information_schema.columns where table_schema = 'drizzle' and table_name = '__drizzle_migrations' order by ordinal_position`
}

/** Writes the ledger that Drizzle Kit 0.x left after it applied `init`: no `name` column, the journal time in milliseconds. */
async function writeDrizzleKit0xLedger(sql: postgres.Sql) {
  await sql.unsafe(init.sql.replaceAll("--> statement-breakpoint", ""))
  await sql.unsafe("CREATE SCHEMA \"drizzle\"")
  await sql.unsafe("CREATE TABLE \"drizzle\".\"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)")
  await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${createHash("sha256").update(init.sql).digest("hex")}, ${init.when + 417})`
}

function postgresDatabase(url: string, migrationsDir: string): ResolvedDrizzleDatabaseConfig {
  return { connection: { url }, dialect: "postgresql", generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" }
}

describe.skipIf(!adminUrl)("ensureMigrations on Postgres", () => {
  it("applies each migration once when four processes call it together, without the start plugin", { timeout: 120_000 }, async () => {
    const { root } = await createProject([init, seed])
    const url = await createDatabase()
    const server = await buildNodeServer(root, { migrateOnStart: false }, [
      'import { ensureMigrations } from "@vite-hub/database/drizzle"',
      'await Promise.all([ensureMigrations(), ensureMigrations("default")])',
      "await ensureMigrations()",
    ])
    expect(server.config.plugins).toBeUndefined()

    const runs = await Promise.all(Array.from({ length: 4 }, () => server.start(url)))
    const lines = runs.flatMap(run => run.stdout.trim().split("\n"))
    expect(lines.filter(line => line.includes("applied 20231114221320_init"))).toEqual(['[vitehub] Database "default": applied 20231114221320_init.'])
    expect(lines.filter(line => line.includes("applied 20231114221321_seed"))).toEqual(['[vitehub] Database "default": applied 20231114221321_seed.'])
    // The seed sleeps under the lock, so the other processes wait for it.
    expect(lines.filter(line => line.includes("Waiting for it to finish")).length).toBeGreaterThan(0)
    for (const run of runs) expect(run.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect((await readLedger(connect(url))).map(row => row.name)).toEqual([init.tag, seed.tag])
  })

  it("applies once for two calls, and forgets a failed run so the next call applies", { timeout: 60_000 }, async () => {
    const url = await createDatabase()
    const sql = connect(url)
    const gated = { dataLoss: [], hash: "gated", name: "20231114221320_gated", statements: ["INSERT INTO \"gate\" (\"id\") VALUES (1)"], when: init.when }
    let loads = 0
    const context = {
      databases: { pgRetry: { db: { $client: sql } } },
      load: async () => {
        loads++
        return { allowDataLoss: false, databases: { pgRetry: { dialect: "postgresql" as const, migrations: [gated] } } }
      },
    }
    await expect(ensureDatabaseMigrations(context, ["pgRetry"])).rejects.toMatchObject({ code: "DATABASE_MIGRATION_FAILED", why: expect.stringContaining("gate") })

    await sql`create table gate (id integer)`
    await Promise.all([ensureDatabaseMigrations(context, ["pgRetry"]), ensureDatabaseMigrations(context)])
    await ensureDatabaseMigrations(context, ["pgRetry"])
    // The failed run and one new run: the later calls share the second.
    expect(loads).toBe(2)
    expect(await sql`select count(*)::int as count from gate`).toEqual([{ count: 1 }])
    expect((await readLedger(sql)).map(row => row.name)).toEqual([gated.name])
  })
})

describe.skipIf(!adminUrl)("database.migrateOnStart on Postgres", () => {
  it("times out blocked DDL, rolls back pending migrations and releases the read queue", { timeout: 30_000 }, async () => {
    const url = await createDatabase()
    const sql = connect(url)
    const entry = (name: string, statements: string[]) => ({ dataLoss: [], hash: name, name, statements, when: 1_000 })
    const initial = entry("init", ["CREATE TABLE users (id integer PRIMARY KEY, name text)", "INSERT INTO users VALUES (1, 'Ada')"])
    await migratePostgres([{ client: sql, database: { migrations: [initial], name: "default" } }], { log: () => {} })
    const pending = entry("add_email", ["CREATE TABLE pending (id integer)", "ALTER TABLE users ADD COLUMN email text"])
    // Keep an old instance's transaction open while a new instance starts its migration.
    const oldInstance = await sql.reserve()
    await oldInstance`begin`
    await oldInstance`select * from users`
    const migrating = postgres(url, { connection: { statement_timeout: 15_000 }, max: 1, onnotice: () => {} })
    cleanups.push(() => migrating.end())
    try {
      await expect(migratePostgres([{ client: migrating, database: { migrations: [initial, pending], name: "default" } }], { log: () => {} }))
        .rejects.toMatchObject({ cause: { code: "55P03" }, code: "DATABASE_MIGRATION_FAILED", why: expect.stringContaining("lock timeout") })
      // This read can finish while the old transaction remains open: the queued ALTER is gone.
      expect(await sql`select name from users where id = 1`).toEqual([{ name: "Ada" }])
      expect(await sql`select to_regclass('pending')::text as name`).toEqual([{ name: null }])
      expect((await readLedger(sql)).map(row => row.name)).toEqual(["init"])
    }
    finally {
      await oldInstance`rollback`
      oldInstance.release()
    }
    await expect(migratePostgres([{ client: migrating, database: { migrations: [initial, pending], name: "default" } }], { log: () => {} })).resolves.toEqual(["add_email"])
    expect(await sql`select email from users`).toEqual([{ email: null }])
  })

  it("applies each migration once when four servers start together, in Drizzle's ledger", { timeout: 120_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    // Postgres on Node migrates on start without the option.
    const server = await buildNodeServer(root, {})
    expect(server.config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])

    const runs = await Promise.all(Array.from({ length: 4 }, () => server.start(url)))
    const lines = runs.flatMap(run => run.stdout.trim().split("\n"))
    expect(lines.filter(line => line.includes("applied 20231114221320_init"))).toEqual(['[vitehub] Database "default": applied 20231114221320_init.'])
    expect(lines.filter(line => line.includes("applied 20231114221321_seed"))).toEqual(['[vitehub] Database "default": applied 20231114221321_seed.'])
    // The seed sleeps in the transaction, so the other servers find the lock taken and wait for it.
    expect(lines.filter(line => line.includes("Waiting for it to finish")).length).toBeGreaterThan(0)
    for (const run of runs) expect(run.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))

    const sql = connect(url)
    const ledger = await readLedger(sql)
    expect(ledger.map(row => [Number(row.created_at), row.name, row.applied])).toEqual([[init.when, init.tag, true], [seed.when, seed.tag, true]])

    // drizzle-orm 1.0's own migrator writes the same table and rows on a second empty database.
    const reference = connect(await createDatabase())
    await migrate(drizzle({ client: reference }), { migrationsFolder: migrationsDir })
    expect(await readLedger(reference)).toEqual(ledger)
    expect(await readLedgerColumns(reference)).toEqual(await readLedgerColumns(sql))
    // And it finds nothing to apply on the database that the servers migrated.
    await migrate(drizzle({ client: sql }), { migrationsFolder: migrationsDir })
    expect(await readLedger(sql)).toEqual(ledger)

    // A second boot applies nothing, and the seed row is not inserted twice.
    expect((await server.start(url)).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    const [error, plan] = await readMigrationPlan(postgresDatabase(url, migrationsDir), { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending).toEqual([])
  })

  it("applies only the migrations that drizzle-orm 1.0 did not apply", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    const sql = connect(url)
    await migrate(drizzle({ client: sql }), { migrationsFolder: migrationsDir })

    await writeMigrations(root, [init, seed, addEmail])
    const server = await buildNodeServer(root, {})
    const started = await server.start(url)
    expect(started.stdout.trim().split("\n")).toEqual([
      '[vitehub] Database "default": applied 20231114221322_add_email.',
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
      stderr: expect.stringMatching(/DATABASE_MIGRATION_FAILED[\s\S]*20231114221323_broken[\s\S]*missing_table/),
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

    const dropLegacy = { sql: "DROP TABLE \"legacy\";", tag: "20231114221321_drop_legacy", when: seed.when }
    await writeMigrations(root, [init, dropLegacy])
    await expect((await buildNodeServer(root, {})).start(url)).rejects.toMatchObject({ stderr: expect.stringContaining("DATABASE_MIGRATION_DATA_LOSS") })
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when])

    const allowed = await (await buildNodeServer(root, { migrateOnStart: { allowDataLoss: true } })).start(url)
    expect(allowed.stdout).toContain('[vitehub] Database "default": applied 20231114221321_drop_legacy.')
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
    // The DDL timeout must not limit the advisory wait for another migrator.
    await sql`select pg_sleep(5.5)`
    expect(await sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`).toEqual([{ name: null }])
    await holder.release()
    const { code, stdout } = await booting.exited
    expect(code).toBe(0)
    expect(stdout).toContain('[vitehub] Database "default": applied 20231114221321_seed.')

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
    expect(out).toContain('[vitehub] Database "default": applied 20231114221322_add_email.')
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when, seed.when, addEmail.when])
  })

  it("boots after `vitehub db migrate --allow-data-loss` commits a destructive migration under the lock", { timeout: 60_000 }, async () => {
    const { root } = await createProject([init])
    const url = await createDatabase()
    const sql = connect(url)
    await (await buildNodeServer(root, {})).start(url)

    const dropLegacy = { sql: "DROP TABLE \"legacy\";", tag: "20231114221321_drop_legacy", when: seed.when }
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
    expect(stdout).not.toContain("applied 20231114221321_drop_legacy")
    expect(cliOut.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("applied 20231114221321_drop_legacy")
    expect((await readLedger(sql)).map(row => Number(row.created_at))).toEqual([init.when, dropLegacy.when])
  })

  it("migrates two Definitions on one database together, including an older migration of the second", { timeout: 60_000 }, async () => {
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

    // A new migration of "second" that is older than the newest row. The ledger keys migrations by name, so it applies.
    const b1 = entry("b1", 2_500, "CREATE TABLE b1 (id int)")
    log.length = 0
    await migratePostgres([
      { client: first, database: { migrations: [a0, a1], name: "first" } },
      { client: second, database: { migrations: [b0, b1], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual(['[vitehub] Database "second": applied b1.'])
    expect((await readLedger(first)).map(row => row.name)).toEqual(["a0", "b0", "a1", "b1"])
  })

  it("upgrades a Drizzle Kit 0.x ledger like drizzle-orm 1.0 does", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    const sql = connect(url)
    const reference = connect(await createDatabase())
    await writeDrizzleKit0xLedger(sql)
    await writeDrizzleKit0xLedger(reference)

    const started = await (await buildNodeServer(root, {})).start(url)
    expect(started.stdout.trim().split("\n")).toEqual([`[vitehub] Database "default": applied ${seed.tag}.`, JSON.stringify([{ id: 7, name: "Ada" }])])
    await migrate(drizzle({ client: reference }), { migrationsFolder: migrationsDir })

    const ledger = await readLedger(sql)
    // The upgrade names the 0.x row and clears its `applied_at`; the new row gets the default time.
    expect(ledger.map(row => [row.name, row.applied])).toEqual([[init.tag, false], [seed.tag, true]])
    expect(await readLedger(reference)).toEqual(ledger)
    expect(await readLedgerColumns(reference)).toEqual(await readLedgerColumns(sql))
  })

  it.skipIf(!socketDir)("groups a Unix socket and a TCP connection to one database, and does not wait for its own lock", { timeout: 30_000 }, async () => {
    const url = await createDatabase()
    const tcp = connect(url)
    const socket = postgres({ database: new URL(url).pathname.slice(1), onnotice: () => {}, path: join(socketDir!, ".s.PGSQL.5432"), username: "postgres" })
    cleanups.push(() => socket.end())
    // Over the socket, the server reports no address and no port.
    expect(await socket`select inet_server_addr() as address, inet_server_port() as port`).toEqual([{ address: null, port: null }])
    expect(await tcp`select inet_server_addr() is not null as tcp`).toEqual([{ tcp: true }])
    const entry = (name: string, when: number, statement: string) => ({ dataLoss: [], hash: `hash-${name}`, name, statements: [statement], when })
    const log: string[] = []
    await migratePostgres([
      { client: tcp, database: { migrations: [entry("a0", 1_000, "CREATE TABLE a0 (id int)")], name: "first" } },
      { client: socket, database: { migrations: [entry("b0", 2_000, "CREATE TABLE b0 (id int)")], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual(['[vitehub] Database "first": applied a0.', '[vitehub] Database "second": applied b0.'])
  })

  it("starts as a runtime role with no DDL privileges when the owner has applied every migration", { timeout: 60_000 }, async () => {
    const admin = connect(adminUrl!)
    const role = `vitehub_runtime_${randomUUID().replaceAll("-", "").slice(0, 8)}`
    await admin.unsafe(`create role ${role} login password 'runtime'`)
    cleanups.push(() => admin.unsafe(`drop role if exists ${role}`))
    const url = await createDatabase()
    const owner = connect(url)
    const { root } = await createProject([init, seed])
    const server = await buildNodeServer(root, {})
    await server.start(url)
    const ledger = await readLedger(owner)
    await owner.unsafe(`grant usage on schema public, drizzle to ${role}`)
    await owner.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`)
    await owner.unsafe(`grant select on drizzle.__drizzle_migrations to ${role}`)
    const runtimeUrl = new URL(url)
    runtimeUrl.username = role
    runtimeUrl.password = "runtime"
    const runtime = connect(runtimeUrl.href)
    expect(await runtime`select has_database_privilege(current_user, current_database(), 'CREATE') as ddl`).toEqual([{ ddl: false }])
    expect((await server.start(runtimeUrl.href)).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect(await readLedger(owner)).toEqual(ledger)
  })

  it("refuses Definitions with different roles on one database before creating any tables", { timeout: 30_000 }, async () => {
    const admin = connect(adminUrl!)
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8)
    const alpha = `vitehub_alpha_${suffix}`
    const beta = `vitehub_beta_${suffix}`
    await admin.unsafe(`create role ${alpha} login password 'test'`)
    cleanups.push(() => admin.unsafe(`drop role if exists ${alpha}`))
    await admin.unsafe(`create role ${beta} login password 'test'`)
    cleanups.push(() => admin.unsafe(`drop role if exists ${beta}`))
    const url = await createDatabase()
    const owner = connect(url)
    await owner.unsafe(`grant create on database ${new URL(url).pathname.slice(1)} to ${alpha}`)
    await owner.unsafe(`create schema ${alpha} authorization ${alpha}`)
    await owner.unsafe(`create schema ${beta} authorization ${beta}`)
    const clients = [alpha, beta].map((role) => {
      const roleUrl = new URL(url)
      roleUrl.username = role
      roleUrl.password = "test"
      return connect(roleUrl.href)
    })
    const migration = { dataLoss: [], hash: "hash-b0", name: "b0", statements: ["CREATE TABLE b_items (id int)"], when: 1_000 }
    await expect(migratePostgres([
      { client: clients[0]!, database: { migrations: [], name: "alpha" } },
      { client: clients[1]!, database: { migrations: [migration], name: "beta" } },
    ], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED" })
    expect(await owner`select to_regclass('public.b_items') as items, to_regclass('drizzle.__drizzle_migrations') as ledger`).toEqual([{ items: null, ledger: null }])
  })

  it("refuses different schema search paths for the same role on one database before creating any tables", { timeout: 30_000 }, async () => {
    const url = await createDatabase()
    const owner = connect(url)
    await owner.unsafe("create schema alpha")
    await owner.unsafe("create schema beta")
    const alpha = postgres(url, { connection: { search_path: "alpha,public" }, onnotice: () => {} })
    const beta = postgres(url, { connection: { search_path: "beta,public" }, onnotice: () => {} })
    cleanups.push(() => alpha.end(), () => beta.end())
    const migration = { dataLoss: [], hash: "hash-b0", name: "b0", statements: ["CREATE TABLE b_items (id int)"], when: 1_000 }
    await expect(migratePostgres([
      { client: alpha, database: { migrations: [], name: "alpha" } },
      { client: beta, database: { migrations: [migration], name: "beta" } },
    ], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED" })
    expect(await owner`select to_regclass('alpha.b_items') as alpha, to_regclass('beta.b_items') as beta, to_regclass('drizzle.__drizzle_migrations') as ledger`).toEqual([{ alpha: null, beta: null, ledger: null }])
  })

  it("groups sessions with different TimeZone values as one database, and does not wait for its own lock", { timeout: 30_000 }, async () => {
    // A plain role that owns the test database, so it can create the ledger and tables, but cannot call pg_control_system().
    const admin = connect(adminUrl!)
    const role = `vitehub_plain_${randomUUID().replaceAll("-", "").slice(0, 8)}`
    await admin.unsafe(`create role ${role} login password 'plain'`)
    cleanups.push(() => admin.unsafe(`drop role if exists ${role}`))
    const url = await createDatabase()
    const name = new URL(url).pathname.slice(1)
    await admin.unsafe(`alter database ${name} owner to ${role}`)
    const owner = connect(url)
    await owner.unsafe("revoke execute on function pg_control_system() from public")
    const plainUrl = new URL(url)
    plainUrl.username = role
    plainUrl.password = "plain"

    const utc = postgres(plainUrl.href, { connection: { TimeZone: "UTC" }, onnotice: () => {} })
    const newYork = postgres(plainUrl.href, { connection: { TimeZone: "America/New_York" }, onnotice: () => {} })
    cleanups.push(() => utc.end(), () => newYork.end())
    // The sessions read the server start time differently; neither can read the system identifier.
    const [utcStart] = await utc`select pg_postmaster_start_time()::text as started`
    const [newYorkStart] = await newYork`select pg_postmaster_start_time()::text as started`
    expect(utcStart?.started).not.toBe(newYorkStart?.started)
    await expect(newYork`select system_identifier from pg_control_system()`).rejects.toThrow(/permission denied/)

    const entry = (tag: string, when: number, statement: string) => ({ dataLoss: [], hash: `hash-${tag}`, name: tag, statements: [statement], when })
    const log: string[] = []
    await migratePostgres([
      { client: utc, database: { migrations: [entry("a0", 1_000, "CREATE TABLE a0 (id int)")], name: "first" } },
      { client: newYork, database: { migrations: [entry("b0", 2_000, "CREATE TABLE b0 (id int)")], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual(['[vitehub] Database "first": applied a0.', '[vitehub] Database "second": applied b0.'])
  })
})
