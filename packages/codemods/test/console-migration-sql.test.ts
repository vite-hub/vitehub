import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const page = readFileSync(fileURLToPath(new URL("../../../docs/content/docs/console/migrate.md", import.meta.url)), "utf8")

function sqlBlock(file: string, after = ""): string {
  const from = after ? page.indexOf(after) : 0
  const match = new RegExp(`\`\`\`sql \\[${file.replaceAll(".", "\\.")}\\]\\n([\\s\\S]*?)\`\`\``).exec(page.slice(from))
  if (from < 0 || !match?.[1]) throw new Error(`migrate.md has no ${file} block after ${after || "the start"}`)
  return match[1]
}

const siteAccessSql = sqlBlock("site-access-cleanup.sql", ":::tabs-item{label=\"SQLite and D1\"}")
const usageSql = sqlBlock("drop-console-usage.sql")

function appDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "user" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE, "email_verified" INTEGER NOT NULL, "role" TEXT);
    CREATE TABLE "session" ("id" TEXT PRIMARY KEY, "token" TEXT NOT NULL, "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE);
    CREATE TABLE "account" ("id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL, "provider_id" TEXT NOT NULL, "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE);
    CREATE TABLE "vitehub_console_site" ("namespace" TEXT NOT NULL, "key" TEXT NOT NULL, "value" TEXT NOT NULL, "expires_at" INTEGER, PRIMARY KEY ("namespace", "key"));
    INSERT INTO "vitehub_console_site" VALUES ('site', 'invite:1', '{}', NULL);
  `)
  const user = db.prepare(`INSERT INTO "user" VALUES (?, ?, ?, ?, ?)`)
  const session = db.prepare(`INSERT INTO "session" VALUES (?, ?, ?)`)
  const account = db.prepare(`INSERT INTO "account" VALUES (?, ?, ?, ?)`)
  user.run("admin", "Ada", "ada@example.com", 1, "admin,console,comments-read")
  user.run("writer", "Bo", "bo@example.com", 1, "user,comments-write,comments-resolve")
  user.run("member", "Cy", "cy@example.com", 1, "console,comments-delete")
  user.run("spaced", "Di", "di@example.com", 1, "admin, console")
  user.run("own-roles", "Ed", "ed@example.com", 1, "user,consoleadmin,comments")
  user.run("plain", "Flo", "guest-like@example.com", 0, null)
  user.run("customer", "Gus", "guest-customer@guests.invalid", 1, "user")
  user.run("regional", "Hal", "hal@example.com", 1, "regional manager, console")
  user.run("lookalike", "Ivo", "guest-customer-0001-0002-0003-000000000004@guests.invalid", 1, "user")
  user.run("super", "Jo", "jo@example.com", 1, "super admin,  console")
  user.run("padded", "Kim", "kim@example.com", 1, " console ")
  user.run("twice", "Lu", "lu@example.com", 1, "console,console")
  user.run("padded-admin", "Max", "max@example.com", 1, "user,  admin, console")
  user.run("tabbed", "Nia", "nia@example.com", 1, "user,\tconsole\t")
  user.run("uuid-v1", "Oli", "guest-6ba7b810-9dad-11d1-80b4-00c04fd430c8@guests.invalid", 1, "user")
  user.run("uuid-v4", "Pat", "guest-3f2c1e9a-7b4d-4c8e-9f1a-2b3c4d5e6f70@guests.invalid", 1, "user")
  user.run("guest-old", "Old guest", "guest-6f1c9a52-0d7e-4c6b-9a8f-1b2c3d4e5f60@guests.invalid", 0, "guest,comments-read")
  user.run("guest-new", "New guest", "guest-0b7f2d4e-8a1c-4e3f-9b6d-2c5a7e9f1d30@guests.invalid", 0, "guest,console")
  session.run("s-admin", "t1", "admin")
  session.run("s-plain", "t2", "plain")
  session.run("s-customer", "t5", "customer")
  session.run("s-uuid-v1", "t6", "uuid-v1")
  session.run("s-uuid-v4", "t7", "uuid-v4")
  session.run("s-guest-old", "t3", "guest-old")
  session.run("s-guest-new", "t4", "guest-new")
  account.run("a-admin", "gh-1", "github", "admin")
  account.run("a-plain", "plain", "credential", "plain")
  account.run("a-customer", "customer", "credential", "customer")
  account.run("a-guest-new", "guest-new", "vitehub-site-guest", "guest-new")
  account.run("a-guest-old", "guest-old", "vitehub-site-guest", "guest-old")
  account.run("a-uuid-v1", "uuid-v1", "credential", "uuid-v1")
  account.run("a-uuid-v4", "uuid-v4", "credential", "uuid-v4")
  return db
}

function snapshot(db: DatabaseSync) {
  return {
    users: db.prepare(`SELECT "id", "role" FROM "user" ORDER BY "id"`).all(),
    sessions: db.prepare(`SELECT "id" FROM "session" ORDER BY "id"`).all().map(row => row.id),
    accounts: db.prepare(`SELECT "id" FROM "account" ORDER BY "id"`).all().map(row => row.id),
    tables: db.prepare(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name"`).all().map(row => row.name),
  }
}

