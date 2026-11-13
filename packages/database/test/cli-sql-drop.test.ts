// The Postgres cases run only with a Postgres server, for example:
// docker run -d --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
// VITEHUB_TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:54329/postgres vitest run test/cli-sql-drop.test.ts
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@libsql/client"
import postgres from "postgres"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"

import type { DbCliIo } from "../src/cli.ts"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function createProject(databases: Record<string, Partial<ResolvedDrizzleDatabaseConfig>>, io: DbCliIo = {}) {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".db-sql-"))
  cleanups.push(() => rm(rootDir, { force: true, recursive: true }))
  const resolved = Object.fromEntries(Object.entries(databases).map(([name, database]) => [name, {
    dialect: "sqlite",
    migrationsDir: join(rootDir, "migrations"),
    name,
    ...database,
  }]))
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: Object.keys(resolved),
    databases: resolved,
    rootDir,
  }) as unknown as ResolvedDBViteConfig, { readStdin: async () => undefined, ...io })!

  async function run(name: "drop" | "sql", args: string[], options: { env?: NodeJS.ProcessEnv, fetch?: typeof fetch } = {}) {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === name)!
    const exitCode = await command.run(args, { cwd: rootDir, env: options.env ?? {}, fetch: options.fetch, rootDir, spawn: vi.fn(), stderr, stdout } as never)
    const text = (write: ReturnType<typeof vi.fn>) => write.mock.calls.map(([chunk]) => String(chunk)).join("")
    return { exitCode, stderr: text(stderr.write), stdout: text(stdout.write) }
  }

  return { rootDir, run }
}

async function seedSqlite(file: string, sql: string) {
  await mkdir(join(file, ".."), { recursive: true })
  const client = createClient({ url: `file:${file}` })
  try {
    await client.executeMultiple(sql)
  }
  finally {
    client.close()
  }
}

