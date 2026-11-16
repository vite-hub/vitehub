import { username } from "better-auth/plugins"
import { describe, expect, it, vi } from "vitest"

import { authDatabase } from "../src/database.ts"

vi.mock("@vite-hub/database/runtime/registry", () => ({ databases: {} }))

describe("owned Database adapter validation", () => {
  it.each(["user", "session", "account", "verification"] as const)("rejects %s additional fields before looking up the Database", (model) => {
    expect(() => authDatabase()({ [model]: { additionalFields: { tenant: { type: "string" } } } })).toThrow(`${model}.additionalFields`)
  })

  it("rejects plugin columns before looking up the Database", () => {
    expect(() => authDatabase()({ plugins: [username()] })).toThrow(/user.username/)
  })

  it("rejects schema mappings before looking up the Database", () => {
    expect(() => authDatabase()({ user: { modelName: "users" } })).toThrow(/user.modelName/)
    expect(() => authDatabase()({ session: { fields: { token: "session_token" } } })).toThrow(/session.token cannot map/)
  })

  it("still reports missing tables for compatible options", () => {
    expect(() => authDatabase()({})).toThrow(/found no Better Auth tables/)
  })
})
