import { afterEach, describe, expect, it, vi } from "vitest"

import { createGitHubHost } from "../src/github/host.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GitHub host", () => {
  it("does not resolve credentials for a pre-aborted operation", async () => {
    const credentials = vi.fn(() => Promise.reject(new Error("resolver should not run")))
    const host = createGitHubHost({ credentials })
    const controller = new AbortController()
    controller.abort(new Error("already cancelled"))
    await expect(host.access({ signal: controller.signal })).rejects.toThrow("already cancelled")
    expect(credentials).not.toHaveBeenCalled()
  })

  it("creates a Forge provider and reports response rate limits", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4998", "x-ratelimit-reset": "2000000000", "x-ratelimit-resource": "core" },
    }))
    const host = createGitHubHost({ credentials: () => ({ token: "private-token" }), fetch })
    const provider = await host.forge({ repository: "acme/app" })
    await expect(provider.request("GET", "/rate")).resolves.toMatchObject({ data: { ok: true } })
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/rate"), expect.anything())
    expect(host.rateLimit()).toMatchObject({ resource: "core", limit: 5000, remaining: 4998, resetAt: 2_000_000_000_000 })
  })

  it("keeps child-shell GitHub credentials in the environment", async () => {
    const host = createGitHubHost({ credentials: () => ({ token: "private-token" }) })
    await expect(host.environment()).resolves.toMatchObject({ GH_TOKEN: "private-token", GITHUB_TOKEN: "private-token", GH_HOST: "github.com" })
  })
})
