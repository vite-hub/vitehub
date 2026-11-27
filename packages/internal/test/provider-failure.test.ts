import { describe, expect, it, vi } from "vitest"

import { classifyProviderFailure, cloudflareProductOfPath, readProviderErrorCodes } from "../src/provider-failure.ts"
import { createCloudflareApiClient, createCloudflareProvisionClient, createNetlifyApiClient, createVercelProvisionClient } from "../src/provision.ts"

describe("classifyProviderFailure", () => {
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not-found"],
    [408, "unavailable"],
    [409, "conflict"],
    [412, "conflict"],
    [422, "invalid"],
    [429, "throttled"],
    [400, "invalid"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps HTTP status %i to %s", (status, kind) => {
    expect(classifyProviderFailure({ host: "cloudflare" }, { status })).toBe(kind)
    expect(classifyProviderFailure({ host: "vercel" }, { status })).toBe(kind)
    expect(classifyProviderFailure({ host: "netlify" }, { status })).toBe(kind)
  })

  it("reads a Cloudflare code in the table of its product", () => {
    // 10014 means a duplicate title in KV and a malformed checksum in R2. Both come with 400.
    expect(classifyProviderFailure({ host: "cloudflare", product: "kv" }, { codes: [10014], status: 400 })).toBe("conflict")
    expect(classifyProviderFailure({ host: "cloudflare", product: "r2" }, { codes: [10014], status: 400 })).toBe("invalid")
    expect(classifyProviderFailure({ host: "cloudflare" }, { codes: [10014], status: 400 })).toBe("invalid")
  })

  it("classifies documented R2 and Queues codes", () => {
    expect(classifyProviderFailure({ host: "cloudflare", product: "r2" }, { codes: [10004], status: 400 })).toBe("conflict")
    expect(classifyProviderFailure({ host: "cloudflare", product: "r2" }, { codes: [10073], status: 409 })).toBe("conflict")
    expect(classifyProviderFailure({ host: "cloudflare", product: "r2" }, { codes: [10039] })).toBe("invalid")
    expect(classifyProviderFailure({ host: "cloudflare", product: "r2" }, { codes: [10058] })).toBe("throttled")
    expect(classifyProviderFailure({ host: "cloudflare", product: "queues" }, { codes: [10104], status: 400 })).toBe("not-found")
    expect(classifyProviderFailure({ host: "cloudflare", product: "queues" }, { codes: [10251], status: 400 })).toBe("throttled")
  })

  it("classifies documented Vercel codes", () => {
    expect(classifyProviderFailure({ host: "vercel" }, { codes: ["forbidden"], status: 400 })).toBe("unauthorized")
    expect(classifyProviderFailure({ host: "vercel" }, { codes: ["rate_limited"], status: 400 })).toBe("throttled")
    expect(classifyProviderFailure({ host: "vercel" }, { codes: ["not_modified"], status: 400 })).toBe("conflict")
    expect(classifyProviderFailure({ host: "vercel" }, { codes: ["invalid_connection_type"], status: 400 })).toBe("invalid")
    // A Cloudflare number is not a Vercel code.
    expect(classifyProviderFailure({ host: "vercel" }, { codes: [10014], status: 400 })).toBe("invalid")
  })

  it("does not invent a kind without a code or a status", () => {
    expect(classifyProviderFailure({ host: "cloudflare", product: "r2" }, { codes: [99999] })).toBeUndefined()
    expect(classifyProviderFailure({ host: "vercel" }, {})).toBeUndefined()
  })

  it("ignores inherited table keys", () => {
    expect(classifyProviderFailure({ host: "vercel" }, { codes: ["constructor", "toString"], status: 400 })).toBe("invalid")
  })
})

