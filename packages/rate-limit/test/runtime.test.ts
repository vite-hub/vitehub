import { afterEach, describe, expect, it } from "vitest"

import { defineRateLimit } from "../src/index.ts"
import { runWithRateLimitRuntimeEvent, setRateLimitRuntimeConfig } from "../src/runtime.ts"

afterEach(() => {
  setRateLimitRuntimeConfig({ provider: "memory" })
})

describe("defined Rate Limits", () => {
  it("returns a reusable runtime handle", async () => {
    const uploads = defineRateLimit("uploads", { limit: 1, window: "1m" })

    await expect(uploads.consume("user")).resolves.toMatchObject({ allowed: true })
    await expect(uploads.consume("user")).resolves.toMatchObject({ allowed: false })
  })

  it("uses the integration request key when one is available", async () => {
    const uploads = defineRateLimit("request-uploads", { limit: 1, window: "1m" })

    await runWithRateLimitRuntimeEvent({}, async () => {
      await expect(uploads.consume()).resolves.toMatchObject({ allowed: true })
      await expect(uploads.consume()).resolves.toMatchObject({ allowed: false })
    }, "request")
  })

  it("keeps explicit identity authoritative", async () => {
    const uploads = defineRateLimit("identity-uploads", { limit: 1, window: "1m" })

    await runWithRateLimitRuntimeEvent({}, async () => {
      await expect(uploads.consume("user")).resolves.toMatchObject({ allowed: true })
      await expect(uploads.consume()).resolves.toMatchObject({ allowed: true })
    }, "request")
  })

  it("requires an explicit key outside a request", async () => {
    const uploads = defineRateLimit("background-uploads", { limit: 1, window: "1m" })

    await expect(uploads.consume()).rejects.toThrow("could not determine a request key")
  })

  it("isolates handles by stable ID", async () => {
    const uploads = defineRateLimit("uploads", { limit: 1, window: "1m" })
    const searches = defineRateLimit("searches", { limit: 1, window: "1m" })

    await uploads.consume("user")
    await expect(uploads.consume("user")).resolves.toMatchObject({ allowed: false })
    await expect(searches.consume("user")).resolves.toMatchObject({ allowed: true })
  })

  it("refreshes the runtime limiter when a policy changes during development", async () => {
    const first = defineRateLimit("uploads", { limit: 1, window: "1m" })
    await first.consume("user")
    await expect(first.consume("user")).resolves.toMatchObject({ allowed: false })

    const updated = defineRateLimit("uploads", { limit: 2, window: "1m" })
    await expect(updated.consume("user")).resolves.toMatchObject({ allowed: true, limit: 2 })
  })
})
