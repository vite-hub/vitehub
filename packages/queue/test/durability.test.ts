import { describe, expect, it } from "vitest"

import { queueDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

describe("queueDurability", () => {
  it("names the hosted provider in the reason", () => {
    expect(queueDurability({ driver: "vercel" }, context())).toMatchObject([{ scope: "shared", reason: expect.stringContaining("Vercel") }])
    expect(queueDurability({ driver: "cloudflare" }, context())).toMatchObject([{ scope: "shared", reason: expect.stringContaining("Cloudflare") }])
  })

  it("reports local job files as host state", () => {
    expect(queueDurability({ base: ".vitehub/data/queue", driver: "local" }, context())).toMatchObject([{ store: "local", scope: "host" }])
  })

  it("reports the postgres provider from QUEUE_POSTGRES_URL or the Default Database", () => {
    expect(queueDurability({ driver: "postgres" }, context({ QUEUE_POSTGRES_URL: "postgres://db/jobs" }))).toMatchObject([{ store: "postgres", scope: "shared", reason: expect.stringContaining("QUEUE_POSTGRES_URL") }])
    const database: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }
    expect(queueDurability({ database: "default", driver: "postgres" }, context({}, [database]))).toMatchObject([{ store: "postgres", scope: "shared", reason: expect.stringContaining("Database") }])
    expect(queueDurability({ driver: "postgres" }, context())).toMatchObject([{ scope: "process" }])
  })
})
