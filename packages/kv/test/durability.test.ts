import { describe, expect, it } from "vitest"

import { kvDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }
const sqliteFile: Durability = { primitive: "database", store: "sqlite", scope: "host", reason: "The SQLite file data.db on this host.", fix: "Use Postgres." }

describe("kvDurability", () => {
  it("classifies each store by its driver", () => {
    expect(kvDurability({ stores: {
      default: { base: ".vitehub/data/kv", driver: "fs-lite" },
      redis: { driver: "redis" },
      sessions: { driver: "upstash" },
    } }, context())).toMatchObject([
      { primitive: "kv", store: "fs-lite", scope: "host", reason: "Files in .vitehub/data/kv on this host." },
      { name: "redis", store: "redis", scope: "shared" },
      { name: "sessions", store: "upstash", scope: "shared" },
    ])
  })

  it("keeps the build-selected driver when REDIS_URL is present at boot", () => {
    const store = { base: ".vitehub/data/kv", driver: "fs-lite", inferred: true }
    expect(kvDurability({ stores: { default: store } }, context({ REDIS_URL: "redis://cache:6379" }))).toMatchObject([{ store: "fs-lite", scope: "host" }])
    expect(kvDurability({ stores: { default: store } }, context())[0]).toMatchObject({ scope: "host", fix: expect.stringContaining('driver: "redis"') })
    expect(kvDurability({ stores: { default: { driver: "fs-lite" } } }, context({ REDIS_URL: "redis://cache:6379" }))).toMatchObject([{ store: "fs-lite", scope: "host" }])
  })

  it("follows the Database of a database store", () => {
    const input = { stores: { default: { database: "default", driver: "database" } } }
    expect(kvDurability(input, context({}, [postgres]))).toMatchObject([{ store: "database (postgres)", scope: "shared" }])
    expect(kvDurability(input, context({}, [sqliteFile]))).toMatchObject([{ store: "database (sqlite)", scope: "host", fix: "Use Postgres." }])
    expect(kvDurability(input, context())).toMatchObject([{ scope: "process" }])
  })
})