describe("readProviderErrorCodes", () => {
  it("reads Cloudflare and Vercel error bodies", () => {
    expect(readProviderErrorCodes({ errors: [{ code: 10014, message: "a namespace with this account ID and title already exists" }], success: false })).toEqual([10014])
    expect(readProviderErrorCodes({ error: { code: "not_found", message: "Could not find the RESOURCE: ID" } })).toEqual(["not_found"])
  })

  it("drops codes that are not safe to print", () => {
    expect(readProviderErrorCodes({ error: { code: "line\nbreak" }, errors: [{ code: Number.NaN }, { code: {} }, null] })).toEqual([])
    expect(readProviderErrorCodes("text")).toEqual([])
  })
})

describe("cloudflareProductOfPath", () => {
  it("finds the product of an account API path", () => {
    expect(cloudflareProductOfPath("/r2/buckets")).toBe("r2")
    expect(cloudflareProductOfPath("/storage/kv/namespaces")).toBe("kv")
    expect(cloudflareProductOfPath("/d1/database")).toBe("d1")
    expect(cloudflareProductOfPath("/queues")).toBe("queues")
    expect(cloudflareProductOfPath("/workers/scripts")).toBeUndefined()
  })
})

describe("provision request failure kind", () => {
  it.each([
    ["Cloudflare accounts", createCloudflareApiClient, "/accounts", "https://api.cloudflare.com/client/v4/accounts"],
    ["Netlify sites", createNetlifyApiClient, "/sites", "https://api.netlify.com/api/v1/sites"],
  ] as const)("classifies %s API failures without losing request identity", async (_name, createClient, path, url) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}, { status: 401 }))
    const request = createClient("token", fetch)

    await expect(request(path)).rejects.toMatchObject({ kind: "unauthorized", status: 401 })
    expect(String(fetch.mock.calls[0]?.[0])).toBe(url)
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer token" })
  })

  it("classifies Cloudflare account lookup failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ errors: [] }, { status: 403 }))
    const request = createCloudflareApiClient("token", fetch)

    await expect(request("/accounts")).rejects.toMatchObject({ kind: "unauthorized", status: 403 })
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.cloudflare.com/client/v4/accounts")
  })

  it("classifies Netlify lookup failures by HTTP status", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ message: "Not Found" }, { status: 404 }))
    const request = createNetlifyApiClient("token", fetch)

    await expect(request("/sites/missing")).rejects.toMatchObject({ kind: "not-found", status: 404 })
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.netlify.com/api/v1/sites/missing")
  })

  it("classifies a Cloudflare KV duplicate title as a conflict", async () => {
    // Shape seen in https://github.com/cloudflare/workers-sdk/issues/14284
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      errors: [{ code: 10014, message: "a namespace with this account ID and title already exists" }],
      messages: [],
      result: null,
      success: false,
    }, { status: 400 }))
    const request = createCloudflareProvisionClient({ accountId: "account", token: "token" }, fetch)

    const error = await request("/storage/kv/namespaces", { body: { title: "cache" }, method: "POST" }).catch(error => error)

    expect(error).toMatchObject({ codes: [10014], kind: "conflict", status: 400 })
    expect(error.message).not.toContain("already exists")
  })

  it("classifies a Cloudflare 400 without a known code as invalid", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      errors: [{ code: 10005, message: "The specified bucket name is not valid." }],
      success: false,
    }, { status: 400 }))
    const request = createCloudflareProvisionClient({ accountId: "account", token: "token" }, fetch)

    await expect(request("/r2/buckets", { method: "POST" })).rejects.toMatchObject({ codes: [10005], kind: "invalid", status: 400 })
  })

  it("classifies a Vercel error by its code before its status", async () => {
    // https://vercel.com/docs/rest-api/errors#rate-limited
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: { code: "rate_limited", limit: { remaining: 0, reset: 1571432075, resetMs: 1571432075563, total: 6 }, message: "The rate limit of 6 exceeded" },
    }, { status: 400 }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)

    await expect(request("/v1/storage/stores")).rejects.toMatchObject({ codes: ["rate_limited"], kind: "throttled", status: 400 })
  })
})
