import { afterEach, describe, expect, it, vi } from "vitest"

import { detectHostingRuntime } from "../src/index.ts"

describe("detectHostingRuntime", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("uses Cloudflare event context as runtime signal", () => {
    expect(detectHostingRuntime({ context: { cloudflare: {} } })).toBe("cloudflare")
    expect(detectHostingRuntime({ context: { _platform: { cloudflare: {} } } })).toBe("cloudflare")
  })

  it("uses hosting hints before env vars", () => {
    expect(detectHostingRuntime(undefined, "cloudflare-module")).toBe("cloudflare")
    expect(detectHostingRuntime(undefined, "vercel")).toBe("vercel")
    expect(detectHostingRuntime(undefined, "vercel-edge")).toBe("vercel")
  })

  it("falls back to VERCEL env detection", () => {
    vi.stubEnv("VERCEL", "1")
    expect(detectHostingRuntime(undefined)).toBe("vercel")
  })

  it("defaults to node without hosting or env signals", () => {
    vi.stubEnv("VERCEL", "")
    expect(detectHostingRuntime(undefined)).toBe("node")
  })
})
