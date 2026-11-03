import { afterEach, describe, expect, it, vi } from "vitest"

import { isGitHubOrgMember } from "../src/index.ts"

function stubMembership(respond: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => await respond())
  vi.stubGlobal("fetch", fetch)
  return fetch
}

const active = () => Response.json({ state: "active", role: "member" })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("isGitHubOrgMember()", () => {
  it("returns true for an active membership and asks GitHub with the token", async () => {
    const fetch = stubMembership(active)

    await expect(isGitHubOrgMember("token-active", "vite hub")).resolves.toBe(true)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe("https://api.github.com/user/memberships/orgs/vite%20hub")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-active")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("returns false for a pending membership, a 404, a network error, or no token", async () => {
    stubMembership(() => Response.json({ state: "pending" }))
    await expect(isGitHubOrgMember("token-pending", "vite-hub")).resolves.toBe(false)

    stubMembership(() => Response.json({ message: "Not Found" }, { status: 404 }))
    await expect(isGitHubOrgMember("token-404", "vite-hub")).resolves.toBe(false)

    stubMembership(() => Promise.reject(new TypeError("fetch failed")))
    await expect(isGitHubOrgMember("token-offline", "vite-hub")).resolves.toBe(false)

    const fetch = stubMembership(active)
    await expect(isGitHubOrgMember(undefined, "vite-hub")).resolves.toBe(false)
    await expect(isGitHubOrgMember("", "vite-hub")).resolves.toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns false when GitHub does not answer in time", async () => {
    vi.stubGlobal("fetch", (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    }))

    await expect(isGitHubOrgMember("token-slow", "vite-hub", { timeoutMs: 10 })).resolves.toBe(false)
  })

  it("asks GitHub on every call by default", async () => {
    const fetch = stubMembership(active)

    await isGitHubOrgMember("token-no-cache", "vite-hub")
    await isGitHubOrgMember("token-no-cache", "vite-hub")
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("keeps a successful check for cacheMs per token and organization", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const fetch = stubMembership(active)

    await expect(isGitHubOrgMember("token-cached", "vite-hub", { cacheMs: 60_000 })).resolves.toBe(true)
    await expect(isGitHubOrgMember("token-cached", "vite-hub", { cacheMs: 60_000 })).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)

    await isGitHubOrgMember("token-cached", "other-org", { cacheMs: 60_000 })
    await isGitHubOrgMember("token-other", "vite-hub", { cacheMs: 60_000 })
    expect(fetch).toHaveBeenCalledTimes(3)

    vi.advanceTimersByTime(60_001)
    stubMembership(() => Response.json({ state: "pending" }))
    await expect(isGitHubOrgMember("token-cached", "vite-hub", { cacheMs: 60_000 })).resolves.toBe(false)
  })

  it("does not cache a failed check", async () => {
    stubMembership(() => Response.json({}, { status: 403 }))
    await expect(isGitHubOrgMember("token-joins", "vite-hub", { cacheMs: 60_000 })).resolves.toBe(false)

    stubMembership(active)
    await expect(isGitHubOrgMember("token-joins", "vite-hub", { cacheMs: 60_000 })).resolves.toBe(true)
  })

  it("honors each caller's cacheMs when sharing a successful check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const fetch = stubMembership(active)

    await expect(isGitHubOrgMember("token-mixed-ttl", "vite-hub", { cacheMs: 300_000 })).resolves.toBe(true)

    vi.advanceTimersByTime(500)
    await expect(isGitHubOrgMember("token-mixed-ttl", "vite-hub", { cacheMs: 1_000 })).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(59_500)
    await expect(isGitHubOrgMember("token-mixed-ttl", "vite-hub", { cacheMs: 300_000 })).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockImplementation(async () => Response.json({ state: "pending" }))
    await expect(isGitHubOrgMember("token-mixed-ttl", "vite-hub", { cacheMs: 1_000 })).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
