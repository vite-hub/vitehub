import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { createRuntimeEnvConfigValue } from "../src/config-value.ts"

import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }))

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const seed = `
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, score REAL, data BLOB);
CREATE TABLE tags (name TEXT PRIMARY KEY, note_id INTEGER REFERENCES notes(id)) WITHOUT ROWID;
CREATE INDEX notes_title_idx ON notes (title);
CREATE VIEW titles AS SELECT title FROM notes;
CREATE TABLE audit (note_id INTEGER);
CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN INSERT INTO audit (note_id) VALUES (new.id); END;
INSERT INTO notes (title, score, data) VALUES ('it''s "quoted"', 1.0, x'00ff'), ('line
break' || char(0) || 'after', NULL, NULL);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200) INSERT INTO notes (title, score) SELECT 'note ' || i, i / 4.0 FROM n;
INSERT INTO tags VALUES ('b', 2), ('a', 1);
CREATE TABLE documents (title TEXT);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200) INSERT INTO documents (rowid, title) SELECT i * 2, 'document ' || i FROM n;
CREATE VIRTUAL TABLE search USING fts5(title);
INSERT INTO search (rowid, title) VALUES (42, 'searchable');
`

async function seedDatabase(file: string) {
  await mkdir(join(file, ".."), { recursive: true })
  const client = createClient({ url: `file:${file}` })
  try {
    await client.executeMultiple(seed)
  }
  finally {
    client.close()
  }
}

async function readAll(url: string) {
  const client = createClient({ url })
  try {
    const read = async (sql: string) => {
      const result = await client.execute(sql)
      return result.rows.map(row => Array.from(result.columns, (_, index) => row[index]).map(value => value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value))
    }
    return {
      audit: await read("SELECT count(*) FROM audit"),
      documents: await read("SELECT rowid, title FROM documents ORDER BY rowid"),
      notes: await read("SELECT id, title, hex(title), score, typeof(score), data FROM notes ORDER BY id"),
      schema: await read("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
      search: await read("SELECT rowid, title FROM search WHERE search MATCH 'searchable'"),
      sequence: await read("SELECT name, seq FROM sqlite_sequence"),
      tags: await read("SELECT name, note_id FROM tags ORDER BY name"),
    }
  }
  finally {
    client.close()
  }
}

async function createProject(databases: Record<string, Partial<ResolvedDrizzleDatabaseConfig>>) {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".db-export-"))
  tempDirs.push(rootDir)
  const resolved = Object.fromEntries(Object.entries(databases).map(([name, database]) => [name, {
    dialect: "sqlite",
    drizzle: {},
    migrationsDir: join(rootDir, "migrations"),
    name,
    ...database,
  }]))
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: Object.keys(resolved),
    databases: resolved,
    rootDir,
  }) as unknown as ResolvedDBViteConfig)!

  async function run(args: string[] = [], options: { env?: NodeJS.ProcessEnv, fetch?: typeof fetch, spawn?: unknown } = {}) {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === "export")!
    const exitCode = await command.run(args, { cwd: rootDir, env: options.env ?? {}, fetch: options.fetch, rootDir, spawn: options.spawn ?? vi.fn(), stderr, stdout } as never)
    const text = (write: ReturnType<typeof vi.fn>) => write.mock.calls.map(([chunk]) => String(chunk)).join("")
    return { exitCode, stderr: text(stderr.write), stdout: text(stdout.write) }
  }

  return { rootDir, run }
}

