import { describe, expect, it } from "vitest"

import { realtimeDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }

describe("realtimeDurability", () => {
  it("keeps an explicit driver", () => {
    expect(realtimeDurability({ driver: "cloudflare" }, context())).toMatchObject([{ store: "cloudflare", scope: "shared" }])
    expect(realtimeDurability({ driver: "redis" }, context())).toMatchObject([{ store: "redis", scope: "shared" }])
    expect(realtimeDurability({ driver: "postgres" }, context())).toMatchObject([{ store: "postgres", scope: "shared" }])
    expect(realtimeDurability({ driver: "memory" }, context({ REDIS_URL: "redis://cache" }))).toMatchObject([{ store: "memory", scope: "process" }])
  })

  it.each(["auto", "node"])("picks the %s driver at boot", (driver) => {
    expect(realtimeDurability({ driver }, context({ REDIS_URL: "redis://cache", REALTIME_POSTGRES_URL: "postgres://db" }, [postgres]))).toMatchObject([{ store: "redis", reason: expect.stringContaining("REDIS_URL") }])
    expect(realtimeDurability({ driver }, context({ REALTIME_POSTGRES_URL: "postgres://db" }))).toMatchObject([{ store: "postgres", reason: expect.stringContaining("REALTIME_POSTGRES_URL") }])
    expect(realtimeDurability({ driver }, context({}, [postgres]))).toMatchObject([{ store: "postgres", reason: expect.stringContaining("Default Database") }])
    expect(realtimeDurability({ driver }, context({}, [{ ...postgres, store: "sqlite", scope: "host" }]))).toMatchObject([{ store: "memory", scope: "process" }])
  })
})
