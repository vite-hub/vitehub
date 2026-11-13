import { generateKeyPairSync } from "node:crypto"

import { describe, expect, it } from "vitest"

import { forgeMemoryCache, forgeProvider, useForge } from "../src/index.ts"

interface Resource { body: unknown, etag: string, link?: string }

/** A GitHub REST fake that answers `If-None-Match` with a 304 and counts the requests GitHub would charge. */
function fakeGitHub(resources: Record<string, Resource>) {
  const calls: { url: string, authorization: string | null, ifNoneMatch: string | null, status: number }[] = []
  let tokens = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/access_tokens")) {
      return Response.json({ token: `installation-token-${++tokens}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 })
    }
    const resource = resources[url.replace("https://api.github.com", "")]
    const call = { url, authorization: headers.get("authorization"), ifNoneMatch: headers.get("if-none-match"), status: 200 }
    calls.push(call)
    if (!resource) {
      call.status = 404
      return Response.json({ message: "Not Found" }, { status: 404 })
    }
    const common = { etag: resource.etag, "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "2000000000" }
    if (call.ifNoneMatch === resource.etag) {
      call.status = 304
      return new Response(null, { status: 304, headers: common })
    }
    return new Response(JSON.stringify(resource.body), {
      status: 200,
      headers: { ...common, "content-type": "application/json; charset=utf-8", ...(resource.link ? { link: resource.link } : {}) },
    })
  }
  return { calls, fetch, charged: () => calls.filter(call => call.status !== 304).length }
}

function privateKey() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
}

async function readAll(provider: Awaited<ReturnType<typeof forgeProvider>>, path: string) {
  const items: unknown[] = []
  let next: string | undefined = path
  while (next) {
    const response: { data: unknown, headers: Headers } = await provider.request<unknown>("GET", next)
    items.push(...(response.data as unknown[]))
    next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1]
  }
  return items
}

describe("conditional Forge requests", () => {
  it("revalidates a repeated GET and returns the cached body on a 304", async () => {
    const github = fakeGitHub({ "/repos/acme/web/pulls/1": { body: { number: 1, title: "Fix" }, etag: "W/\"pr-1\"" } })
    const cache = forgeMemoryCache()
    const connection = { forge: "github" as const, token: "token-a", fetch: github.fetch, conditionalRequests: { cache } }

    const first = await (await forgeProvider(connection)).request("GET", "/repos/acme/web/pulls/1")
    const second = await (await forgeProvider(connection)).request("GET", "/repos/acme/web/pulls/1")

    expect(first.data).toEqual({ number: 1, title: "Fix" })
    expect(second.data).toEqual({ number: 1, title: "Fix" })
    expect(github.calls.map(call => [call.ifNoneMatch, call.status])).toEqual([[null, 200], ["W/\"pr-1\"", 304]])
    expect(second.headers.get("x-ratelimit-remaining")).toBe("4999")
  })

  it("returns the new body when the resource changed", async () => {
    const resources = { "/repos/acme/web/pulls/1": { body: { title: "Old" }, etag: "\"1\"" } }
    const github = fakeGitHub(resources)
    const connection = { forge: "github" as const, token: "token-a", fetch: github.fetch, conditionalRequests: { cache: forgeMemoryCache() } }
    await (await forgeProvider(connection)).request("GET", "/repos/acme/web/pulls/1")
    resources["/repos/acme/web/pulls/1"] = { body: { title: "New" }, etag: "\"2\"" }

    await expect((await forgeProvider(connection)).request("GET", "/repos/acme/web/pulls/1")).resolves.toMatchObject({ data: { title: "New" } })
    await expect((await forgeProvider(connection)).request("GET", "/repos/acme/web/pulls/1")).resolves.toMatchObject({ data: { title: "New" } })
    expect(github.calls.map(call => call.status)).toEqual([200, 200, 304])
  })

  it("caches each page of a list with its link header", async () => {
    const base = "https://api.github.com/repos/acme/web/issues/1/comments?per_page=2"
    const github = fakeGitHub({
      "/repos/acme/web/issues/1/comments?per_page=2": { body: [{ id: 1 }, { id: 2 }], etag: "\"p1\"", link: `<${base}&page=2>; rel="next"` },
      "/repos/acme/web/issues/1/comments?per_page=2&page=2": { body: [{ id: 3 }], etag: "\"p2\"" },
    })
    const connection = { forge: "github" as const, token: "token-a", fetch: github.fetch, conditionalRequests: { cache: forgeMemoryCache() } }

    await expect(readAll(await forgeProvider(connection), "/repos/acme/web/issues/1/comments?per_page=2")).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    await expect(readAll(await forgeProvider(connection), "/repos/acme/web/issues/1/comments?per_page=2")).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])

    expect(github.calls.map(call => [call.ifNoneMatch, call.status])).toEqual([[null, 200], [null, 200], ["\"p1\"", 304], ["\"p2\"", 304]])
  })

  it("shares entries across tokens of one identity, not across identities", async () => {
    const github = fakeGitHub({ "/repos/acme/web/pulls/1": { body: { number: 1 }, etag: "\"pr\"" } })
    const cache = forgeMemoryCache()
    const read = async (token: string, identity: string) =>
      (await forgeProvider({ forge: "github", token, fetch: github.fetch, conditionalRequests: { cache, identity } })).request("GET", "/repos/acme/web/pulls/1")

    await read("token-1", "app:1:42")
    await read("token-2", "app:1:42")
    await read("token-3", "app:1:43")

    expect(github.calls.map(call => call.status)).toEqual([200, 304, 200])
  })

  it("keys entries by token without an identity", async () => {
    const github = fakeGitHub({ "/user": { body: { login: "a" }, etag: "\"u\"" } })
    const cache = forgeMemoryCache()
    const read = async (token: string) => (await forgeProvider({ forge: "github", token, fetch: github.fetch, conditionalRequests: { cache } })).request("GET", "/user")
    await read("token-a")
    await read("token-b")
    await read("token-a")
    expect(github.calls.map(call => call.status)).toEqual([200, 200, 304])
  })

  it("leaves writes, anonymous reads and opted-out providers alone", async () => {
    const github = fakeGitHub({ "/repos/acme/web": { body: { id: 1 }, etag: "\"r\"" } })
    for (let pass = 0; pass < 2; pass++) {
      await (await forgeProvider({ forge: "github", fetch: github.fetch })).request("GET", "/repos/acme/web")
      await (await forgeProvider({ forge: "github", token: "t", fetch: github.fetch, conditionalRequests: false })).request("GET", "/repos/acme/web")
    }
    expect(github.calls.every(call => call.ifNoneMatch === null)).toBe(true)
  })

  it("drops the oldest entries past the size cap", async () => {
    const cache = forgeMemoryCache({ maxSize: 10 })
    cache.set("a", { etag: "1", body: "123456", headers: [] })
    cache.set("b", { etag: "2", body: "123456", headers: [] })
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toMatchObject({ etag: "2" })
  })

  it("keeps useForge() entries through GitHub App token rotation, per installation", async () => {
    const github = fakeGitHub({ "/repos/acme/web/pulls/1": { body: { number: 1 }, etag: "\"pr\"" } })
    const key = privateKey()
    const forgeFor = (installation: string) => useForge({ env: { VITEHUB_GITHUB_APP_ID: "7", VITEHUB_GITHUB_PRIVATE_KEY: key, VITEHUB_GITHUB_INSTALLATION_ID: installation }, fetch: github.fetch })
    const read = async (installation: string, refresh: boolean) => {
      const [error, provider] = await forgeFor(installation).provider({ refresh })
      if (error) throw error
      return await provider.request("GET", "/repos/acme/web/pulls/1")
    }

    await read("42", false)
    await read("42", true)
    await read("43", false)

    expect(github.calls.map(call => [call.authorization, call.status])).toEqual([
      ["Bearer installation-token-1", 200],
      ["Bearer installation-token-2", 304],
      ["Bearer installation-token-3", 200],
    ])
  })
})
