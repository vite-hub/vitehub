import { apiKey } from "@better-auth/api-key"
import { twoFactor, username } from "better-auth/plugins"
import { describe, expect, it, vi } from "vitest"

import { authDatabase } from "../src/database.ts"
import { authSqliteSchema, createAuthSqliteSchema } from "../src/schema.ts"

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
})
