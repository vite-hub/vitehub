import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it, vi } from "vitest"

import { createDbTools } from "../src/agent.ts"

const notesTable = sqliteTable("notes", {
  title: text("title"),
})

const eventsTable = sqliteTable("events", {
  name: text("name"),
})

describe("createDbTools", () => {
  it("gates tools by access level", () => {
    expect(Object.keys(createDbTools({ access: "read" })).sort()).toEqual([
      "db_list_tables",
      "db_read_sql",
      "db_select",
    ])
    expect(createDbTools({ access: "write", database: "default", databases: {} })).toHaveProperty("db_insert")
    expect(createDbTools({ access: "write", database: "default", databases: {} })).not.toHaveProperty("db_run_schema_sql")
    expect(createDbTools({ access: "schema", database: "default", databases: {} })).toHaveProperty("db_run_schema_sql")
    expect(createDbTools({ access: "schema", database: "default", databases: {} }).db_run_schema_sql.policy).toBe("require-approval")
  })

  it("uses the default database when no database map is provided", () => {
    const tools = createDbTools({ access: "read" })

    expect(Object.keys(tools).sort()).toEqual([
      "db_list_tables",
      "db_read_sql",
      "db_select",
    ])
  })

  it("infers the only configured database when database is omitted", async () => {
    const tools = createDbTools({
      databases: {
        analytics: { db: {}, schema: { events: eventsTable } },
      },
    })

    expect(Object.keys(tools).sort()).toEqual([
      "analytics_db_list_tables",
      "analytics_db_read_sql",
      "analytics_db_select",
    ])
    await expect(tools.analytics_db_list_tables.execute?.({})).resolves.toEqual({ database: "analytics", tables: ["events"] })
  })

  it("requires a database name when multiple databases are configured", () => {
    expect(() => createDbTools({
      databases: {
        analytics: { db: {}, schema: { events: eventsTable } },
        default: { db: {}, schema: { notes: notesTable } },
      },
    })).toThrow("requires a database name when multiple databases are configured")
  })

  it("scopes tools to the configured database", async () => {
    const tools = createDbTools({
      database: "analytics",
      databases: {
        analytics: { db: {}, schema: { events: eventsTable, helper: () => "not a table" } },
        default: { db: {}, schema: { notes: notesTable } },
      },
    })

    expect(Object.keys(tools).sort()).toEqual([
      "analytics_db_list_tables",
      "analytics_db_read_sql",
      "analytics_db_select",
    ])
    await expect(tools.analytics_db_list_tables.execute?.({})).resolves.toEqual({ database: "analytics", tables: ["events"] })
  })

  it("supports a custom tool prefix", () => {
    expect(createDbTools({ database: "analytics", databases: {}, prefix: "warehouse" })).toHaveProperty("warehouse_list_tables")
  })

  it("executes structured inserts through the selected Drizzle table", async () => {
    const returning = vi.fn(async () => [{ id: 1, title: "hello" }])
    const values = vi.fn(() => ({ returning }))
    const insert = vi.fn(() => ({ values }))
    const tools = createDbTools({
      access: "write",
      database: "default",
      databases: {
        default: {
          db: { insert },
          schema: { notes: notesTable },
        },
      },
    })

    await expect(tools.db_insert.execute?.({ table: "notes", values: { title: "hello" } })).resolves.toEqual([{ id: 1, title: "hello" }])
    expect(insert).toHaveBeenCalledWith(notesTable)
    expect(values).toHaveBeenCalledWith({ title: "hello" })
  })

  it("rejects missing databases and tables clearly", async () => {
    const tools = createDbTools({
      database: "default",
      databases: {
        default: { db: {}, schema: {} },
      },
    })

    await expect(tools.db_select.execute?.({ table: "missing" })).rejects.toThrow('Database table "missing" was not found')
    const missingTools = createDbTools({ database: "missing", databases: {} })
    await expect(missingTools.missing_db_list_tables.execute?.({})).rejects.toThrow('Database "missing" is not configured')
  })

  it("rejects write SQL through the read SQL tool", async () => {
    const all = vi.fn(async () => [])
    const tools = createDbTools({
      database: "default",
      databases: {
        default: { db: { all }, schema: {} },
      },
    })

    await expect(tools.db_read_sql.execute?.({ statement: "delete from notes" })).rejects.toThrow("only accepts SELECT")
    await expect(tools.db_read_sql.execute?.({ statement: "with deleted as (delete from notes returning *) select * from deleted" })).rejects.toThrow("only accepts SELECT")
    await expect(tools.db_read_sql.execute?.({ statement: "pragma writable_schema = 1" })).rejects.toThrow("only accepts SELECT")
    await expect(tools.db_read_sql.execute?.({ statement: "select 1; delete from notes" })).rejects.toThrow("only accepts SELECT")
    await expect(tools.db_read_sql.execute?.({ statement: "select ';' as value; -- trailing comment" })).resolves.toEqual([])
    expect(all).toHaveBeenCalledTimes(1)
  })
})
