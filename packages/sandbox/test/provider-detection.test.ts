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
    vi.doMock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }))
    const namespace = {}

    try {
      const { resolveSandboxProvider } = await import("../src/runtime/providers/cloudflare.ts")
      const provider = await runWithActiveCloudflareEnv({ SANDBOX: namespace }, () =>
        resolveSandboxProvider({
          local: {},
          provider: { provider: "cloudflare" },
        }))

      expect(provider.namespace).toBe(namespace)
    }
    finally {
      vi.doUnmock("@cloudflare/sandbox")
    }
  })

  it("does not mark platform sandboxes available when their SDK cannot resolve", async () => {
    vi.stubEnv("VERCEL", "1")
    vi.stubGlobal("require", {
      resolve: () => {
        throw new Error("missing")
      },
    })

    const { isSandboxAvailable } = await import("../src/sandbox/providers/shared.ts")

    expect(isSandboxAvailable("vercel")).toBe(false)
    expect(isSandboxAvailable()).toBe(false)
  })

  it("marks provider sandboxes available when their SDK resolves", async () => {
    vi.stubGlobal("require", {
      resolve: (id: string) => id,
    })

    const { isSandboxAvailable } = await import("../src/sandbox/providers/shared.ts")

    expect(isSandboxAvailable("vercel")).toBe(true)
    expect(isSandboxAvailable("cloudflare")).toBe(true)
  })

  it("does not load the Cloudflare SDK when a sandbox getter is injected", async () => {
    vi.resetModules()
    vi.doMock("@cloudflare/sandbox", () => {
      throw new Error("unexpected Cloudflare SDK load")
    })

    try {
      const { createCloudflareSandboxClient } = await import("../src/sandbox/providers/cloudflare.ts")
      const client = await createCloudflareSandboxClient({
        getSandbox: () => ({}) as never,
        namespace: {} as never,
        provider: "cloudflare",
      })

      expect(client.provider).toBe("cloudflare")
    }
    finally {
      vi.doUnmock("@cloudflare/sandbox")
      vi.resetModules()
    }
  })
})
