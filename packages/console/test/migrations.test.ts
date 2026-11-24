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
    expect(tables).toEqual(expect.arrayContaining(["user", "session", "organization", "member", "console_projects", "vitehub_comment_threads", "vitehub_comment_messages", "vitehub_comment_counters", "vitehub_comment_forge", "console_api_keys", "device_code", "console_site_grants", "console_site_links", "console_mcp_connections", "console_mcp_clients"]))
    const sql = await import("node:fs/promises").then(fs => fs.readFile(resolve(folder, "20261113093416_comments/migration.sql"), "utf8"))
    expect(sql).not.toMatch(/\b(?:DROP TABLE|ALTER TABLE|INSERT INTO)\b/)
    const cli = await import("node:fs/promises").then(fs => fs.readFile(resolve(folder, "20261115091657_cli_auth/migration.sql"), "utf8"))
    expect(cli).not.toMatch(/\b(?:DROP TABLE|ALTER TABLE|INSERT INTO)\b/)
    const site = await import("node:fs/promises").then(fs => fs.readFile(resolve(folder, "20261123162439_site_access/migration.sql"), "utf8"))
    expect(site).not.toMatch(/\b(?:DROP TABLE|ALTER TABLE|INSERT INTO)\b/)
    const mcp = await import("node:fs/promises").then(fs => fs.readFile(resolve(folder, "20261123175540_mcp_client/migration.sql"), "utf8"))
    expect(mcp).not.toMatch(/\b(?:DROP TABLE|ALTER TABLE|INSERT INTO)\b/)
  })
})
