import { afterEach, describe, expect, it, vi } from "vitest"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

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

  it("infers the runtime provider from the scoped Cloudflare environment", async () => {
    const { resolveRuntimeProvider } = await import("../src/runtime/runtime.ts")
    vi.stubGlobal("process", undefined)

    expect(runWithActiveCloudflareEnv({ SANDBOX: {} }, () => resolveRuntimeProvider())).toBe("cloudflare")
  })

  it("resolves the Cloudflare binding from the scoped environment", async () => {
    const namespace = {}

    const { resolveCloudflareSandboxBox } = await import("../src/runtime/providers/cloudflare.ts")
    const provider = await runWithActiveCloudflareEnv({ SANDBOX: namespace }, () =>
      resolveCloudflareSandboxBox({ local: {}, provider: { provider: "cloudflare" } }))

    expect(provider.resolveBox).toEqual(expect.any(Function))
  })

  it("does not mark platform sandboxes available when their SDK cannot resolve", async () => {
    vi.stubEnv("VERCEL", "1")
    vi.stubGlobal("require", {
      resolve: () => {
        throw new Error("missing")
      },
    })

    const { isSandboxAvailable } = await import("../src/runtime/provider-resolution.ts")

    expect(isSandboxAvailable("vercel")).toBe(false)
    expect(isSandboxAvailable()).toBe(false)
  })

  it("marks provider sandboxes available when their SDK resolves", async () => {
    vi.stubGlobal("require", {
      resolve: (id: string) => id,
    })

    const { isSandboxAvailable } = await import("../src/runtime/provider-resolution.ts")

    expect(isSandboxAvailable("vercel")).toBe(true)
    expect(isSandboxAvailable("cloudflare")).toBe(true)
  })

})
