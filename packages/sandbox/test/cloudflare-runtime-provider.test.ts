import { describe, expect, it, vi } from "vitest"

const { resolveCloudflareBox } = vi.hoisted(() => ({
  resolveCloudflareBox: vi.fn(async () => ({ open: vi.fn(), plan: {} })),
}))

vi.mock("@vite-hub/box/cloudflare", () => ({ resolveCloudflareBox }))

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

    await provider.resolveBox(["node"])
    expect(provider.closeAfterRun).toBe(false)
    expect(resolveCloudflareBox).toHaveBeenCalledWith(expect.objectContaining({
      namespace,
      cloudflare: expect.objectContaining({ sleepAfter: "5m" }),
    }), ["node"])
  })

  it("preserves an explicit idle shutdown override", async () => {
    const provider = await resolveSandboxBox({
      local: {},
      provider: { provider: "cloudflare", sleepAfter: "30s" },
    }, {
      event: { context: { cloudflare: { env: { SANDBOX: namespace } } } },
    })

    await provider.resolveBox(["node", "npm"])
    expect(resolveCloudflareBox).toHaveBeenCalledWith(expect.objectContaining({
      cloudflare: expect.objectContaining({ sleepAfter: "30s" }),
    }), ["node", "npm"])
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