async function sqliteObjects(file: string) {
  const client = createClient({ url: `file:${file}` })
  try {
    return (await client.execute("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map(row => `${row.type} ${row.name}`)
  }
  finally {
    client.close()
  }
}

const sqliteSeed = `
CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT);
INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('h', 1, '20260101000000_init');
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar BLOB);
CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT);
CREATE VIEW titles AS SELECT title FROM posts;
CREATE VIRTUAL TABLE search USING fts5(title);
INSERT INTO users (name, avatar) VALUES ('Ada', x'00ff'), ('Grace', NULL);
INSERT INTO posts (user_id, title) VALUES (1, 'Notes'), (2, 'Compilers');
INSERT INTO search (title) VALUES ('Notes');
PRAGMA foreign_keys = ON;
`

describe("vitehub database sql", () => {
  it("prints the rows of each statement as a table on local SQLite", async () => {
    const project = await createProject({ default: { connection: { url: "file:app.db" } } })
    await seedSqlite(join(project.rootDir, "app.db"), sqliteSeed)

    const result = await project.run("sql", ["UPDATE users SET name = 'Ada L' WHERE id = 1; SELECT id, name, avatar FROM users ORDER BY id"])

    expect(result).toMatchObject({ exitCode: 0, stderr: "[vitehub] Database \"default\" (local SQLite app.db).\n" })
    expect(result.stdout).toBe([
      "OK, 1 row changed.",
      "",
      "id | name  | avatar",
      "---+-------+--------",
      "1  | Ada L | x'00ff'",
      "2  | Grace | NULL",
      "(2 rows)",
      "",
    ].join("\n"))
  })

  it("reads the SQL from stdin and prints JSON with --json", async () => {
    const project = await createProject({ default: { connection: { url: "file:app.db" } } }, { readStdin: async () => "SELECT count(*) AS users FROM users;\nSELECT name FROM users WHERE id = 2;\n" })
    await seedSqlite(join(project.rootDir, "app.db"), sqliteSeed)

    const result = await project.run("sql", ["--json"])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      { columns: ["users"], rows: [{ users: 2 }], rowsAffected: null },
      { columns: ["name"], rows: [{ name: "Grace" }], rowsAffected: null },
    ])
  })

  it("fails with DATABASE_SQL_FAILED for a SQL error, a missing file, or a remote database without --remote", async () => {
    const project = await createProject({ default: { connection: { url: "file:app.db" } } })
    const missing = await project.run("sql", ["SELECT 1"])
    expect(missing).toMatchObject({ exitCode: 1, stdout: "" })
    expect(missing.stderr).toContain("DATABASE_SQL_FAILED")
    expect(missing.stderr).toContain("local SQLite app.db, which does not exist. Run `vitehub database migrate` to create it.")
    // A missing file is not created.
    expect(existsSync(join(project.rootDir, "app.db"))).toBe(false)

    await seedSqlite(join(project.rootDir, "app.db"), sqliteSeed)
    const broken = await project.run("sql", ["SELECT * FROM nope"])
    expect(broken.exitCode).toBe(1)
    expect(broken.stderr).toContain("DATABASE_SQL_FAILED")
    expect(broken.stderr).toContain("no such table: nope")

    const libsql = await createProject({ default: { connection: { url: "libsql://db.example.turso.io" } } })
    const withoutRemote = await libsql.run("sql", ["SELECT 1"])
    expect(withoutRemote.exitCode).toBe(1)
    expect(withoutRemote.stderr).toContain("It uses libSQL libsql://db.example.turso.io. Add `--remote` to reach a database that is not on this machine.")
    const localWithRemote = await project.run("sql", ["--remote", "SELECT 1"])
    expect(localWithRemote.exitCode).toBe(1)
    expect(localWithRemote.stderr).toContain("which is not remote. Remove `--remote`")
  })

  it("asks for SQL and for --database when it cannot pick", async () => {
    const project = await createProject({ analytics: { connection: { url: "file:analytics.db" } }, default: { connection: { url: "file:app.db" } } })
    expect(await project.run("sql", [])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No SQL to run.") })
    expect(await project.run("sql", ["SELECT 1"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Add --database <name> to pick one of: analytics, default.") })
    expect(await project.run("sql", ["SELECT 1", "--database", "missing"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("DATABASE_NOT_FOUND") })
    await seedSqlite(join(project.rootDir, "analytics.db"), "CREATE TABLE events (id INTEGER);")
    expect(await project.run("sql", ["--database=analytics", "-- count\nSELECT count(*) AS n FROM events"])).toMatchObject({ exitCode: 0, stdout: "n\n-\n0\n(1 row)\n" })
  })

  it("sends each statement to a D1 HTTP proxy with --remote", async () => {
    const project = await createProject({ default: { cloudflare: { binding: "DB", databaseId: "db", http: { authToken: "secret", url: "https://d1.example.com/query" }, migrationsDir: "migrations" } } })
    const bodies: unknown[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ result: [{ results: [{ id: 1, name: "Ada" }], success: true }], success: true })
    })

    const result = await project.run("sql", ["--remote", "--json", "SELECT id, name FROM users"], { fetch: fetch as typeof globalThis.fetch })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([{ columns: ["id", "name"], rows: [{ id: 1, name: "Ada" }], rowsAffected: null }])
    expect(bodies).toEqual([{ params: [], sql: "SELECT id, name FROM users" }])
  })
})

describe("vitehub database drop", () => {
  it("drops every table, view, and the migrations table of local SQLite after a yes, and keeps them after a no", async () => {
    const answers = [false, true]
    const confirm = vi.fn(async () => answers.shift()!)
    const project = await createProject({ default: { connection: { url: "file:app.db" } } }, { confirm })
    const file = join(project.rootDir, "app.db")
    await seedSqlite(file, sqliteSeed)
    const before = await sqliteObjects(file)

    const refused = await project.run("drop", [])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("DATABASE_DROP_NOT_CONFIRMED")
    expect(await sqliteObjects(file)).toEqual(before)

    const dropped = await project.run("drop", [])
    expect(dropped).toMatchObject({ exitCode: 0, stderr: "" })
    expect(confirm).toHaveBeenLastCalledWith("Drop 5 tables and views of the database \"default\" (local SQLite app.db)? All their data is lost. [y/N] ")
    expect(dropped.stdout).toBe("[vitehub] Database \"default\" (local SQLite app.db): dropped view titles, table __drizzle_migrations, table users, table posts, table search.\n")
    expect(await sqliteObjects(file)).toEqual([])

    expect(await project.run("drop", [])).toMatchObject({ exitCode: 0, stdout: "[vitehub] Database \"default\" (local SQLite app.db): it has no tables to drop.\n" })
  })

  it("needs --force without a terminal, and refuses a remote database without --remote", async () => {
    const project = await createProject({ default: { connection: { url: "file:app.db" } } })
    const file = join(project.rootDir, "app.db")
    await seedSqlite(file, sqliteSeed)

    // Vitest has no terminal on stdin, so nothing can confirm.
    const refused = await project.run("drop", [])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("DATABASE_DROP_NOT_CONFIRMED")
    expect(refused.stderr).toContain("add `--force`")
    expect(await sqliteObjects(file)).not.toEqual([])

    expect(await project.run("drop", ["--force"])).toMatchObject({ exitCode: 0 })
    expect(await sqliteObjects(file)).toEqual([])

    const libsql = await createProject({ default: { connection: { url: "libsql://db.example.turso.io" } } })
    const remote = await libsql.run("drop", ["--force"])
    expect(remote.exitCode).toBe(1)
    expect(remote.stderr).toContain("DATABASE_DROP_FAILED")
    expect(remote.stderr).toContain("Add `--remote`")
  })

  it("drops nothing for a local file that does not exist, and does not create it", async () => {
    const project = await createProject({ default: { connection: { url: "file:.vitehub/data/app.db" } } })
    expect(await project.run("drop", ["--force"])).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("it does not exist, so there is nothing to drop") })
    expect(existsSync(join(project.rootDir, ".vitehub/data/app.db"))).toBe(false)
  })

  it("drops a D1 HTTP proxy database in one query that defers foreign keys", async () => {
    const project = await createProject({ default: { cloudflare: { binding: "DB", databaseId: "db", http: { authToken: "secret", url: "https://d1.example.com/query" }, migrationsDir: "migrations" } } })
    const sqls: string[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { sql } = JSON.parse(String(init?.body)) as { sql: string }
      sqls.push(sql)
      const results = sql.startsWith("PRAGMA table_list")
        ? [{ name: "users", schema: "main", type: "table" }, { name: "_cf_KV", schema: "main", type: "table" }]
        : sql.startsWith("SELECT type, name")
          ? [{ name: "_cf_KV", type: "table" }, { name: "d1_migrations", type: "table" }, { name: "users", type: "table" }]
          : []
      return Response.json({ result: [{ results, success: true }], success: true })
    })

    const result = await project.run("drop", ["--remote", "--force"], { fetch: fetch as typeof globalThis.fetch })

    expect(result).toMatchObject({ exitCode: 0, stdout: "[vitehub] Database \"default\" (D1 HTTP proxy https://d1.example.com/query): dropped table d1_migrations, table users.\n" })
    expect(sqls.at(-1)).toBe("PRAGMA defer_foreign_keys = ON;\nDROP TABLE IF EXISTS \"d1_migrations\";\nDROP TABLE IF EXISTS \"users\";")
  })
})

