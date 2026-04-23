import { afterEach, describe, expect, it, vi } from "vitest"

describe("provider detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("does not infer Cloudflare without Cloudflare environment markers", async () => {
    vi.unstubAllEnvs()
    const { isCloudflare } = await import("../src/internal/shared/provider-detection.ts")

    expect(isCloudflare()).toBe(false)
  })

  it("infers Cloudflare from Cloudflare environment markers", async () => {
    vi.stubEnv("CF_PAGES", "1")
    const { isCloudflare } = await import("../src/internal/shared/provider-detection.ts")

    expect(isCloudflare()).toBe(true)
  })
})
