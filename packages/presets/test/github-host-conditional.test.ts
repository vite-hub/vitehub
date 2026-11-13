import { generateKeyPairSync } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

import { readSnapshot } from "../src/babysitter/inbox/snapshot-sync.ts"
import { createGitHubHost } from "../src/github/host.ts"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const head = "a".repeat(40)
const resources: Record<string, unknown> = {
  "/repos/acme/web/pulls/1": { number: 1, state: "open", head: { sha: head, ref: "fix" }, base: { sha: "b".repeat(40), ref: "main" }, mergeable: true, mergeable_state: "clean" },
  "/repos/acme/web/issues/1/comments?per_page=100&page=1": [{ id: 10, body: "looks good", user: { login: "maxi" } }],
  "/repos/acme/web/pulls/1/reviews?per_page=100&page=1": [{ id: 20, state: "APPROVED", user: { login: "maxi" } }],
  "/repos/acme/web/pulls/1/comments?per_page=100&page=1": [],
  [`/repos/acme/web/commits/${head}/check-runs?per_page=100&page=1`]: { total_count: 1, check_runs: [{ id: 30, name: "test", status: "completed", conclusion: "success" }] },
  [`/repos/acme/web/commits/${head}/statuses?per_page=100&page=1`]: [{ id: 40, context: "ci", state: "success" }],
}

/** GitHub REST for one pull request. A matching `If-None-Match` gets a 304, which GitHub does not charge. */
function fakeGitHub() {
  const calls: { path: string, token: string | null, status: number }[] = []
  let minted = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const path = `${url.pathname}${url.search}`
    if (init?.method === "POST" && path.endsWith("/access_tokens")) {
      return Response.json({ token: `installation-token-${++minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 })
    }
    const body = resources[path]
    if (body === undefined) return Response.json({ message: "Not Found" }, { status: 404 })
    const etag = `"${path.length}"`
    const headers = new Headers(init?.headers)
    const call = { path, token: headers.get("authorization"), status: headers.get("if-none-match") === etag ? 304 : 200 }
    calls.push(call)
    const rateLimit = { etag, "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4000", "x-ratelimit-reset": "2000000000" }
    if (call.status === 304) return new Response(null, { status: 304, headers: rateLimit })
    return new Response(JSON.stringify(body), { headers: { ...rateLimit, "content-type": "application/json; charset=utf-8" } })
  }
  return { calls, fetch, charged: () => calls.filter(call => call.status !== 304).length }
}

describe("GitHub host conditional requests", () => {
  it("replays a Babysitter snapshot pass after token rotation for 304s only", async () => {
    const github = fakeGitHub()
    vi.stubGlobal("fetch", github.fetch)
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const host = createGitHubHost({ credentials: () => ({ appId: 7, installationId: 42, owner: "acme", privateKey }) })
    // The same paging as the Babysitter's readRest(): one provider per read, pages by `page=`.
    const read = async (path: string, projection = ".[]") => {
      const response = await (await host.forge({ repository: "acme/web" })).request<unknown>("GET", `/${path}`)
      if (projection === ".") return [response.data]
      const key = /^\.(\w+)\[\]$/.exec(projection)?.[1]
      return (key ? (response.data as Record<string, unknown[]>)[key] : response.data) as unknown[]
    }

    const first = await readSnapshot(read, "acme/web", 1)
    expect(github.charged()).toBe(6)

    // An hour later the installation token has rotated.
    const now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now + 3_600_000)
    const second = await readSnapshot(read, "acme/web", 1)

    expect(second).toEqual(first)
    expect(new Set(github.calls.map(call => call.token))).toEqual(new Set(["Bearer installation-token-1", "Bearer installation-token-2"]))
    // Without conditional requests the replay is charged again: 12 requests. With them: 6, and 6 free 304s.
    expect(github.calls).toHaveLength(12)
    expect(github.charged()).toBe(6)
    expect(host.rateLimit()).toMatchObject({ remaining: 4000 })
  })

  it("charges every read when conditional requests are off", async () => {
    const github = fakeGitHub()
    const host = createGitHubHost({ credentials: () => ({ token: "private-token" }), fetch: github.fetch, conditionalRequests: false })
    for (let pass = 0; pass < 2; pass++) await (await host.forge({ repository: "acme/web" })).request("GET", "/repos/acme/web/pulls/1")
    expect(github.charged()).toBe(2)
  })
})
