import { describe, expect, it } from "vitest"

import { realtimeDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }

describe("realtimeDurability", () => {
  it("keeps an explicit authority", () => {
    expect(realtimeDurability({ authority: "cloudflare" }, context())).toMatchObject([{ store: "cloudflare", scope: "shared" }])
    expect(realtimeDurability({ authority: "redis" }, context())).toMatchObject([{ store: "redis", scope: "shared" }])
    expect(realtimeDurability({ authority: "postgres" }, context())).toMatchObject([{ store: "postgres", scope: "shared" }])
    expect(realtimeDurability({ authority: "memory" }, context({ REDIS_URL: "redis://cache" }))).toMatchObject([{ store: "memory", scope: "process" }])
  })

  it.each(["auto", "node"])("picks the %s authority at boot", (authority) => {
    expect(realtimeDurability({ authority }, context({ REDIS_URL: "redis://cache", REALTIME_POSTGRES_URL: "postgres://db" }, [postgres]))).toMatchObject([{ store: "redis", reason: expect.stringContaining("REDIS_URL") }])
    expect(realtimeDurability({ authority }, context({ REALTIME_POSTGRES_URL: "postgres://db" }))).toMatchObject([{ store: "postgres", reason: expect.stringContaining("REALTIME_POSTGRES_URL") }])
    expect(realtimeDurability({ authority }, context({}, [postgres]))).toMatchObject([{ store: "postgres", reason: expect.stringContaining("Default Database") }])
    expect(realtimeDurability({ authority }, context({}, [{ ...postgres, store: "sqlite", scope: "host" }]))).toMatchObject([{ store: "memory", scope: "process" }])
  })
})
