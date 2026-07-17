import { afterEach, describe, expect, it } from "vitest"

import { consumeRateLimit, getRateLimit } from "../src/index.ts"
import { setRateLimitRuntimeConfig, setRateLimitRuntimeRegistry } from "../src/runtime.ts"

afterEach(() => {
  setRateLimitRuntimeRegistry(undefined)
  setRateLimitRuntimeConfig({ provider: "memory" })
})

describe("named Rate Limits", () => {
  it("loads Definitions through the generated registry contract", async () => {
    setRateLimitRuntimeRegistry({
      uploads: async () => ({ default: { limit: 1, window: "1m" } }),
    })

    await expect(consumeRateLimit("uploads", { key: "user" })).resolves.toMatchObject({ allowed: true })
    await expect(consumeRateLimit("uploads", { key: "user" })).resolves.toMatchObject({ allowed: false })
    await expect(getRateLimit("uploads")).resolves.toHaveProperty("policy.limit", 1)
  })

  it("does not pretend direct scripts can discover Definitions", async () => {
    await expect(consumeRateLimit("missing", { key: "user" })).rejects.toThrow("direct scripts should use createRateLimiter")
  })
})
