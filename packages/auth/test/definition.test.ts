import { describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"

describe("defineAuth", () => {
  it("creates an Auth Definition with ViteHub placement metadata", () => {
    expect(defineAuth({
      appName: "ViteHub",
      basePath: "/auth",
      database: { dedicated: true, name: "auth" },
      route: false,
      secondaryStorage: { store: "auth" },
    })).toEqual({
      options: {
        appName: "ViteHub",
        basePath: "/auth",
        database: { dedicated: true, name: "auth" },
        route: false,
        secondaryStorage: { store: "auth" },
      },
    })
  })

  it("defaults database placement when the definition does not specify one", () => {
    expect(defineAuth({ appName: "ViteHub" })).toEqual({
      options: { appName: "ViteHub" },
    })
  })

  it("rejects runtime-only Better Auth fields", () => {
    expect(() => defineAuth({ baseURL: "https://example.com" } as never)).toThrow(/resolved at runtime/)
    expect(() => defineAuth({ secret: "secret" } as never)).toThrow(/resolved at runtime/)
    expect(() => defineAuth({ secrets: [{ value: "secret", version: 1 }] } as never)).toThrow(/resolved at runtime/)
  })

  it("rejects unsupported route, database, and secondary storage shapes", () => {
    expect(() => defineAuth({ route: true } as never)).toThrow(/route can only be `false`/)
    expect(() => defineAuth({ basePath: "api/auth" } as never)).toThrow(/basePath must start/)
    expect(() => defineAuth({ database: false } as never)).toThrow(/database must be `true`/)
    expect(() => defineAuth({ database: { dedicated: true } } as never)).toThrow(/database.name/)
    expect(() => defineAuth({ database: { name: "auth", url: "file:auth.db" } } as never)).toThrow(/database does not support/)
    expect(() => defineAuth({ secondaryStorage: false } as never)).toThrow(/secondaryStorage must be `true`/)
    expect(() => defineAuth({ secondaryStorage: {} } as never)).toThrow(/secondaryStorage.store/)
    expect(() => defineAuth({ secondaryStorage: { driver: "kv" } } as never)).toThrow(/secondaryStorage does not support/)
  })
})
