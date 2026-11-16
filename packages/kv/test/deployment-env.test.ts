import { describe, expect, it } from "vitest"

import { kvDeploymentEnv } from "../src/deployment-env.ts"
import { resolveKVViteConfig } from "../src/vite-config.ts"

const kv = { required: true, secret: true, hasDefault: false, owners: ["kv"] }

describe("kvDeploymentEnv", () => {
  it("names the Upstash variables in read order, never their values", () => {
    const canary = "canary-value-2f9d"
    const { kv: config } = resolveKVViteConfig(undefined, { env: { KV_REST_API_TOKEN: canary, KV_REST_API_URL: "https://canary.upstash.io" }, hosting: "vercel" })
    const entries = kvDeploymentEnv(config)
    expect(entries).toEqual([
      { names: ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"], ...kv },
      { names: ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"], ...kv },
    ])
    expect(JSON.stringify(entries)).not.toContain("canary")
  })

  it("names the Redis URL variable of each store", () => {
    const { kv: config } = resolveKVViteConfig({ stores: { default: { driver: "redis" }, cache: { driver: "redis", url: "env:CACHE_REDIS_URL" } } }, { env: {} })
    expect(kvDeploymentEnv(config)).toEqual([{ names: ["REDIS_URL"], ...kv }, { names: ["CACHE_REDIS_URL"], ...kv }])
  })

  it("names nothing for a Cloudflare KV binding", () => {
    const { kv: config } = resolveKVViteConfig(undefined, { env: {}, hosting: "cloudflare-module" })
    expect(kvDeploymentEnv(config)).toEqual([])
  })
})
