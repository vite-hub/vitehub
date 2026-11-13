import { describe, expect, it } from "vitest"

import { rateLimitDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

const kv = (store: string, scope: Durability["scope"]): Durability => ({ primitive: "kv", store, scope, reason: `${store}.` })

describe("rateLimitDurability", () => {
  it("reports memory and Cloudflare by provider", () => {
    expect(rateLimitDurability({ provider: "memory" }, context())).toMatchObject([{ store: "memory", scope: "process" }])
    expect(rateLimitDurability({ provider: "cloudflare" }, context())).toMatchObject([{ store: "cloudflare", scope: "shared", reason: expect.stringContaining("Cloudflare") }])
  })

  it("follows the default KV store with the kv provider", () => {
    expect(rateLimitDurability({ provider: "kv" }, context({}, [kv("redis", "shared")]))).toMatchObject([{ store: "kv (redis)", scope: "shared" }])
    expect(rateLimitDurability({ provider: "kv" }, context({}, [kv("database (postgres)", "shared")]))).toMatchObject([{ store: "kv (database (postgres))", scope: "shared" }])
    expect(rateLimitDurability({ provider: "kv" }, context({}, [kv("database (sqlite)", "host")]))).toMatchObject([{ scope: "host" }])
  })

  it("falls back to memory when the default KV store is a file store", () => {
    expect(rateLimitDurability({ provider: "kv" }, context({}, [kv("fs-lite", "host")]))).toMatchObject([{ store: "memory", scope: "process", reason: expect.stringContaining("fs-lite") }])
  })
})
