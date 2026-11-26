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

import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { build } from "esbuild"
import pg from "pg"
import postgres from "postgres"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { readStartMigrations } from "../src/internal/migrate-on-start.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { hubDatabase } from "../src/nuxt.ts"
import { ensureDatabaseMigrations, migrateOnStart, migratePostgres, postgresMigrationLock } from "../src/runtime/migrate-on-start.ts"

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

async function createProject(migrations: Array<{ sql: string, tag: string, when: number }>, definition: string[] = []) {
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
    ...definition,
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
  await hubDatabase(options)(undefined, {
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
    'import { useDatabase } from "@vite-hub/database"',
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
async function readLedger(sql: postgres.Sql, schema = "drizzle") {
  return await sql<Array<{ applied: boolean, created_at: string, hash: string, id: number, name: string | null }>>`select id, hash, created_at, name, applied_at is not null as applied from ${sql(schema)}.__drizzle_migrations order by id`
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

function postgresDatabase(url: string, migrationsDir: string, migrationsSchema?: string): ResolvedDrizzleDatabaseConfig {
  return { connection: { url }, dialect: "postgresql", generatedSchemaFile: "", migrationsDir, ...migrationsSchema && { migrationsSchema }, mode: "default", name: "default", orm: "drizzle" }
}

describe.skipIf(!adminUrl)("ensureMigrations on Postgres", () => {
  it("applies each migration once when four processes call it together, without the start plugin", { timeout: 120_000 }, async () => {
    const { root } = await createProject([init, seed])
    const url = await createDatabase()
    const server = await buildNodeServer(root, { migrateOnStart: false }, [
      'import { ensureMigrations } from "@vite-hub/database"',
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
    const { migrationsDir, root } = await createProject([init, seed])
    const server = await buildNodeServer(root, {})
    await server.start(url)
    const ledger = await readLedger(owner)
    await owner.unsafe(`grant usage on schema public, drizzle to ${role}`)
    await owner.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`)
    await owner.unsafe(`grant select on drizzle.__drizzle_migrations to ${role}`)
    await writeNuxtHubHistory(owner, [], ["0000_init", "0001_seed"])
    const runtimeUrl = new URL(url)
    runtimeUrl.username = role
    runtimeUrl.password = "runtime"
    const runtime = connect(runtimeUrl.href)
    expect(await runtime`select has_database_privilege(current_user, current_database(), 'CREATE') as ddl`).toEqual([{ ddl: false }])
    expect(await runtime`select has_table_privilege(current_user, '_hub_migrations', 'SELECT') as history`).toEqual([{ history: false }])
    expect((await server.start(runtimeUrl.href)).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    await expect(readMigrationPlan(postgresDatabase(runtimeUrl.href, migrationsDir), { env: {}, projectRoot: root })).resolves.toMatchObject([undefined, { applied: 2, pending: [] }])
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

async function writeNuxtHubHistory(sql: postgres.Sql, migrations: Array<{ sql: string }>, names: string[], table = "_hub_migrations") {
  for (const migration of migrations) await sql.unsafe(migration.sql.replaceAll("--> statement-breakpoint", ""))
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  for (const name of names) await sql.unsafe(`INSERT INTO ${table} (name) VALUES ($1)`, [name])
}

const ledgerRow = (migration: { sql: string, tag: string, when: number }) => ({ created_at: String(migration.when), hash: createHash("sha256").update(migration.sql).digest("hex"), name: migration.tag })

function migrateCommand(root: string, ...databases: ResolvedDrizzleDatabaseConfig[]) {
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: databases.map(database => database.name),
    databases: Object.fromEntries(databases.map(database => [database.name, database])),
    generatedDrizzleConfigFile: join(root, "drizzle.config.ts"),
    generatedDrizzleConfigFilesByDatabase: Object.fromEntries(databases.map(database => [database.name, join(root, `${database.name}.config.ts`)])),
    rootDir: root,
  }) as unknown as ResolvedDBViteConfig)!
  const command = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!
  return async (args: string[]) => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    const exitCode = await command.run(args, { env: process.env, rootDir: root, spawn: () => Promise.reject(new Error("drizzle-kit must not run")), stderr: { write: stderr }, stdout: { write: stdout } } as never)
    const text = (write: typeof stdout) => write.mock.calls.map(([chunk]) => String(chunk)).join("")
    return { exitCode, stderr: text(stderr), stdout: text(stdout) }
  }
}

describe.skipIf(!adminUrl)("NuxtHub's _hub_migrations on Postgres", () => {
  it("refuses the same ambiguous history in preview and in the locked migration", { timeout: 60_000 }, async () => {
    const first = await createProject([init])
    const other = await createProject([{ ...init, tag: "20260102000000_init", sql: "CREATE TABLE widgets (id int);" }])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [init], ["0000_init"])
    const migrate = migrateCommand(first.root, postgresDatabase(url, first.migrationsDir), { ...postgresDatabase(url, other.migrationsDir), name: "other" })
    for (const flag of ["--dry-run", "--allow-data-loss"]) {
      const result = await migrate([flag])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("0000_init, which matches more than one migration")
      expect(result.stdout).not.toContain("Applied before")
    }
    expect(await sql`select to_regclass('drizzle.__drizzle_migrations')::text as ledger`).toEqual([{ ledger: null }])
  })
  it("does not rerun the migrations that _hub_migrations lists, and records them", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [init, seed], ["0000_init", "0001_seed"])
    const server = await buildNodeServer(root, {})

    const started = await server.start(url)
    expect(started.stdout.trim().split("\n")).toEqual([
      `[vitehub] Database "default": recorded ${init.tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": recorded ${seed.tag} as applied, as _hub_migrations lists it.`,
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
    const ledger = (await readLedger(sql)).map(({ created_at, hash, name }) => ({ created_at, hash, name }))
    expect(ledger).toEqual([ledgerRow(init), ledgerRow(seed)])
    await migrate(drizzle({ client: sql }), { migrationsFolder: migrationsDir })
    expect(await readLedger(sql)).toHaveLength(2)
    expect((await server.start(url)).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
  })

  it("applies the one it does not list, and ignores names that match no folder", { timeout: 60_000 }, async () => {
    const { root } = await createProject([init, seed, addEmail])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [init, seed], ["0000_init", "0001_seed", "0007_removed"])

    const started = await (await buildNodeServer(root, {})).start(url)
    expect(started.stdout.trim().split("\n")).toEqual([
      `[vitehub] Database "default": recorded ${init.tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": recorded ${seed.tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": applied ${addEmail.tag}.`,
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
    expect((await readLedger(sql)).map(row => row.name)).toEqual([init.tag, seed.tag, addEmail.tag])
  })

  it("ignores _hub_migrations outside the search_path", { timeout: 60_000 }, async () => {
    const { root } = await createProject([init])
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe("CREATE SCHEMA other")
    await writeNuxtHubHistory(sql, [], ["0000_init"], "other._hub_migrations")

    const started = await (await buildNodeServer(root, {})).start(url)
    expect(started.stdout.trim().split("\n")).toEqual([`[vitehub] Database "default": applied ${init.tag}.`, "[]"])
    expect((await readLedger(sql)).map(row => row.name)).toEqual([init.tag])
  })

  it("adopts on node-postgres", { timeout: 60_000 }, async () => {
    const { migrationsDir } = await createProject([init, seed, addEmail])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [init, seed], ["0000_init", "0001_seed"])
    const pool = new pg.Pool({ connectionString: url, max: 2 })
    cleanups.push(() => pool.end())
    const log: string[] = []

    await migrateOnStart([{ db: drizzleNodePostgres({ client: pool }), dialect: "postgresql", migrations: readStartMigrations(migrationsDir, "postgresql"), name: "default" }], { log: message => log.push(message) })
    expect(log).toEqual([
      `[vitehub] Database "default": recorded ${init.tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": recorded ${seed.tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": applied ${addEmail.tag}.`,
    ])
    expect((await readLedger(sql)).map(({ created_at, hash, name }) => ({ created_at, hash, name }))).toEqual([ledgerRow(init), ledgerRow(seed), ledgerRow(addEmail)])
  })

  it("--dry-run prints Applied before, and `vitehub database migrate` records them", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed, addEmail])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [init, seed], ["0000_init", "0001_seed", "0007_removed"])
    const run = migrateCommand(root, postgresDatabase(url, migrationsDir))

    const dryRun = await run(["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain([
      "1 pending migration.",
      `  Applied before, as _hub_migrations lists: ${init.tag}, ${seed.tag}`,
      "  Not in the migrations folder, as _hub_migrations lists: 0007_removed",
      "",
      `  ${addEmail.tag}`,
    ].join("\n"))
    expect(await sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`).toEqual([{ name: null }])

    const applied = await run([])
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    expect(applied.stdout).toContain(`[vitehub] Database "default": recorded ${init.tag} as applied, as _hub_migrations lists it.`)
    expect(applied.stdout).toContain(`[vitehub] Database "default": applied ${addEmail.tag}.`)
    expect((await readLedger(sql)).map(row => row.name)).toEqual([init.tag, seed.tag, addEmail.tag])
    const again = await run(["--dry-run"])
    expect(again.stdout).toContain(": no pending migrations.\n")
    expect(again.stdout).not.toContain("Not in the migrations folder")
  })

  it.each([
    ["20231114221320_bootstrap", "bootstrap"],
    ["20231114221320_0001_create-users.postgresql", "0001_create-users"],
  ])("matches the NuxtHub file name that the folder %s keeps, in --dry-run and on start", { timeout: 60_000 }, async (tag, name) => {
    const kept = { ...init, tag }
    const { migrationsDir, root } = await createProject([kept, addEmail])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [kept], [name])

    const dryRun = await migrateCommand(root, postgresDatabase(url, migrationsDir))(["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain(`1 pending migration.\n  Applied before, as _hub_migrations lists: ${tag}\n\n  ${addEmail.tag}`)
    const log: string[] = []
    await migrateOnStart([{ db: drizzle({ client: sql }), dialect: "postgresql", migrations: readStartMigrations(migrationsDir, "postgresql"), name: "default" }], { log: message => log.push(message) })
    expect(log).toEqual([
      `[vitehub] Database "default": recorded ${tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": applied ${addEmail.tag}.`,
    ])
    expect((await readLedger(sql)).map(row => row.name)).toEqual([tag, addEmail.tag])
  })

  it("adopts the history seen by --dry-run before creating a schema earlier on the search path", async () => {
    const { migrationsDir, root } = await createProject([init])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [init], ["0000_init"])
    await sql`alter database ${sql(new URL(url).pathname.slice(1))} set search_path to drizzle, public`
    const run = migrateCommand(root, postgresDatabase(url, migrationsDir))

    const dryRun = await run(["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain(`Applied before, as _hub_migrations lists: ${init.tag}`)
    const applied = await run([])
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    expect(applied.stdout).toContain(`recorded ${init.tag} as applied, as _hub_migrations lists it.`)
    expect(await sql`select to_regclass('drizzle.users')::text as name`).toEqual([{ name: null }])
  })

  it("fails the check when _hub_migrations lists a migration that now has another number", { timeout: 60_000 }, async () => {
    const early = { sql: "SELECT 1;", tag: "20231114221319_early", when: 1_699_999_999_000 }
    const { migrationsDir, root } = await createProject([early, init])
    const url = await createDatabase()
    const sql = connect(url)
    await writeNuxtHubHistory(sql, [init], ["0000_init"])

    const [error] = await readMigrationPlan(postgresDatabase(url, migrationsDir), { env: {}, projectRoot: root })
    expect(error?.code).toBe("DATABASE_MIGRATION_CHECK_FAILED")
    expect(error?.why).toContain(`The migrations table public._hub_migrations lists 0000_init, but that migration is now 0001_init (${init.tag}), so ViteHub would apply it again.`)
    await expect(migratePostgres([{ client: sql, database: { migrations: readStartMigrations(migrationsDir, "postgresql"), name: "default" } }], { log: () => {} }))
      .rejects.toMatchObject({ code: "DATABASE_MIGRATION_CHECK_FAILED" })
    expect(await sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`).toEqual([{ name: null }])
  })
})

describe.skipIf(!adminUrl)("migrationsSchema on Postgres", () => {
  const inApp = ['  migrationsSchema: "app",']
  const startTarget = (sql: postgres.Sql, migrationsDir: string) => [{ client: sql, database: { migrations: readStartMigrations(migrationsDir, "postgresql"), migrationsSchema: "app", name: "default" } }]
  const schemas = async (sql: postgres.Sql) => (await sql<Array<{ nspname: string }>>`select nspname from pg_namespace where nspname in ('app', 'drizzle') order by nspname`).map(row => row.nspname)
  const widgets = { sql: "CREATE TABLE \"widgets\" (\"id\" integer);", tag: "20260102000000_widgets", when: 1_767_312_000_000 }
  const clearWidgets = { sql: "DELETE FROM \"widgets\" WHERE \"id\" > 0;", tag: "20260102000001_clear_widgets", when: 1_767_312_001_000 }
  const clearAgain = { sql: clearWidgets.sql, tag: "20260102000002_clear_widgets_again", when: 1_767_312_002_000 }
  const fixStatements = (fix: string | undefined) => (fix ?? "").split("\n").filter(line => /^(?:CREATE TABLE|INSERT INTO) /.test(line))

  it("keeps the ledger in migrationsSchema and creates no drizzle schema", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe("CREATE SCHEMA app")

    const started = await (await buildNodeServer(root, {})).start(url)
    expect(started.stdout.trim().split("\n")).toEqual([
      `[vitehub] Database "default": applied ${init.tag}.`,
      `[vitehub] Database "default": applied ${seed.tag}.`,
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
    expect(await schemas(sql)).toEqual(["app"])
    expect((await readLedger(sql, "app")).map(({ created_at, hash, name }) => ({ created_at, hash, name }))).toEqual([ledgerRow(init), ledgerRow(seed)])
    await migrate(drizzle({ client: sql }), { migrationsFolder: migrationsDir, migrationsSchema: "app" })
    expect(await readLedger(sql, "app")).toHaveLength(2)
    const dryRun = await migrateCommand(root, postgresDatabase(url, migrationsDir, "app"))(["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain(": no pending migrations.")
    expect(await schemas(sql)).toEqual(["app"])
  })

  it("fails with DATABASE_MIGRATION_SCHEMA_MISSING on start and in --dry-run, and creates no schema", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init], inApp)
    const url = await createDatabase()
    const sql = connect(url)

    await expect(migratePostgres(startTarget(sql, migrationsDir), { log: () => {} })).rejects.toMatchObject({
      code: "DATABASE_MIGRATION_SCHEMA_MISSING",
      fix: expect.stringContaining("vitehub database sql 'CREATE SCHEMA \"app\"'"),
    })
    const dryRun = await migrateCommand(root, postgresDatabase(url, migrationsDir, "app"))(["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_SCHEMA_MISSING")
    expect(await schemas(sql)).toEqual([])
  })

  it("stops a folder that drizzle lists by name with other SQL without printing its row", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: [{ dataLoss: [], hash: "other-sql", name: init.tag, statements: ["CREATE TABLE other_users (id int)"], when: init.when }], name: "other" } }], { log: () => {} })
    await sql.unsafe("CREATE SCHEMA app")
    const shared = await readLedger(sql)

    const [error] = await readMigrationPlan(postgresDatabase(url, migrationsDir, "app"), { env: {}, projectRoot: root })
    expect(error).toMatchObject({ code: "DATABASE_MIGRATION_LEDGER_MISPLACED", why: expect.stringContaining(`lists the name of "${init.tag}" with other SQL`) })
    expect(error?.fix).toContain(`does not show that this database ran the exact SQL of "${init.tag}"`)
    expect(fixStatements(error?.fix).filter(statement => statement.startsWith("INSERT INTO"))).toEqual([])
    await expect(migratePostgres(startTarget(sql, migrationsDir), { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_LEDGER_MISPLACED" })
    expect(await sql`select to_regclass('public.users')::text as name`).toEqual([{ name: null }])
    expect(await readLedger(sql)).toEqual(shared)
  })

  it("applies a migration when a Drizzle Kit 0.x row in drizzle has the same second and other SQL", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe("CREATE SCHEMA \"drizzle\"")
    await sql.unsafe("CREATE TABLE \"drizzle\".\"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)")
    await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${"other-sql"}, ${init.when + 417})`
    await sql.unsafe("CREATE SCHEMA app")
    const kit0x = await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`

    const [error, plan] = await readMigrationPlan(postgresDatabase(url, migrationsDir, "app"), { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending.map(migration => migration.name)).toEqual([init.tag])
    const log: string[] = []
    await migratePostgres(startTarget(sql, migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([`[vitehub] Database "default": applied ${init.tag}.`])
    expect((await readLedgerColumns(sql)).map(column => column.column_name)).toEqual(["id", "hash", "created_at"])
    expect(await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`).toEqual(kit0x)
  })

  it("fails with DATABASE_MIGRATION_LEDGER_MISPLACED when drizzle lists its migrations and the app ledger is empty, and the printed SQL fixes it", { timeout: 60_000 }, async () => {
    const app = await createProject([widgets, clearWidgets], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: readStartMigrations(app.migrationsDir, "postgresql"), name: "default" } }], { log: () => {} })
    await sql.unsafe("INSERT INTO widgets (id) VALUES (1)")
    await sql.unsafe("CREATE SCHEMA app")
    const shared = await readLedger(sql)

    const failure = { code: "DATABASE_MIGRATION_LEDGER_MISPLACED", why: expect.stringContaining(`"${widgets.tag}", "${clearWidgets.tag}"`) }
    const [error] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    expect(error).toMatchObject(failure)
    const dryRun = await migrateCommand(app.root, postgresDatabase(url, app.migrationsDir, "app"))(["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_LEDGER_MISPLACED")
    await expect(migratePostgres(startTarget(sql, app.migrationsDir), { log: () => {} })).rejects.toMatchObject(failure)
    expect(await sql`select to_regclass('app.__drizzle_migrations')::text as name`).toEqual([{ name: null }])
    expect(await readLedger(sql)).toEqual(shared)

    expect(error?.fix).toMatch(/^Remove `migrationsSchema` to keep the ledger in "drizzle"\./)
    const statements = fixStatements(error?.fix)
    expect(statements).toHaveLength(3)
    for (const statement of statements) await sql.unsafe(statement)
    const log: string[] = []
    await migratePostgres(startTarget(sql, app.migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([])
    expect((await readLedger(sql, "app")).map(({ applied, created_at, hash, name }) => ({ applied, created_at, hash, name }))).toEqual([{ ...ledgerRow(widgets), applied: true }, { ...ledgerRow(clearWidgets), applied: true }])
    expect(await sql`select id from widgets`).toEqual([{ id: 1 }])
    expect(await readLedger(sql)).toEqual(shared)
  })

  it("applies a new folder with the SQL of a migration that the printed SQL copied to the app ledger", { timeout: 60_000 }, async () => {
    const app = await createProject([widgets, clearWidgets], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: readStartMigrations(app.migrationsDir, "postgresql"), name: "default" } }], { log: () => {} })
    await sql.unsafe("CREATE SCHEMA app")
    const shared = await readLedger(sql)
    const [error] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    for (const statement of fixStatements(error?.fix)) await sql.unsafe(statement)
    await sql.unsafe("INSERT INTO widgets (id) VALUES (2)")

    await writeMigrations(app.root, [widgets, clearWidgets, clearAgain])
    const [planError, plan] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    expect(planError).toBeUndefined()
    expect(plan?.pending.map(migration => migration.name)).toEqual([clearAgain.tag])
    const log: string[] = []
    await migratePostgres(startTarget(sql, app.migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([`[vitehub] Database "default": applied ${clearAgain.tag}.`])
    expect(await sql`select id from widgets`).toEqual([])
    expect((await readLedger(sql, "app")).map(({ name }) => name)).toEqual([widgets.tag, clearWidgets.tag, clearAgain.tag])
    expect(await readLedger(sql)).toEqual(shared)
  })

  it("fails with DATABASE_MIGRATION_LEDGER_MISPLACED when the app ledger is partial and drizzle lists a pending migration", { timeout: 60_000 }, async () => {
    const app = await createProject([widgets, clearWidgets], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: readStartMigrations(app.migrationsDir, "postgresql"), name: "default" } }], { log: () => {} })
    await sql.unsafe("INSERT INTO widgets (id) VALUES (1)")
    await sql.unsafe("CREATE SCHEMA app")
    await sql.unsafe("CREATE TABLE app.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text, applied_at timestamp with time zone DEFAULT now())")
    await sql`insert into app.__drizzle_migrations (hash, created_at, name) values (${ledgerRow(widgets).hash}, ${widgets.when}, ${widgets.tag})`
    const own = await readLedger(sql, "app")

    const failure = { code: "DATABASE_MIGRATION_LEDGER_MISPLACED", why: expect.stringContaining(`does not list "${clearWidgets.tag}".`) }
    const [error] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    expect(error).toMatchObject(failure)
    expect(error?.fix).toMatch(/^Keep `migrationsSchema`: the ledger in "app" lists 1 migration\(s\)/)
    expect(error?.fix).not.toContain("Remove `migrationsSchema`")
    expect(fixStatements(error?.fix)).toHaveLength(2)
    await expect(migratePostgres(startTarget(sql, app.migrationsDir), { log: () => {} })).rejects.toMatchObject(failure)
    expect(await sql`select id from widgets`).toEqual([{ id: 1 }])
    expect(await readLedger(sql, "app")).toEqual(own)
  })

  /** Writes the ledger in "app" by hand with one row for each migration, as another folder layout or a repair left it. */
  async function writeAppLedger(sql: postgres.Sql, migrations: Array<{ sql: string, tag: string, when: number }>) {
    await sql.unsafe("CREATE TABLE app.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text, applied_at timestamp with time zone DEFAULT now())")
    for (const migration of migrations) await sql`insert into app.__drizzle_migrations (hash, created_at, name) values (${ledgerRow(migration).hash}, ${migration.when}, ${migration.tag})`
  }

  const inserts = (fix: string | undefined) => fixStatements(fix).filter(statement => statement.startsWith("INSERT INTO"))

  it("stops a folder that drizzle records by name when the app ledger records another folder with the same SQL", { timeout: 60_000 }, async () => {
    const app = await createProject([widgets, clearWidgets], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: readStartMigrations(app.migrationsDir, "postgresql"), name: "default" } }], { log: () => {} })
    await sql.unsafe("CREATE SCHEMA app")
    await writeAppLedger(sql, [widgets, clearAgain])
    await writeMigrations(app.root, [widgets, clearWidgets, clearAgain])
    await sql.unsafe("INSERT INTO widgets (id) VALUES (3)")
    const shared = await readLedger(sql)

    const failure = { code: "DATABASE_MIGRATION_LEDGER_MISPLACED", why: expect.stringContaining(`does not list "${clearWidgets.tag}".`) }
    const [error] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    expect(error).toMatchObject(failure)
    const dryRun = await migrateCommand(app.root, postgresDatabase(url, app.migrationsDir, "app"))(["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_LEDGER_MISPLACED")
    await expect(migratePostgres(startTarget(sql, app.migrationsDir), { log: () => {} })).rejects.toMatchObject(failure)
    expect(await sql`select id from widgets`).toEqual([{ id: 3 }])

    expect(inserts(error?.fix)).toEqual([`INSERT INTO "app"."__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${ledgerRow(clearWidgets).hash}', ${clearWidgets.when}, '${clearWidgets.tag}');`])
    for (const statement of fixStatements(error?.fix)) await sql.unsafe(statement)
    const [planError, plan] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    expect(planError).toBeUndefined()
    expect(plan?.pending).toEqual([])
    const log: string[] = []
    await migratePostgres(startTarget(sql, app.migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([])
    expect(await sql`select id from widgets`).toEqual([{ id: 3 }])
    expect(await readLedger(sql)).toEqual(shared)
  })

  it("stops a folder that a Drizzle Kit 0.x row records by hash and second when the app ledger records another folder with the same SQL", { timeout: 60_000 }, async () => {
    const app = await createProject([widgets, clearWidgets, clearAgain], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe(widgets.sql)
    await sql.unsafe("CREATE SCHEMA \"drizzle\"")
    await sql.unsafe("CREATE TABLE \"drizzle\".\"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)")
    for (const migration of [widgets, clearWidgets]) await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${ledgerRow(migration).hash}, ${migration.when + 417})`
    await sql.unsafe("CREATE SCHEMA app")
    await writeAppLedger(sql, [widgets, clearAgain])
    await sql.unsafe("INSERT INTO widgets (id) VALUES (3)")
    const kit0x = await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`

    const failure = { code: "DATABASE_MIGRATION_LEDGER_MISPLACED", why: expect.stringContaining(`does not list "${clearWidgets.tag}".`) }
    const [error] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    expect(error).toMatchObject(failure)
    expect(inserts(error?.fix)).toHaveLength(1)
    await expect(migratePostgres(startTarget(sql, app.migrationsDir), { log: () => {} })).rejects.toMatchObject(failure)
    expect(await sql`select id from widgets`).toEqual([{ id: 3 }])
    expect((await readLedgerColumns(sql)).map(column => column.column_name)).toEqual(["id", "hash", "created_at"])
    expect(await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`).toEqual(kit0x)
  })

  it("stops a renamed applied folder without printing its row", { timeout: 60_000 }, async () => {
    const app = await createProject([widgets], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: readStartMigrations(app.migrationsDir, "postgresql"), name: "default" } }], { log: () => {} })
    await sql.unsafe("CREATE SCHEMA app")
    const renamed = { ...widgets, tag: "20260102000000_create_widgets" }
    await writeMigrations(app.root, [renamed])

    const failure = { code: "DATABASE_MIGRATION_LEDGER_MISPLACED", why: expect.stringContaining(`does not list "${renamed.tag}".`) }
    const [error] = await readMigrationPlan(postgresDatabase(url, app.migrationsDir, "app"), { env: {}, projectRoot: app.root })
    expect(error).toMatchObject(failure)
    expect(error?.why).toContain("under a name that no local folder has")
    expect(error?.fix).toContain(`does not show that this database ran the exact SQL of "${renamed.tag}"`)
    expect(error?.fix).toContain("If a folder is new, change its SQL text")
    expect(error?.fix).not.toContain("Remove `migrationsSchema`")
    expect(inserts(error?.fix)).toEqual([])
    const dryRun = await migrateCommand(app.root, postgresDatabase(url, app.migrationsDir, "app"))(["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_LEDGER_MISPLACED")
    await expect(migratePostgres(startTarget(sql, app.migrationsDir), { log: () => {} })).rejects.toMatchObject(failure)
    expect(await sql`select to_regclass('app.__drizzle_migrations')::text as name`).toEqual([{ name: null }])
  })

  async function createRuntimeRole(url: string) {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    const role = `vitehub_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'test'`)
    cleanups.unshift(async () => {
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await admin.end()
    })
    const runtimeUrl = new URL(url)
    runtimeUrl.username = role
    runtimeUrl.password = "test"
    const runtime = connect(runtimeUrl.href)
    return { role, runtime, url: runtimeUrl.href }
  }

  it("starts without access to drizzle when the ledger in migrationsSchema lists every migration", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: [{ dataLoss: [], hash: "other", name: "20200101000000_other", statements: ["CREATE TABLE other (id int)"], when: 1_577_836_800_000 }], name: "other" } }], { log: () => {} })
    await sql.unsafe("CREATE SCHEMA app")
    await migratePostgres(startTarget(sql, migrationsDir), { log: () => {} })
    const { role, runtime, url: runtimeUrl } = await createRuntimeRole(url)
    await sql.unsafe(`GRANT USAGE ON SCHEMA app TO ${role}`)
    await sql.unsafe(`GRANT SELECT ON app.__drizzle_migrations TO ${role}`)

    const log: string[] = []
    await migratePostgres(startTarget(runtime, migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([])
    const [error, plan] = await readMigrationPlan(postgresDatabase(runtimeUrl, migrationsDir, "app"), { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending).toEqual([])
  })

  it("applies its migrations when the role cannot read drizzle and the app ledger is empty", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init], inApp)
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: [{ dataLoss: [], hash: "other", name: "20200101000000_other", statements: ["CREATE TABLE other (id int)"], when: 1_577_836_800_000 }], name: "other" } }], { log: () => {} })
    await sql.unsafe("CREATE SCHEMA app")
    const { role, runtime, url: runtimeUrl } = await createRuntimeRole(url)
    await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA app TO ${role}`)
    await sql.unsafe(`GRANT CREATE ON SCHEMA public TO ${role}`)

    const [error, plan] = await readMigrationPlan(postgresDatabase(runtimeUrl, migrationsDir, "app"), { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending.map(migration => migration.name)).toEqual([init.tag])
    const log: string[] = []
    await migratePostgres(startTarget(runtime, migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([`[vitehub] Database "default": applied ${init.tag}.`])
    expect((await readLedger(sql, "app")).map(row => row.name)).toEqual([init.tag])
  })

  it("ignores a ledger in drizzle that lists none of its migrations", { timeout: 60_000 }, async () => {
    const { migrationsDir } = await createProject([init])
    const url = await createDatabase()
    const sql = connect(url)
    await migratePostgres([{ client: sql, database: { migrations: [{ dataLoss: [], hash: "other", name: "20200101000000_other", statements: ["CREATE TABLE other (id int)"], when: 1_577_836_800_000 }], name: "other" } }], { log: () => {} })
    await sql.unsafe("CREATE SCHEMA app")
    const log: string[] = []

    await migratePostgres(startTarget(sql, migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([`[vitehub] Database "default": applied ${init.tag}.`])
    expect((await readLedger(sql, "app")).map(row => row.name)).toEqual([init.tag])
    expect((await readLedger(sql)).map(row => row.name)).toEqual(["20200101000000_other"])
  })

  it("fails with DATABASE_MIGRATION_SCHEMA_CONFLICT when two Definitions on one database set different schemas", { timeout: 60_000 }, async () => {
    const url = await createDatabase()
    const sql = connect(url)
    const migration = (name: string) => ({ dataLoss: [], hash: name, name, statements: [`CREATE TABLE ${name} (id int)`], when: 1_000 })

    await expect(migratePostgres([
      { client: sql, database: { migrations: [migration("a0")], migrationsSchema: "app", name: "first" } },
      { client: connect(url), database: { migrations: [migration("b0")], name: "second" } },
    ], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SCHEMA_CONFLICT", why: expect.stringContaining("\"first\" and \"second\"") })
    expect(await schemas(sql)).toEqual([])
  })

  it("fails --dry-run with DATABASE_MIGRATION_SCHEMA_CONFLICT when two Definitions on one database set different schemas", { timeout: 60_000 }, async () => {
    const first = await createProject([init], inApp)
    const other = await createProject([{ sql: "CREATE TABLE widgets (id int);", tag: "20260102000000_widgets", when: 1_767_312_000_000 }])
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe("CREATE SCHEMA app")

    const dryRun = await migrateCommand(first.root, postgresDatabase(url, first.migrationsDir, "app"), { ...postgresDatabase(url, other.migrationsDir), name: "other" })(["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_SCHEMA_CONFLICT")
    expect(await schemas(sql)).toEqual(["app"])
  })

  it("reads _hub_migrations in migrationsSchema", { timeout: 60_000 }, async () => {
    const { migrationsDir, root } = await createProject([init, seed])
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe("CREATE SCHEMA app")
    await writeNuxtHubHistory(sql, [init], ["0000_init"], "app._hub_migrations")
    const log: string[] = []

    const [error, plan] = await readMigrationPlan(postgresDatabase(url, migrationsDir, "app"), { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.adopted).toEqual([{ from: "_hub_migrations", name: init.tag }])
    expect(plan?.pending.map(migration => migration.name)).toEqual([seed.tag])

    await migratePostgres(startTarget(sql, migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([
      `[vitehub] Database "default": recorded ${init.tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": applied ${seed.tag}.`,
    ])
    expect((await readLedger(sql, "app")).map(row => row.name)).toEqual([init.tag, seed.tag])
    expect(await schemas(sql)).toEqual(["app"])
  })

  it("prints repair SQL that names the migrationsSchema table outside the search path", { timeout: 60_000 }, async () => {
    const early = { sql: "SELECT 1;", tag: "20231114221319_early", when: 1_699_999_999_000 }
    const { migrationsDir, root } = await createProject([early, init])
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe("CREATE SCHEMA app")
    await writeNuxtHubHistory(sql, [init], ["0000_init"], "app._hub_migrations")

    const [error] = await readMigrationPlan(postgresDatabase(url, migrationsDir, "app"), { env: {}, projectRoot: root })
    expect(error?.code).toBe("DATABASE_MIGRATION_CHECK_FAILED")
    const repair = /`(UPDATE [^`]+)`/.exec(error?.why ?? "")?.[1]
    expect(repair).toBe(`UPDATE app._hub_migrations SET name = '${init.tag}' WHERE name = '0000_init'`)
    await expect(migratePostgres(startTarget(sql, migrationsDir), { log: () => {} })).rejects.toMatchObject({ why: expect.stringContaining(repair!) })

    await sql.unsafe(repair!)
    const log: string[] = []
    await migratePostgres(startTarget(sql, migrationsDir), { log: message => log.push(message) })
    expect(log).toEqual([
      `[vitehub] Database "default": recorded ${init.tag} as applied, as _hub_migrations lists it.`,
      `[vitehub] Database "default": applied ${early.tag}.`,
    ])
  })

  it("names each history table that lists a renumbered migration", { timeout: 60_000 }, async () => {
    const early = { sql: "SELECT 1;", tag: "20231114221319_early", when: 1_699_999_999_000 }
    const { migrationsDir, root } = await createProject([early, init])
    const url = await createDatabase()
    const sql = connect(url)
    await sql.unsafe("CREATE SCHEMA \"My App\"")
    await writeNuxtHubHistory(sql, [init], ["0000_init"], "\"My App\"._hub_migrations")
    await writeNuxtHubHistory(sql, [], ["0000_init"])

    const [error] = await readMigrationPlan(postgresDatabase(url, migrationsDir, "My App"), { env: {}, projectRoot: root })
    expect(error?.why).toContain(`The migrations tables "My App"._hub_migrations, public._hub_migrations list 0000_init`)
    expect(error?.why).toContain(`\`UPDATE "My App"._hub_migrations SET name = '${init.tag}' WHERE name = '0000_init'\``)
    expect(error?.why).toContain(`\`UPDATE public._hub_migrations SET name = '${init.tag}' WHERE name = '0000_init'\``)
  })
})