const expected = {
  users: [
    { id: "admin", role: "admin" },
    { id: "customer", role: "user" },
    { id: "lookalike", role: "user" },
    { id: "member", role: null },
    { id: "own-roles", role: "user,consoleadmin,comments" },
    { id: "padded", role: null },
    { id: "padded-admin", role: "user,  admin" },
    { id: "plain", role: null },
    { id: "regional", role: "regional manager" },
    { id: "spaced", role: "admin" },
    { id: "super", role: "super admin" },
    { id: "tabbed", role: "user" },
    { id: "twice", role: null },
    { id: "uuid-v1", role: "user" },
    { id: "uuid-v4", role: "user" },
    { id: "writer", role: "user" },
  ],
  sessions: ["s-admin", "s-customer", "s-plain", "s-uuid-v1", "s-uuid-v4"],
  accounts: ["a-admin", "a-customer", "a-plain", "a-uuid-v1", "a-uuid-v4"],
  tables: ["account", "session", "user"],
}

describe("Console migration SQL on SQLite", () => {
  it("drops vitehub_console_site, deletes the Site access guests with their sessions and accounts, and keeps the other roles of members", () => {
    const db = appDatabase()
    db.exec(siteAccessSql)
    expect(snapshot(db)).toEqual(expected)
    db.exec(siteAccessSql)
    expect(snapshot(db)).toEqual(expected)
  })

  it("deletes the guests also when the database does not enforce foreign keys", () => {
    const db = appDatabase()
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec(siteAccessSql)
    expect(snapshot(db)).toEqual(expected)
  })

  it("drops the usage tables and triggers, and the journal keeps working", () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`CREATE TABLE "vitehub_agent_invocations" ("id" TEXT PRIMARY KEY, "status" TEXT, "record" TEXT NOT NULL)`)
    const table = "vitehub_console_usage_v2"
    expect([...usageSql.matchAll(/"(vitehub_console_usage[^"]*)"/g)].map(match => match[1])).toEqual([`${table}_insert`, `${table}_update`, `${table}_delete`, table, `${table}_dirty`])
    db.exec(`
      CREATE TABLE ${table} ("id" TEXT NOT NULL, "model_key" TEXT NOT NULL, "agent" TEXT NOT NULL, "at" TEXT NOT NULL, PRIMARY KEY ("id", "model_key"));
      CREATE INDEX ${table}_at ON ${table}("model_key", "at" DESC, "id" DESC);
      CREATE INDEX ${table}_agent_at ON ${table}("model_key", "agent", "at" DESC, "id" DESC);
      CREATE TABLE ${table}_dirty ("id" TEXT PRIMARY KEY, "generation" INTEGER NOT NULL DEFAULT 1);
      CREATE TRIGGER ${table}_insert AFTER INSERT ON "vitehub_agent_invocations" BEGIN INSERT INTO ${table}_dirty("id") VALUES (NEW."id") ON CONFLICT("id") DO UPDATE SET "generation" = "generation" + 1; END;
      CREATE TRIGGER ${table}_update AFTER UPDATE ON "vitehub_agent_invocations" BEGIN INSERT INTO ${table}_dirty("id") VALUES (NEW."id") ON CONFLICT("id") DO UPDATE SET "generation" = "generation" + 1; END;
      CREATE TRIGGER ${table}_delete AFTER DELETE ON "vitehub_agent_invocations" BEGIN DELETE FROM ${table} WHERE "id" = OLD."id"; DELETE FROM ${table}_dirty WHERE "id" = OLD."id"; END;
    `)
    db.exec(`INSERT INTO "vitehub_agent_invocations" VALUES ('run-1', 'completed', '{}')`)
    expect(db.prepare(`SELECT count(*) AS count FROM "vitehub_console_usage_v2_dirty"`).get()).toEqual({ count: 1 })
    db.exec(usageSql)
    db.exec(usageSql)
    expect(db.prepare(`SELECT "type", "name" FROM "sqlite_master" WHERE "name" LIKE 'vitehub_console_usage%'`).all()).toEqual([])
    db.exec(`INSERT INTO "vitehub_agent_invocations" VALUES ('run-2', 'running', '{}'); UPDATE "vitehub_agent_invocations" SET "status" = 'completed' WHERE "id" = 'run-2'; DELETE FROM "vitehub_agent_invocations" WHERE "id" = 'run-1'`)
    expect(db.prepare(`SELECT "id", "status" FROM "vitehub_agent_invocations"`).all()).toEqual([{ id: "run-2", status: "completed" }])
  })
})
