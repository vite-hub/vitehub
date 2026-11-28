import { apiKey } from "@better-auth/api-key"
import { twoFactor, username } from "better-auth/plugins"
import { describe, expect, it, vi } from "vitest"

import { authDatabase } from "../src/database.ts"
import { authSqliteRelations, authSqliteSchema, createAuthRelations, createAuthSqliteSchema } from "../src/schema.ts"

const state = vi.hoisted(() => ({ databases: {} as Record<string, { db: unknown, schema: Record<string, unknown> }> }))
vi.mock("@vite-hub/database/runtime/registry", () => ({ databases: state.databases }))

// The adapter opens no connection until Better Auth queries it.
const db = {}

describe("owned Database adapter validation", () => {
  it("rejects schema mappings before looking up the Database", () => {
    expect(() => authDatabase()({ user: { modelName: "users" } })).toThrow(/user.modelName/)
    expect(() => authDatabase()({ session: { fields: { token: "session_token" } } })).toThrow(/session.token cannot map/)
  })

  it("still reports missing tables for compatible options", () => {
    expect(() => authDatabase("missing")({})).toThrow(/found no Better Auth tables/)
  })

  it("opens a Database whose tables have the plugins and additional fields of the options", () => {
    state.databases.extended = { db, schema: { ...createAuthSqliteSchema({ plugins: ["apiKey", "twoFactor"], additionalFields: { user: { login: { type: "string" } } } }) } }
    const options = { plugins: [apiKey(), twoFactor()], user: { additionalFields: { login: { type: "string" as const, required: false } } } }
    expect(authDatabase("extended")(options)).toMatchObject({ id: "drizzle" })
  })

  it.each([
    [{ user: { additionalFields: { tenant: { type: "string" as const } } } }, /`user` table of the "plain" Database has no `tenant` column/],
    [{ session: { additionalFields: { device: { type: "string" as const } } } }, /`session` table of the "plain" Database has no `device` column/],
    [{ plugins: [username()] }, /`user` table of the "plain" Database has no `username` column/],
    [{ plugins: [apiKey()] }, /the "plain" Database has no `apikey` table/],
  ])("names the table or column that the Database lacks: %#", (options, message) => {
    state.databases.plain = { db, schema: { ...authSqliteSchema } }
    expect(() => authDatabase("plain")(options)).toThrow(expect.objectContaining({ code: "AUTH_C0056", message: expect.stringMatching(message) }))
  })

  it("rejects advanced.database.joins when required Auth relations are missing or collide with a column", () => {
    state.databases.noRelations = { db: { _: { relations: {} } }, schema: { ...authSqliteSchema } }
    expect(() => authDatabase("noRelations")({ advanced: { database: { joins: true } } })).toThrow(expect.objectContaining({
      code: "AUTH_C0056",
      message: expect.stringMatching(/has no `user` relation for `advanced.database.joins`/),
    }))

    state.databases.withRelations = { db: { _: { relations: authSqliteRelations } }, schema: { ...authSqliteSchema } }
    expect(authDatabase("withRelations")({ advanced: { database: { joins: true } } })).toMatchObject({ id: "drizzle" })

    const extraRefOptions = { additionalFields: { verification: { ownerId: { type: "string" as const, references: { model: "user", field: "id" } } } } }
    const extraRefSchema = createAuthSqliteSchema(extraRefOptions)
    const extraRefRelations = createAuthRelations(extraRefSchema, extraRefOptions)
    state.databases.extraRef = { db: { _: { relations: extraRefRelations } }, schema: { ...extraRefSchema } }
    expect(authDatabase("extraRef")({
      advanced: { database: { joins: true } },
      verification: { additionalFields: { ownerId: { type: "string", required: false, references: { model: "user", field: "id" } } } },
    })).toMatchObject({ id: "drizzle" })

    const collidingOptions = { additionalFields: { user: { accounts: { type: "string" as const } } } }
    const collidingSchema = createAuthSqliteSchema(collidingOptions)
    const collidingRelations = createAuthRelations(collidingSchema, collidingOptions)
    state.databases.colliding = { db: { _: { relations: collidingRelations } }, schema: { ...collidingSchema } }
    expect(() => authDatabase("colliding")({
      advanced: { database: { joins: true } },
      user: { additionalFields: { accounts: { type: "string", required: false } } },
    })).toThrow(expect.objectContaining({
      code: "AUTH_C0056",
      message: expect.stringMatching(/`user` table of the "colliding" Database has no `accounts` relation for `advanced.database.joins`, because its `accounts` column collides/),
    }))
  })
})
