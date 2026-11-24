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
  user.run("guest-old", "Old guest", "guest-6f1c9a52-0d7e-4c6b-9a8f-1b2c3d4e5f60@guests.invalid", 0, "guest,comments-read")
  user.run("guest-new", "New guest", "guest-0b7f2d4e-8a1c-4e3f-9b6d-2c5a7e9f1d30@guests.invalid", 0, "guest,console")
  session.run("s-admin", "t1", "admin")
  session.run("s-plain", "t2", "plain")
  session.run("s-guest-old", "t3", "guest-old")
  session.run("s-guest-new", "t4", "guest-new")
  account.run("a-admin", "gh-1", "github", "admin")
  account.run("a-plain", "plain", "credential", "plain")
  account.run("a-guest-new", "guest-new", "vitehub-site-guest", "guest-new")
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
    { id: "member", role: null },
    { id: "own-roles", role: "user,consoleadmin,comments" },
    { id: "plain", role: null },
    { id: "spaced", role: "admin" },
    { id: "writer", role: "user" },
  ],
  sessions: ["s-admin", "s-plain"],
  accounts: ["a-admin", "a-plain"],
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

  it("drops the usage tables and triggers of both index versions, and the journal keeps working", () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`CREATE TABLE "vitehub_agent_invocations" ("id" TEXT PRIMARY KEY, "status" TEXT, "record" TEXT NOT NULL)`)
    for (const table of ["vitehub_console_usage", "vitehub_console_usage_v2"]) {
      db.exec(`
        CREATE TABLE ${table} ("id" TEXT NOT NULL, "model_key" TEXT NOT NULL, "agent" TEXT NOT NULL, "at" TEXT NOT NULL, PRIMARY KEY ("id", "model_key"));
        CREATE INDEX ${table}_at ON ${table}("model_key", "at" DESC, "id" DESC);
        CREATE INDEX ${table}_agent_at ON ${table}("model_key", "agent", "at" DESC, "id" DESC);
        CREATE TABLE ${table}_dirty ("id" TEXT PRIMARY KEY, "generation" INTEGER NOT NULL DEFAULT 1);
        CREATE TRIGGER ${table}_insert AFTER INSERT ON "vitehub_agent_invocations" BEGIN INSERT INTO ${table}_dirty("id") VALUES (NEW."id") ON CONFLICT("id") DO UPDATE SET "generation" = "generation" + 1; END;
        CREATE TRIGGER ${table}_update AFTER UPDATE ON "vitehub_agent_invocations" BEGIN INSERT INTO ${table}_dirty("id") VALUES (NEW."id") ON CONFLICT("id") DO UPDATE SET "generation" = "generation" + 1; END;
        CREATE TRIGGER ${table}_delete AFTER DELETE ON "vitehub_agent_invocations" BEGIN DELETE FROM ${table} WHERE "id" = OLD."id"; DELETE FROM ${table}_dirty WHERE "id" = OLD."id"; END;
      `)
    }
    db.exec(`INSERT INTO "vitehub_agent_invocations" VALUES ('run-1', 'completed', '{}')`)
    expect(db.prepare(`SELECT count(*) AS count FROM "vitehub_console_usage_v2_dirty"`).get()).toEqual({ count: 1 })
    db.exec(usageSql)
    db.exec(usageSql)
    expect(db.prepare(`SELECT "type", "name" FROM "sqlite_master" WHERE "name" LIKE 'vitehub_console_usage%'`).all()).toEqual([])
    db.exec(`INSERT INTO "vitehub_agent_invocations" VALUES ('run-2', 'running', '{}'); UPDATE "vitehub_agent_invocations" SET "status" = 'completed' WHERE "id" = 'run-2'; DELETE FROM "vitehub_agent_invocations" WHERE "id" = 'run-1'`)
    expect(db.prepare(`SELECT "id", "status" FROM "vitehub_agent_invocations"`).all()).toEqual([{ id: "run-2", status: "completed" }])
  })
})
