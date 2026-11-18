import { describe, expect, it } from "vitest"

import { createRuntimeEnvConfigValue, renderConfigValueExpression, resolveConfigValue } from "../src/config-value.ts"

describe("database config values", () => {
  it("falls through blank env values when resolving env-backed config", () => {
    const originalPrimary = process.env.VITEHUB_PRIMARY_DATABASE_URL
    const originalFallback = process.env.VITEHUB_FALLBACK_DATABASE_URL
    process.env.VITEHUB_PRIMARY_DATABASE_URL = ""
    process.env.VITEHUB_FALLBACK_DATABASE_URL = "libsql://fallback.example.turso.io"

    try {
      expect(resolveConfigValue(createRuntimeEnvConfigValue([
        "VITEHUB_PRIMARY_DATABASE_URL",
        "VITEHUB_FALLBACK_DATABASE_URL",
      ]))).toBe("libsql://fallback.example.turso.io")
    }
    finally {
      if (typeof originalPrimary === "undefined") delete process.env.VITEHUB_PRIMARY_DATABASE_URL
      else process.env.VITEHUB_PRIMARY_DATABASE_URL = originalPrimary
      if (typeof originalFallback === "undefined") delete process.env.VITEHUB_FALLBACK_DATABASE_URL
      else process.env.VITEHUB_FALLBACK_DATABASE_URL = originalFallback
    }
  })

  it("renders env-backed config with blank-value fallbacks", () => {
    const expression = renderConfigValueExpression(createRuntimeEnvConfigValue([
      "VITEHUB_PRIMARY_DATABASE_URL",
      "VITEHUB_FALLBACK_DATABASE_URL",
    ], "file:.vitehub/data/database/sqlite.db"))!
    // SAFETY: the expression reads only `process.env`, and the test passes a stand-in.
    const read = (env: Record<string, string>) => new Function("process", `return ${expression}`)({ env }) as string

    expect(read({ VITEHUB_PRIMARY_DATABASE_URL: "libsql://primary" })).toBe("libsql://primary")
    expect(read({ VITEHUB_FALLBACK_DATABASE_URL: "libsql://fallback", VITEHUB_PRIMARY_DATABASE_URL: "" })).toBe("libsql://fallback")
    expect(read({})).toBe("file:.vitehub/data/database/sqlite.db")
  })
})
