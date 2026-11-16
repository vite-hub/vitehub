import { describe, expect, it } from "vitest"

import { databaseDurability, databaseDurabilityUrl } from "../src/durability.ts"

describe("databaseDurability", () => {
  it("tells local SQLite from shared stores", () => {
    const reports = databaseDurability({
      databases: [
        { dialect: "sqlite", name: "default", url: "file:.vitehub/data/database/sqlite.db" },
        { dialect: "sqlite", name: "events", url: { kind: "env-variable", source: { kind: "env", name: "EVENTS_URL" }, default: "file:events.db" } },
        { dialect: "sqlite", name: "cache", url: ":memory:" },
        { dialect: "postgresql", name: "billing" },
        { dialect: "sqlite", http: true, name: "edge" },
      ],
    }, { env: { EVENTS_URL: "libsql://events.turso.io" }, find: () => undefined })
    expect(reports).toMatchObject([
      { primitive: "database", store: "sqlite", scope: "host", reason: "The SQLite file .vitehub/data/database/sqlite.db on this host." },
      { name: "events", store: "libsql", scope: "shared" },
      { name: "cache", store: "sqlite", scope: "process" },
      { name: "billing", store: "postgres", scope: "shared" },
      { name: "edge", store: "d1", scope: "shared" },
    ])
    expect(reports[0]).not.toHaveProperty("name")
    expect(reports[0]!.fix).toContain("remote libSQL URL")
  })
})

describe("databaseDurabilityUrl", () => {
  it("keeps env names and local files, and hides remote URLs before the build writes them", () => {
    const declaration = { kind: "env-variable" as const, source: { kind: "env" as const, name: "TURSO_URL" }, default: "libsql://app.turso.io?authToken=secret" }
    expect(databaseDurabilityUrl("libsql://app.turso.io?authToken=secret")).toBe("remote")
    expect(databaseDurabilityUrl("file:.vitehub/data/database/sqlite.db")).toBe("file:.vitehub/data/database/sqlite.db")
    expect(databaseDurabilityUrl(declaration)).toEqual({ ...declaration, default: "remote" })
    expect(JSON.stringify(databaseDurabilityUrl(declaration))).not.toContain("secret")
  })

  it("still classifies the redacted values", () => {
    const url = databaseDurabilityUrl({ kind: "env-variable", source: { kind: "env", name: "TURSO_URL" }, default: "libsql://app.turso.io" })
    const context = (env: Record<string, string | undefined>) => ({ env, find: () => undefined })
    expect(databaseDurability({ databases: [{ dialect: "sqlite", name: "default", url }] }, context({}))).toMatchObject([{ store: "libsql", scope: "shared" }])
    expect(databaseDurability({ databases: [{ dialect: "sqlite", name: "default", url }] }, context({ TURSO_URL: "file:local.db" }))).toMatchObject([{ store: "sqlite", scope: "host" }])
  })

  it("keeps a local URL with a case-insensitive scheme, including an Env default", () => {
    for (const value of ["FILE:instance.db", { kind: "env-variable" as const, source: { kind: "env" as const, name: "DATABASE_URL" }, default: "FiLe:instance.db" }]) {
      const url = databaseDurabilityUrl(value)
      expect(databaseDurability({ databases: [{ dialect: "sqlite", name: "default", url }] }, { env: {}, find: () => undefined })).toMatchObject([{ scope: "host" }])
    }
  })
})
