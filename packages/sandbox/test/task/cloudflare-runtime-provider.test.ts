import { describe, expect, it, vi } from "vitest"

const { resolveCloudflareSandbox } = vi.hoisted(() => ({
  resolveCloudflareSandbox: vi.fn(async () => ({ open: vi.fn(), plan: {} })),
}))

vi.mock("../../src/internal/cloudflare.ts", () => ({ resolveCloudflareSandbox }))

import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { resolveCloudflareTaskSandbox } from "../../src/task/runtime/providers/cloudflare.ts"

const namespace = {
  get: vi.fn(),
  idFromName: vi.fn(),
}

describe("Cloudflare Sandbox runtime provider", () => {
  it("defaults idle shutdown to five minutes", async () => {
    const provider = await runWithActiveCloudflareEnv({ SANDBOX: namespace }, () => resolveCloudflareTaskSandbox({
      local: {},
      provider: { provider: "cloudflare" },
    }))

    await provider.resolveSandbox(["node"])
    expect(provider.closeAfterRun).toBe(false)
    expect(resolveCloudflareSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace,
        cloudflare: expect.objectContaining({ sleepAfter: "5m" }),
      }),
      ["node"],
    )
  })

  it("preserves an explicit idle shutdown override", async () => {
    const provider = await runWithActiveCloudflareEnv({ SANDBOX: namespace }, () => resolveCloudflareTaskSandbox({
      local: {},
      provider: { provider: "cloudflare", sleepAfter: "30s" },
    }))

    await provider.resolveSandbox(["node", "npm"])
    expect(resolveCloudflareSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudflare: expect.objectContaining({ sleepAfter: "30s" }),
      }),
      ["node", "npm"],
    )
  })

  it("closes a Sandbox session when keepAlive disables idle shutdown", async () => {
    const provider = await runWithActiveCloudflareEnv({ SANDBOX: namespace }, () => resolveCloudflareTaskSandbox({
      local: {},
      provider: { provider: "cloudflare", keepAlive: true },
    }))

    expect(provider.closeAfterRun).toBe(true)
  })

  it("says how to run Sandbox locally when the dev server has no binding", async () => {
    await expect(runWithActiveCloudflareEnv({ DB: {} }, () => resolveCloudflareTaskSandbox({
      local: {},
      provider: { provider: "cloudflare" },
    }))).rejects.toThrow("build, then run `npx wrangler dev --config .output/server/wrangler.json`")
  })

  it.each(["__proto__", "constructor", "toString"])("rejects inherited Cloudflare binding %s", async (binding) => {
    const env = Object.create({ [binding]: namespace }) as Record<string, unknown>
    resolveCloudflareSandbox.mockClear()

    await expect(runWithActiveCloudflareEnv(env, () => resolveCloudflareTaskSandbox({
      local: {},
      provider: { provider: "cloudflare", binding },
    }))).rejects.toThrow(`Cloudflare sandbox requires the ${JSON.stringify(binding)} binding`)
    expect(resolveCloudflareSandbox).not.toHaveBeenCalled()
  })
})