describe("vitehub db export", () => {
  it.each(["_rowid_", "rowid", "oid", "_rowid_,rowid", "_rowid_,rowid,oid"])("restores over 500 rows when generated columns shadow %s", async (alias) => {
    const project = await createProject({ default: { connection: { url: "file:source.db" } } })
    const client = createClient({ url: `file:${join(project.rootDir, "source.db")}` })
    const aliases = alias.split(",")
    const readableRowid = ["_rowid_", "rowid", "oid"].find(name => !aliases.includes(name))
    await client.executeMultiple(`
      CREATE TABLE documents (title TEXT, ${aliases.map(name => `"${name}" INTEGER GENERATED ALWAYS AS (1) ${name === "rowid" ? "VIRTUAL" : "STORED"}`).join(",")});
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1202)
      INSERT INTO documents (${readableRowid ? `${readableRowid}, ` : ""}title) SELECT ${readableRowid ? "i * 2, " : ""}'document ' || i FROM n;
    `)
    const select = `SELECT ${readableRowid ? `${readableRowid}, ` : ""}* FROM documents ORDER BY title`
    const original = await client.execute(select)
    const expected = original.rows.map(row => original.columns.map((_, index) => row[index]))
    client.close()

    await expect(project.run(["--output", "dump.sql"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    const dump = await readFile(join(project.rootDir, "dump.sql"), "utf8")
    const restored = createClient({ url: `file:${join(project.rootDir, "restored.db")}` })
    try {
      await restored.executeMultiple(`BEGIN;\n${dump}COMMIT;`)
      const actual = await restored.execute(select)
      expect(actual.rows.map(row => actual.columns.map((_, index) => row[index]))).toEqual(expected)
    }
    finally {
      restored.close()
    }
  })

  it.each(["content=''", 'content = ""', "content=``"])("rejects contentless FTS5 instead of losing its index: %s", async (option) => {
    const project = await createProject({ default: { connection: { url: "file:source.db" } } })
    const client = createClient({ url: `file:${join(project.rootDir, "source.db")}` })
    await client.executeMultiple(`CREATE VIRTUAL TABLE search USING fts5(title, ${option}); INSERT INTO search (rowid, title) VALUES (42, 'searchable');`)
    expect((await client.execute("SELECT rowid FROM search WHERE search MATCH 'searchable'")).rows[0]![0]).toBe(42)
    client.close()

    const result = await project.run(["--output", "dump.sql"])
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("DATABASE_EXPORT_FAILED") })
    expect(result.stderr).toContain("contentless FTS5")
    expect(result.stderr).toContain("search")
    await expect(readdir(project.rootDir)).resolves.toEqual(["source.db"])
  })

  it("dumps the local SQLite file, and the dump restores the same data", async () => {
    const project = await createProject({ default: {} })
    const source = join(project.rootDir, ".vitehub/data/database/sqlite.db")
    await seedDatabase(source)

    const result = await project.run()
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toMatch(/^\[vitehub\] Database "default" \(local SQLite \.vitehub\/data\/database\/sqlite\.db\): exported to \.vitehub\/exports\/database\/default-local-\d{4}-\d\d-\d\dT\d+Z\.sql\.\n$/)
    const [file] = await readdir(join(project.rootDir, ".vitehub/exports/database"))
    const dump = await readFile(join(project.rootDir, ".vitehub/exports/database", file!), "utf8")
    expect(dump.startsWith("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE notes")).toBe(true)
    expect(dump).toContain("INSERT INTO \"notes\" (\"id\",\"title\",\"score\",\"data\") VALUES(1,'it''s \"quoted\"',1.0,X'00FF');")
    expect(dump).not.toMatch(/^(?:BEGIN TRANSACTION|COMMIT);$/m)
    // Triggers come after the data, so restoring the rows does not fire them again.
    expect(dump.indexOf("CREATE TRIGGER")).toBeGreaterThan(dump.lastIndexOf("INSERT INTO \"notes\""))

    const restored = join(project.rootDir, "restored.db")
    const client = createClient({ url: `file:${restored}` })
    // A transaction keeps the restore fast. The dump has none, like `wrangler d1 export`.
    await client.executeMultiple(`BEGIN;\n${dump}COMMIT;`)
    client.close()
    const expected = await readAll(`file:${source}`)
    expect(expected.notes).toHaveLength(1202)
    expect(await readAll(`file:${restored}`)).toEqual(expected)
  })

  it("loads the connection URL from the stage env files and writes --output", async () => {
    const project = await createProject({ default: { connection: { url: createRuntimeEnvConfigValue(["EXPORT_DATABASE_URL"]) } } })
    await seedDatabase(join(project.rootDir, "data/staging.db"))
    await writeFile(join(project.rootDir, ".env.staging"), "EXPORT_DATABASE_URL=file:data/staging.db\n")

    const result = await project.run(["--stage", "staging", "--output", "backups/staging.sql"])
    expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: "[vitehub] Database \"default\" (local SQLite data/staging.db): exported to backups/staging.sql.\n" })
    await expect(readFile(join(project.rootDir, "backups/staging.sql"), "utf8")).resolves.toContain("CREATE TABLE tags")

    const again = await project.run(["--stage", "staging", "--output", "backups/staging.sql"])
    expect(again.exitCode).toBe(1)
    expect(again.stderr).toContain("DATABASE_EXPORT_FAILED")
    expect(again.stderr).toContain("The output file exists")
  })

  it("preserves an output file created while the export is running", async () => {
    const project = await createProject({ default: { dialect: "postgresql" } })
    const output = join(project.rootDir, "backup.sql")
    const spawn = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args[args.indexOf("--file") + 1]!, "new dump")
      await writeFile(output, "existing backup")
      return { exitCode: 0 }
    })
    const result = await project.run(["--remote", "--output", "backup.sql"], { spawn })
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("The output file exists") })
    await expect(readFile(output, "utf8")).resolves.toBe("existing backup")
    await expect(readdir(project.rootDir)).resolves.toEqual(["backup.sql"])
  })

  it("keeps concurrent exporters' partial files separate and publishes only one dump", async () => {
    const project = await createProject({ default: { dialect: "postgresql" } })
    let markStarted!: () => void
    let finishFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
    const firstCanFinish = new Promise<void>((resolve) => { finishFirst = resolve })
    let firstPartial: string | undefined
    const first = project.run(["--remote", "--output", "backup.sql"], { spawn: async (_command: string, args: string[]) => {
      firstPartial = args[args.indexOf("--file") + 1]!
      await writeFile(firstPartial, "first dump")
      markStarted()
      await firstCanFinish
      return { exitCode: 0 }
    } })
    await firstStarted
    try {
      const second = await project.run(["--remote", "--output", "backup.sql"], { spawn: async (_command: string, args: string[]) => {
        const partial = args[args.indexOf("--file") + 1]!
        expect(partial).not.toBe(firstPartial)
        await writeFile(partial, "second dump")
        return { exitCode: 0 }
      } })
      expect(second).toMatchObject({ exitCode: 0, stderr: "" })
      await expect(readFile(firstPartial!, "utf8")).resolves.toBe("first dump")
      await expect(readFile(join(project.rootDir, "backup.sql"), "utf8")).resolves.toBe("second dump")
    }
    finally {
      finishFirst()
      await first
    }
    await expect(first).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("The output file exists") })
    await expect(readFile(join(project.rootDir, "backup.sql"), "utf8")).resolves.toBe("second dump")
    await expect(readdir(project.rootDir)).resolves.toEqual(["backup.sql"])
  })

  it("asks for --remote before it reads a remote database, and refuses --remote for a local file", async () => {
    const remote = await createProject({ default: { connection: { authToken: "libsql-secret", url: "libsql://user:pass@db.example.com" } } })
    const result = await remote.run()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("It uses libSQL libsql://db.example.com. Add `--remote`")
    expect(result.stderr).not.toMatch(/secret|pass@/)

    const local = await createProject({ default: {} })
    const refused = await local.run(["--remote"])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("which is not remote")

    const missing = await local.run()
    expect(missing.stderr).toContain("The local SQLite file does not exist")
    expect(existsSync(join(local.rootDir, ".vitehub/data/database/sqlite.db"))).toBe(false)
  })

  it("selects one database with --database and requires it for --output with several databases", async () => {
    const project = await createProject({ analytics: {}, default: {} })
    await seedDatabase(join(project.rootDir, ".vitehub/data/database/analytics.sqlite.db"))
    await expect(project.run(["--output", "x.sql"])).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Add --database <name>") })
    await expect(project.run(["--database", "missing"])).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("DATABASE_NOT_FOUND") })
    await expect(project.run(["--database", "analytics", "--output", "x.sql"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.run(["--bogus"])).resolves.toMatchObject({ exitCode: 1, stderr: "[vitehub] Unknown option: --bogus\n" })
  })

  it("exports remote D1 with the Cloudflare export API and finds the database by name", async () => {
    const project = await createProject({ default: { cloudflare: { binding: "DB", databaseName: "app-db", migrationsDir: "migrations" } } })
    const calls: Array<{ auth?: string, body?: unknown, url: string }> = []
    let polls = 0
    const request = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      calls.push({ auth: (init?.headers as Record<string, string> | undefined)?.Authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined, url })
      if (url.endsWith("/d1/database?name=app-db")) return Response.json({ result: [{ name: "app-db-old", uuid: "old" }, { name: "app-db", uuid: "db-uuid" }], success: true })
      if (url.endsWith("/d1/database/db-uuid/export")) {
        polls++
        return Response.json({ result: polls === 1 ? { at_bookmark: "bookmark-1", status: "active" } : { result: { signed_url: "https://r2.example.com/dump.sql?sig=signed" }, status: "complete" }, success: true })
      }
      if (url.startsWith("https://r2.example.com/")) return new Response("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE notes (id INTEGER);\n")
      return new Response("not found", { status: 404 })
    })
    const env = { CLOUDFLARE_ACCOUNT_ID: "account-1", CLOUDFLARE_API_TOKEN: "cf-secret-token" }

    // A native D1 binding reads the local file without --remote.
    await expect(project.run([], { env, fetch: request as typeof fetch })).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("The local SQLite file does not exist") })
    expect(request).not.toHaveBeenCalled()

    const result = await project.run(["--remote", "--output", "d1.sql"], { env, fetch: request as typeof fetch })
    expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: "[vitehub] Database \"default\" (Cloudflare D1 \"app-db\"): exported to d1.sql.\n" })
    await expect(readFile(join(project.rootDir, "d1.sql"), "utf8")).resolves.toBe("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE notes (id INTEGER);\n")
    expect(calls.map(call => call.url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account-1/d1/database?name=app-db",
      "https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/db-uuid/export",
      "https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/db-uuid/export",
      "https://r2.example.com/dump.sql?sig=signed",
    ])
    expect(calls[1]!.body).toMatchObject({ output_format: "polling" })
    expect(calls[2]!.body).toMatchObject({ current_bookmark: "bookmark-1", output_format: "polling" })
    expect(calls[1]!.auth).toBe("Bearer cf-secret-token")
    expect(calls[3]!.auth).toBeUndefined()
    expect(result.stdout).not.toMatch(/secret|sig=/)
  }, 10_000)

  it("names the missing Cloudflare credentials and reports API errors without the token", async () => {
    const project = await createProject({ default: { cloudflare: { binding: "DB", databaseId: "db-uuid", migrationsDir: "migrations" } } })
    const missing = await project.run(["--remote"], { env: { CLOUDFLARE_API_TOKEN: "cf-secret-token" } })
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("needs `CLOUDFLARE_ACCOUNT_ID`.")

    const request = vi.fn(async () => Response.json({ errors: [{ message: "Authentication error" }], success: false }, { status: 403 }))
    const denied = await project.run(["--remote"], { env: { CLOUDFLARE_ACCOUNT_ID: "account-1", CLOUDFLARE_API_TOKEN: "cf-secret-token" }, fetch: request as typeof fetch })
    expect(denied.exitCode).toBe(1)
    expect(denied.stderr).toContain("The Cloudflare API returned HTTP 403: Authentication error.")
    expect(denied.stderr).not.toContain("cf-secret-token")
    await expect(readdir(join(project.rootDir, ".vitehub/exports/database"))).resolves.toEqual([])
  })

  it.each([{}, { status: "active" }, { at_bookmark: "", status: "active" }])("rejects a D1 continuation without a bookmark: %j", async (poll) => {
    const project = await createProject({ default: { cloudflare: { binding: "DB", databaseId: "db-uuid", migrationsDir: "migrations" } } })
    const request = vi.fn(async () => {
      if (request.mock.calls.length > 1) throw new Error("Malformed polling continued")
      return Response.json({ result: poll, success: true })
    })
    const result = await project.run(["--remote", "--output", "d1.sql"], { env: { CLOUDFLARE_ACCOUNT_ID: "account-1", CLOUDFLARE_API_TOKEN: "token" }, fetch: request as typeof fetch })
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Cloudflare D1 export returned a continuation without a bookmark") })
    expect(result.stderr).toContain("DATABASE_EXPORT_FAILED")
    expect(request).toHaveBeenCalledTimes(1)
    await expect(readdir(project.rootDir)).resolves.toEqual([])
  })

  it("stops D1 polling when the export never completes", async () => {
    const project = await createProject({ default: { cloudflare: { binding: "DB", databaseId: "db-uuid", migrationsDir: "migrations" } } })
    const request = vi.fn(async () => {
      if (request.mock.calls.length > 600) throw new Error("Polling exceeded the limit")
      return Response.json({ result: { at_bookmark: "bookmark", status: "active" }, success: true })
    })
    const result = await project.run(["--remote", "--output", "d1.sql"], { env: { CLOUDFLARE_ACCOUNT_ID: "account-1", CLOUDFLARE_API_TOKEN: "token" }, fetch: request as typeof fetch })
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Cloudflare D1 export did not complete after 600 polls") })
    expect(result.stderr).toContain("DATABASE_EXPORT_FAILED")
    expect(request).toHaveBeenCalledTimes(600)
    await expect(readdir(project.rootDir)).resolves.toEqual([])
  })

  it("dumps D1 through an object-form cloudflare.http proxy", async () => {
    const project = await createProject({ default: { cloudflare: { binding: "DB", http: { authToken: "proxy-secret", url: "https://proxy.example.com/raw" }, migrationsDir: "migrations" } } })
    const source = join(project.rootDir, "proxy.db")
    await seedDatabase(source)
    const client = createClient({ url: `file:${source}` })
    await client.executeMultiple(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1202)
      INSERT INTO tags SELECT 'tag ' || i, 1 FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1202)
      INSERT INTO search (rowid, title) SELECT 42 + i, 'searchable ' || i FROM n;
    `)
    // The mocked proxy answers like the D1 raw endpoint: rows as arrays.
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { sql } = JSON.parse(String(init!.body)) as { sql: string }
      const result = await client.execute(sql)
      if (result.rows.length > 500) throw new Error("Proxy query response exceeds the row limit")
      const rows = result.rows.map(row => Array.from(result.columns, (_, index) => row[index]))
      return Response.json({ result: [{ results: { columns: [], rows }, success: true }], success: true })
    })
    const result = await project.run(["--remote", "--output", "proxy.sql"], { fetch: request as typeof fetch })
    client.close()
    expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: "[vitehub] Database \"default\" (D1 HTTP proxy https://proxy.example.com/raw): exported to proxy.sql.\n" })

    const restored = createClient({ url: `file:${join(project.rootDir, "restored.db")}` })
    await restored.executeMultiple(`BEGIN;\n${await readFile(join(project.rootDir, "proxy.sql"), "utf8")}COMMIT;`)
    restored.close()
    expect(await readAll(`file:${join(project.rootDir, "restored.db")}`)).toEqual(await readAll(`file:${source}`))
  })

  it("exports Postgres with pg_dump and keeps the password out of its arguments", async () => {
    const project = await createProject({ default: { connection: { url: "postgres://app:p%40ss@db.example.com:5432/app?sslmode=require" }, dialect: "postgresql" } })
    const spawn = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args[args.indexOf("--file") + 1]!, "-- PostgreSQL database dump\n")
      return { exitCode: 0 }
    })
    const result = await project.run(["--remote", "--output", "pg.sql"], { spawn })
    expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: "[vitehub] Database \"default\" (Postgres postgres://db.example.com:5432/app): exported to pg.sql.\n" })
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(command).toBe("pg_dump")
    expect(args).toEqual(["--no-owner", "--no-privileges", "--file", expect.stringContaining(join(project.rootDir, ".pg.sql.partial-")), "--dbname", "postgres://app@db.example.com:5432/app?sslmode=require"])
    expect(options.env.PGPASSWORD).toBe("p@ss")
    await expect(readFile(join(project.rootDir, "pg.sql"), "utf8")).resolves.toBe("-- PostgreSQL database dump\n")

    const absent = vi.fn(async () => { throw Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" }) })
    const failed = await project.run(["--remote", "--output", "pg2.sql"], { spawn: absent })
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("ViteHub exports Postgres with `pg_dump`, which is not on PATH.")
    expect(existsSync(join(project.rootDir, "pg2.sql"))).toBe(false)
  })
})
