import { resolve } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { describe, expect, it } from "vitest"

const folder = resolve(import.meta.dirname, "../server/databases/default/migrations")

describe("Console migrations", () => {
  it("add the Comments tables and keep the users, sessions, and teams of an existing Console", async () => {
    const client = createClient({ url: ":memory:" })
    const db = drizzle({ client })
    await migrate(db, { migrationsFolder: folder })
    const tables = (await client.execute("select name from sqlite_master where type = 'table'")).rows.map(row => String(row.name))
    expect(tables).toEqual(expect.arrayContaining(["user", "session", "organization", "member", "console_projects", "vitehub_comment_threads", "vitehub_comment_messages", "vitehub_comment_counters", "vitehub_comment_forge"]))
    // The Comments migration only adds: it never rebuilds a table that sessions and memberships cascade from.
    const sql = await import("node:fs/promises").then(fs => fs.readFile(resolve(folder, "20261113093416_comments/migration.sql"), "utf8"))
    expect(sql).not.toMatch(/\b(?:DROP TABLE|ALTER TABLE|INSERT INTO)\b/)
  })
})
