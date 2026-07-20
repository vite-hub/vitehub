import { describe, expect, it, vi } from "vitest"

const { cloudflareBox } = vi.hoisted(() => ({ cloudflareBox: vi.fn(() => ({ name: "cloudflare" })) }))

vi.mock("@vite-hub/box/cloudflare", () => ({ cloudflareBox }))

import { resolveSandboxBox } from "../src/runtime/providers/cloudflare.ts"

const namespace = {
  get: vi.fn(),
  idFromName: vi.fn(),
}

describe("Cloudflare Sandbox runtime provider", () => {
  it("defaults idle shutdown to five minutes", async () => {
    const provider = await resolveSandboxBox({
      local: {},
      provider: { provider: "cloudflare" },
    }, {
      event: { context: { cloudflare: { env: { SANDBOX: namespace } } } },
    })

    expect(provider.runtime.name).toBe("cloudflare")
    expect(provider.closeAfterRun).toBe(false)
    expect(cloudflareBox).toHaveBeenCalledWith(expect.objectContaining({
      namespace,
      cloudflare: expect.objectContaining({ sleepAfter: "5m" }),
    }))
  })

  it("preserves an explicit idle shutdown override", async () => {
    await resolveSandboxBox({
      local: {},
      provider: { provider: "cloudflare", sleepAfter: "30s" },
    }, {
      event: { context: { cloudflare: { env: { SANDBOX: namespace } } } },
    })

    expect(cloudflareBox).toHaveBeenCalledWith(expect.objectContaining({
      cloudflare: expect.objectContaining({ sleepAfter: "30s" }),
    }))
  })

  it("closes a Box session when keepAlive disables idle shutdown", async () => {
    const provider = await resolveSandboxBox({
      local: {},
      provider: { provider: "cloudflare", keepAlive: true },
    }, {
      event: { context: { cloudflare: { env: { SANDBOX: namespace } } } },
    })

    expect(provider.closeAfterRun).toBe(true)
  })
})
