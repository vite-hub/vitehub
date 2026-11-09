import { describe, expect, it } from "vitest"

import { databaseDurability } from "../src/durability.ts"

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
