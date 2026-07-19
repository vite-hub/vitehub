import { describe, expect, it, vi } from "vitest"

const { getSandbox } = vi.hoisted(() => ({ getSandbox: vi.fn() }))

vi.mock("@cloudflare/sandbox", () => ({ getSandbox }))

import { resolveSandboxProvider } from "../src/runtime/providers/cloudflare.ts"

const namespace = {
  get: vi.fn(),
  idFromName: vi.fn(),
}

describe("Cloudflare Sandbox runtime provider", () => {
  it("defaults idle shutdown to five minutes", async () => {
    const provider = await resolveSandboxProvider({
      local: {},
      provider: { provider: "cloudflare" },
    }, {
      event: { context: { cloudflare: { env: { SANDBOX: namespace } } } },
    })

    expect(provider.cloudflare.sleepAfter).toBe("5m")
  })

  it("preserves an explicit idle shutdown override", async () => {
    const provider = await resolveSandboxProvider({
      local: {},
      provider: { provider: "cloudflare", sleepAfter: "30s" },
    }, {
      event: { context: { cloudflare: { env: { SANDBOX: namespace } } } },
    })

    expect(provider.cloudflare.sleepAfter).toBe("30s")
  })
})
