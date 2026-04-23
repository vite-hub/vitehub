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

  it("infers the runtime provider from the Cloudflare event without process", async () => {
    const { resolveRuntimeProvider } = await import("../src/runtime/runtime.ts")
    vi.stubGlobal("process", undefined)

    expect(resolveRuntimeProvider(undefined, {
      context: {
        cloudflare: {
          env: {
            SANDBOX: {},
          },
        },
      },
    })).toBe("cloudflare")
  })
})