const postgresSeed = `
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ('h', 1, '20260101000000_init');
CREATE TYPE mood AS ENUM ('happy', 'sad');
CREATE SCHEMA billing;
CREATE TABLE billing.invoices (id integer PRIMARY KEY);
CREATE TABLE users (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, mood mood);
CREATE TABLE posts (id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id), title text);
CREATE SEQUENCE tickets;
CREATE VIEW titles AS SELECT title FROM posts;
INSERT INTO users (name, mood) VALUES ('Ada', 'happy'), ('Grace', NULL);
INSERT INTO posts (user_id, title) VALUES (1, 'Notes');
`

const postgresObjects = `
SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'v', 'S') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
UNION ALL SELECT 'type ' || typname FROM pg_type WHERE typtype = 'e'
UNION ALL SELECT 'schema ' || nspname FROM pg_namespace WHERE nspname IN ('billing', 'drizzle', 'public')
ORDER BY 1
`

describe("vitehub database sql and drop on PGlite", () => {
  it("runs SQL on the PGlite folder and drops its tables, types, ledger, and empty schemas", async () => {
    const project = await createProject({ default: { dialect: "postgresql", driver: "pglite" } }, { confirm: async () => true })
    const dir = join(project.rootDir, ".vitehub/data/database/pglite")
    await mkdir(join(dir, ".."), { recursive: true })
    const seed = new PGlite(dir)
    await seed.exec(postgresSeed)
    await seed.close()

    const sql = await project.run("sql", ["UPDATE users SET name = 'Ada L' WHERE id = 1; SELECT id, name, mood FROM users ORDER BY id;"])
    expect(sql).toMatchObject({ exitCode: 0, stderr: "[vitehub] Database \"default\" (PGlite .vitehub/data/database/pglite).\n" })
    expect(sql.stdout).toBe("OK, 1 row changed.\n\nid | name  | mood\n---+-------+------\n1  | Ada L | happy\n2  | Grace | NULL\n(2 rows)\n")

    const dropped = await project.run("drop", [])
    expect(dropped.exitCode).toBe(0)
    expect(dropped.stdout).toBe("[vitehub] Database \"default\" (PGlite .vitehub/data/database/pglite): dropped view \"public\".\"titles\", table \"billing\".\"invoices\", table \"drizzle\".\"__drizzle_migrations\", table \"public\".\"posts\", table \"public\".\"users\", sequence \"public\".\"tickets\", type \"public\".\"mood\".\n")

    const check = new PGlite(dir)
    try {
      expect((await check.query<{ name: string }>(postgresObjects)).rows.map(row => row.name)).toEqual(["schema public"])
      // The next migrate can create the same schema, type, and tables again.
      await check.exec(postgresSeed)
    }
    finally {
      await check.close()
    }
  })

  it("requires --remote for a Postgres server", async () => {
    const project = await createProject({ default: { connection: { url: "postgres://user:secret@db.example.com/app" }, dialect: "postgresql" } })
    const result = await project.run("sql", ["SELECT 1"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("It uses Postgres postgres://db.example.com/app. Add `--remote`")
    expect(result.stderr).not.toContain("secret")
  })
})

describe.skipIf(!postgresUrl)("vitehub database sql and drop on Postgres", () => {
  async function createDatabase() {
    const admin = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    const name = `vitehub_sql_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    await admin.unsafe(`create database ${name}`)
    cleanups.push(async () => {
      await admin.unsafe(`drop database if exists ${name} with (force)`)
      await admin.end()
    })
    const url = new URL(postgresUrl!)
    url.pathname = `/${name}`
    return url.href
  }

  it("runs several statements and drops the objects of the current user with --remote", async () => {
    const url = await createDatabase()
    const seed = postgres(url, { max: 1, onnotice: () => {} })
    await seed.unsafe(postgresSeed).simple()
    // The table of another role stays: drop only drops what the connecting user owns, like the `auth` tables of Supabase.
    await seed.unsafe([
      "DO $$ BEGIN CREATE ROLE vitehub_other_owner; EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
      "CREATE TABLE public.kept (id integer);",
      "ALTER TABLE public.kept OWNER TO vitehub_other_owner;",
    ].join("\n")).simple()
    await seed.end()
    const remote = await createProject({ default: { connection: { url }, dialect: "postgresql" } })

    const sql = await remote.run("sql", ["--remote", "--json", "INSERT INTO users (name) VALUES ('Linus'); SELECT name FROM users ORDER BY id"])
    expect(sql.exitCode).toBe(0)
    expect(JSON.parse(sql.stdout)).toEqual([
      { columns: [], rows: [], rowsAffected: 1 },
      { columns: ["name"], rows: [{ name: "Ada" }, { name: "Grace" }, { name: "Linus" }], rowsAffected: null },
    ])
    const single = await remote.run("sql", ["--remote", "SELECT count(*)::int AS n FROM posts"])
    expect(single).toMatchObject({ exitCode: 0, stdout: "n\n-\n1\n(1 row)\n" })

    const dropped = await remote.run("drop", ["--remote", "--force"])
    expect(dropped.exitCode).toBe(0)
    expect(dropped.stdout).not.toContain("kept")

    const check = postgres(url, { max: 1, onnotice: () => {} })
    try {
      expect((await check.unsafe<Array<{ name: string }>>(postgresObjects)).map(row => row.name)).toEqual(["public.kept", "schema public"])
      await check.unsafe(postgresSeed).simple()
    }
    finally {
      await check.end()
    }
  })
})
