import { afterEach, describe, expect, it } from "vitest"

import { defineRateLimit } from "../src/index.ts"
import { getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
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

  it("enforces limited decisions with an H3 429 response", async () => {
    const uploads = defineRateLimit("enforced-uploads", { limit: 1, window: "1m" })

    await uploads.enforce("user")
    await expect(uploads.enforce("user")).rejects.toMatchObject({
      status: 429,
      statusText: "Too Many Requests",
    })

    try {
      await uploads.enforce("user")
    }
    catch (error) {
      expect(Number((error as { headers?: Headers }).headers?.get("Retry-After"))).toBeGreaterThan(0)
    }
  })

  it("enforces denied provider unavailability with H3 503 and its cause", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const cause = new Error("provider unavailable")
    const uploads = defineRateLimit("unavailable-uploads", { failure: "deny", limit: 1, window: "1m" })
    const event = {
      context: {
        cloudflare: {
          env: {
            [getCloudflareRateLimitBindingName("unavailable-uploads")]: {
              limit: async () => { throw cause },
            },
          },
        },
      },
    }

    try {
      await runWithRateLimitRuntimeEvent(event, () => uploads.enforce(), "user")
      expect.unreachable("Expected rate limiting to be unavailable")
    }
    catch (error) {
      expect(error).toMatchObject({
        cause: { cause },
        status: 503,
        statusText: "Service Unavailable",
      })
    }
  })

  it("does not invent retry metadata for providers that omit it", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const uploads = defineRateLimit("metadata-free-uploads", { limit: 1, window: "1m" })
    const event = {
      context: {
        cloudflare: {
          env: {
            [getCloudflareRateLimitBindingName("metadata-free-uploads")]: {
              limit: async () => ({ success: false }),
            },
          },
        },
      },
    }

    try {
      await runWithRateLimitRuntimeEvent(event, () => uploads.enforce(), "user")
      expect.unreachable("Expected the request to be limited")
    }
    catch (error) {
      expect(error).toMatchObject({ status: 429 })
      expect((error as { headers?: Headers }).headers).toBeUndefined()
    }
  })

  it("allows provider unavailability when the policy fails open", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const uploads = defineRateLimit("fail-open-uploads", { failure: "allow", limit: 1, window: "1m" })
    const event = {
      context: {
        cloudflare: {
          env: {
            [getCloudflareRateLimitBindingName("fail-open-uploads")]: {
              limit: async () => { throw new Error("provider unavailable") },
            },
          },
        },
      },
    }

    await expect(runWithRateLimitRuntimeEvent(event, () => uploads.enforce(), "user")).resolves.toBeUndefined()
  })

  it("does not translate configuration defects into H3 responses", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const uploads = defineRateLimit("missing-binding-uploads", { failure: "deny", limit: 1, window: "1m" })

    await expect(runWithRateLimitRuntimeEvent(
      { context: { cloudflare: { env: {} } } },
      () => uploads.enforce(),
      "user",
    )).rejects.toThrow("was not found")
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
