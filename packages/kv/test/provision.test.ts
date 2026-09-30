import { describe, expect, it, vi } from "vitest"

import { createKVCloudflareProvisionStep } from "../src/provision.ts"

import type { ProvisionContext } from "@vite-hub/internal/provision"
import type { CloudflareKVStoreConfig, KVModuleOptions } from "../src/types.ts"

const credentials = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token" }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status })
}

function createContext(handler: (url: URL, init?: RequestInit) => Response, env: Record<string, string | undefined> = credentials) {
  const requests: Array<{ body?: unknown, method: string, url: URL }> = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    requests.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      method: init?.method ?? "GET",
      url,
    })
    return handler(url, init)
  }
  const warn = vi.fn()
  const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn } }
  return { context, requests, warn }
}

function namedStore(namespaceName: string, options: { binding?: string, namespaceId?: string } = {}): CloudflareKVStoreConfig {
  return { driver: "cloudflare-kv-binding", namespaceName, ...options }
}

describe("KV Cloudflare provision step", () => {
  it("reuses an existing namespace and records its id for the store", async () => {
    const { context, requests } = createContext(() => jsonResponse({
      success: true,
      result: [{ id: "ns-other", title: "other" }, { id: "ns-app", title: "app-cache" }],
    }))

    const actions = await createKVCloudflareProvisionStep(() => namedStore("app-cache")).plan(context)

    expect(actions.map(({ exists, kind, name }) => ({ exists, kind, name }))).toEqual([
      { exists: true, kind: "cloudflare-kv-namespace", name: "app-cache" },
    ])
    await expect(actions[0]!.apply()).resolves.toEqual({ ids: { cloudflare: { kv: { default: "ns-app" } } } })
    expect(requests.every(request => request.method === "GET")).toBe(true)
    expect(requests[0]!.url.pathname).toBe("/client/v4/accounts/acc/storage/kv/namespaces")
    expect(requests[0]!.url.searchParams.get("per_page")).toBe("100")
  })

  it("creates a missing namespace and records the id for every store that shares it", async () => {
    const { context, requests } = createContext((_url, init) => init?.method === "POST"
      ? jsonResponse({ success: true, result: { id: "ns-new", title: "shared" } })
      : jsonResponse({ success: true, result: [] }))

    const actions = await createKVCloudflareProvisionStep(() => ({
      stores: {
        cache: namedStore("shared", { binding: "CACHE" }),
        pinned: namedStore("pinned", { binding: "PINNED", namespaceId: "configured-id" }),
        sessions: namedStore("shared", { binding: "SESSIONS" }),
        default: { binding: "UNNAMED", driver: "cloudflare-kv-binding" },
      },
    })).plan(context)

    expect(actions.map(({ exists, name }) => ({ exists, name }))).toEqual([{ exists: false, name: "shared" }])
    await expect(actions[0]!.apply()).resolves.toEqual({
      ids: { cloudflare: { kv: { cache: "ns-new", sessions: "ns-new" } } },
    })
    expect(requests.filter(request => request.method === "POST").map(request => request.body)).toEqual([{ title: "shared" }])
  })

  it("pages through the namespace list", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `ns-${index}`, title: `title-${index}` }))
    const { context, requests } = createContext(url => jsonResponse({
      success: true,
      result: url.searchParams.get("page") === "1" ? firstPage : [{ id: "ns-late", title: "late" }],
    }))

    const actions = await createKVCloudflareProvisionStep(() => namedStore("late")).plan(context)

    expect(requests.map(request => request.url.searchParams.get("page"))).toEqual(["1", "2"])
    expect(actions[0]!.exists).toBe(true)
    await expect(actions[0]!.apply()).resolves.toEqual({ ids: { cloudflare: { kv: { default: "ns-late" } } } })
  })

  it("follows pagination metadata after a short non-final page", async () => {
    const { context, requests } = createContext(url => {
      const page = url.searchParams.get("page")
      return page === "1"
        ? jsonResponse({ success: true, result: [{ id: "ns-first", title: "first" }], result_info: { count: 1, page: 1, per_page: 100, total_count: 101 } })
        : jsonResponse({ success: true, result: [{ id: "ns-late", title: "late" }], result_info: { count: 1, page: 2, per_page: 100, total_count: 101 } })
    })

    const actions = await createKVCloudflareProvisionStep(() => namedStore("late")).plan(context)

    expect(requests.map(request => request.url.searchParams.get("page"))).toEqual(["1", "2"])
    expect(actions[0]!.exists).toBe(true)
  })

  it("reads the id back when another run created the namespace first", async () => {
    let listCalls = 0
    const { context } = createContext((_url, init) => {
      if (init?.method === "POST") return jsonResponse({ success: false, errors: [{ message: "exists" }] }, 400)
      listCalls++
      return jsonResponse({ success: true, result: listCalls === 1 ? [] : [{ id: "ns-race", title: "app-cache" }] })
    })

    const actions = await createKVCloudflareProvisionStep(() => namedStore("app-cache")).plan(context)

    await expect(actions[0]!.apply()).resolves.toEqual({ ids: { cloudflare: { kv: { default: "ns-race" } } } })
  })

  it("rethrows other create failures", async () => {
    const { context } = createContext((_url, init) => init?.method === "POST"
      ? jsonResponse({ success: false, errors: [{ code: 10000, message: "denied" }] }, 403)
      : jsonResponse({ success: true, result: [] }))

    const actions = await createKVCloudflareProvisionStep(() => namedStore("app-cache")).plan(context)

    await expect(actions[0]!.apply()).rejects.toMatchObject({ name: "ProvisionRequestError", status: 403 })
  })

  it("rethrows a duplicate-looking 400 when the namespace is still absent", async () => {
    const { context } = createContext((_url, init) => init?.method === "POST"
      ? jsonResponse({ success: false, errors: [{ message: "invalid title" }] }, 400)
      : jsonResponse({ success: true, result: [] }))

    const actions = await createKVCloudflareProvisionStep(() => namedStore("app-cache")).plan(context)

    await expect(actions[0]!.apply()).rejects.toMatchObject({ name: "ProvisionRequestError", status: 400 })
  })

  it("skips without credentials and never calls the API", async () => {
    const handler = vi.fn(() => jsonResponse({ success: true, result: [] }))
    const { context, warn } = createContext(handler, {})

    await expect(createKVCloudflareProvisionStep(() => namedStore("app-cache")).plan(context)).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith("kv: skipping Cloudflare KV, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
    expect(handler).not.toHaveBeenCalled()
  })

  it("plans nothing without a namespace name, with a namespace id, or for other drivers", async () => {
    const handler = vi.fn(() => jsonResponse({ success: true, result: [] }))
    const { context, warn } = createContext(handler)

    for (const options of [
      undefined,
      false,
      { driver: "cloudflare-kv-binding" },
      namedStore("app-cache", { namespaceId: "configured-id" }),
      { driver: "upstash", token: "t", url: "https://example.upstash.io" },
    ] satisfies Array<KVModuleOptions | undefined>) {
      await expect(createKVCloudflareProvisionStep(() => options).plan(context)).resolves.toEqual([])
    }
    expect(handler).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("skips stores with a namespace id from KV_NAMESPACE_ID", async () => {
    const handler = vi.fn(() => jsonResponse({ success: true, result: [] }))
    const { context } = createContext(handler, { ...credentials, KV_NAMESPACE_ID: "env-id" })

    await expect(createKVCloudflareProvisionStep(() => namedStore("app-cache")).plan(context)).resolves.toEqual([])
    expect(handler).not.toHaveBeenCalled()
  })
})
