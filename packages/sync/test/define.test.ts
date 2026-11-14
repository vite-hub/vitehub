import { integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core"
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { defineSync } from "../src/index.ts"

const todos = sqliteTable("todos", { id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), title: text("title").notNull() })
const where = () => ({})

describe("defineSync", () => {
  it("returns the definition", () => {
    const definition = defineSync({ table: todos, where: ({ user }) => user ? { ownerId: user.id } : false })
    expect(definition["~sync"]).toBe(true)
    expect(definition.options.table).toBe(todos)
  })

  it.each([
    ["a Postgres table", pgTable("todos", { id: pgText("id").primaryKey() }), "SYNC_UNSUPPORTED_TABLE", "SQLite tables"],
    ["an integer key", sqliteTable("todos", { id: integer("id").primaryKey() }), "SYNC_UNSUPPORTED_TABLE", "not a text column"],
    ["a composite key", sqliteTable("todos", { a: text("a"), b: text("b") }, table => [primaryKey({ columns: [table.a, table.b] })]), "SYNC_UNSUPPORTED_TABLE", "composite primary key"],
    ["no key", sqliteTable("todos", { a: text("a") }), "SYNC_UNSUPPORTED_TABLE", "no primary key"],
    ["no table", { name: "todos" }, "SYNC_INVALID_DEFINITION", "Drizzle table"],
  ])("fails clearly for %s", (_, table, code, text) => {
    expect(() => defineSync({ table, where })).toThrow(expect.objectContaining({ code, message: expect.stringContaining(text), fix: expect.any(String) }))
  })

  it("checks where, write, schema, and database", () => {
    // @ts-expect-error `where` is required, so no table is public by mistake.
    expect(() => defineSync({ table: todos })).toThrow(expect.objectContaining({ code: "SYNC_INVALID_DEFINITION", message: expect.stringContaining("`where`") }))
    // @ts-expect-error `write` is a boolean or a function.
    expect(() => defineSync({ table: todos, where, write: "yes" })).toThrow("`write`")
    // @ts-expect-error `schema` is a Standard Schema.
    expect(() => defineSync({ table: todos, where, schema: {} })).toThrow("`schema`")
    expect(() => defineSync({ table: todos, where, database: "" })).toThrow("`database`")
    expect(() => defineSync({ table: pgTable("t", { id: pgInteger("id") }), where })).toThrow("Postgres")
    // @ts-expect-error `live` is a boolean.
    expect(() => defineSync({ table: todos, where, live: "yes" })).toThrow("`live`")
  })

  it("checks the subsets", () => {
    expect(defineSync({ table: todos, where, subsets: ["ownerId"] }).options.subsets).toEqual(["ownerId"])
    // @ts-expect-error `subsets` holds column names.
    expect(() => defineSync({ table: todos, where, subsets: ["color"] })).toThrow(expect.objectContaining({ code: "SYNC_INVALID_DEFINITION", message: expect.stringContaining("\"color\", which is not a column") }))
    expect(() => defineSync({ table: todos, where, subsets: ["id"] })).toThrow("cannot have the primary key")
    // @ts-expect-error `subsets` is an array.
    expect(() => defineSync({ table: todos, where, subsets: "ownerId" })).toThrow("`subsets` must be an array")
  })

  it("checks the actions", () => {
    const complete = ({ update }: { update: (key: string, patch: { title: string }) => void }, { id }: { id: string }) => update(id, { title: "done" })
    expect(defineSync({ table: todos, where, actions: { complete } }).options.actions).toEqual({ complete })
    // @ts-expect-error an action is a function.
    expect(() => defineSync({ table: todos, where, actions: { complete: true } })).toThrow(expect.objectContaining({ code: "SYNC_INVALID_DEFINITION", message: expect.stringContaining("`complete` must be a function") }))
    expect(() => defineSync({ table: todos, where, actions: { "mark-done": complete } })).toThrow("must start with a letter")
    expect(() => defineSync({ table: todos, where, actions: { _hidden: complete } })).toThrow("must start with a letter")
    expect(() => defineSync({ table: todos, where, actions: [complete] })).toThrow("`actions` must be an object")
  })
})
