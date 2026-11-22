import { describe, expect, it } from "vitest"

import { scheduleDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

describe("scheduleDurability", () => {
  it("reports process claims without leases", () => {
    expect(scheduleDurability({ driver: "process" }, context({}, [{ primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }]))).toMatchObject([{ store: "process", scope: "process" }])
  })

  it("is shared only with SQL leases on a Postgres or remote libSQL Default Database", () => {
    expect(scheduleDurability({ driver: "process", leases: true }, context({}, [{ primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }]))).toMatchObject([{ store: "postgres", scope: "shared" }])
    expect(scheduleDurability({ driver: "process", leases: true }, context({}, [{ primitive: "database", store: "libsql", scope: "shared", reason: "A remote libSQL server." }]))).toMatchObject([{ store: "libsql", scope: "shared" }])
    expect(scheduleDurability({ driver: "process", leases: true }, context({}, [{ primitive: "database", store: "sqlite", scope: "host", reason: "A file." }]))).toMatchObject([{ scope: "process", reason: expect.stringContaining("sqlite") }])
    // Schedule reports shared leases for Postgres and remote libSQL only.
    expect(scheduleDurability({ driver: "process", leases: true }, context({}, [{ primitive: "database", store: "d1", scope: "shared", reason: "Cloudflare D1 over HTTP." }]))).toMatchObject([{ scope: "process", fix: expect.stringContaining("remote libSQL") }])
  })
})
