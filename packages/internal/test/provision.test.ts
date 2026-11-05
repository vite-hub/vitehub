import { describe, expect, it, vi } from "vitest"

import { createCloudflareProvisionClient, createVercelProvisionClient, listCloudflarePages, planProvisionSteps, ProvisionRequestError } from "../src/provision.ts"
import type { ProvisionAction, ProvisionContext, ProvisionStep } from "../src/provision.ts"

describe("provision planning", () => {
  const context = (): Omit<ProvisionContext, "markPlanUnchecked"> => ({
    env: { PROJECT_NAME: "example" },
    fetch: vi.fn<typeof globalThis.fetch>(),
    logger: { log: vi.fn(), warn: vi.fn() },
  })

  it("plans only the selected provider in order without applying actions", async () => {
    const planningContext = context()
    const calls: string[] = []
    const action: ProvisionAction = { kind: "database", name: "primary", exists: false, apply: vi.fn() }
    const steps: ProvisionStep[] = [
      {
        id: "database",
        provider: "cloudflare",
        async plan(received) {
          expect(received.env).toBe(planningContext.env)
          expect(received.fetch).toBe(planningContext.fetch)
          await Promise.resolve()
          calls.push("database")
          return [action]
        },
      },
      { id: "vercel-only", provider: "vercel", plan: vi.fn() },
      {
        id: "bindings",
        provider: "cloudflare",
        async plan() {
          expect(calls).toEqual(["database"])
          calls.push("bindings")
          return [action]
        },
      },
    ]

    await expect(planProvisionSteps("cloudflare", steps, planningContext)).resolves.toEqual({
      actions: [{ action, step: "database" }, { action, step: "bindings" }],
      checked: true,
      warnings: [],
    })
    expect(calls).toEqual(["database", "bindings"])
    expect(steps[1]!.plan).not.toHaveBeenCalled()
    expect(action.apply).not.toHaveBeenCalled()
  })

  it("collects warnings and explicit unchecked state while forwarding messages", async () => {
    const planningContext = context()
    const steps: ProvisionStep[] = [{
      id: "database",
      provider: "vercel",
      async plan(received) {
        received.logger.log("Checking primary")
        received.logger.warn("Check was unavailable")
        received.markPlanUnchecked?.()
        return []
      },
    }]

    await expect(planProvisionSteps("vercel", steps, planningContext)).resolves.toEqual({
      actions: [], checked: false, warnings: ["Check was unavailable"],
    })
    expect(planningContext.logger.log).toHaveBeenCalledWith("Checking primary")
    expect(planningContext.logger.warn).toHaveBeenCalledWith("Check was unavailable")
  })

  it("keeps a warning-only plan checked and does not retain earlier plan state", async () => {
    const planningContext = context()
    const steps: ProvisionStep[] = [{
      id: "database",
      provider: "vercel",
      async plan(received) {
        received.logger.warn("Using the existing database")
        return []
      },
    }]

    await expect(planProvisionSteps("vercel", steps, planningContext)).resolves.toEqual({
      actions: [], checked: true, warnings: ["Using the existing database"],
    })
    await expect(planProvisionSteps("vercel", [], planningContext)).resolves.toEqual({
      actions: [], checked: true, warnings: [],
    })
  })
})

describe("provision request errors", () => {
  it("ignores inherited request options", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: "raw" }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)
    const options = Object.create({ method: "POST", body: { unexpected: true }, query: { unexpected: "1" } }) as { method: string, body: unknown }

    await expect(request("/v1/storage/connections", options)).resolves.toEqual({ id: "raw" })
    const init = fetch.mock.calls[0]?.[1]
    expect(init?.method).toBe("GET")
    expect(init?.body).toBeUndefined()
    expect(new URL(String(fetch.mock.calls[0]?.[0])).search).toBe("")
  })

  it("ignores an inherited response parser", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: "raw" }))
    const parse = vi.fn(() => ({ id: "parsed" }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)
    const options = Object.create({ parse }) as { parse: typeof parse }

    await expect(request("/v1/storage/connections", options)).resolves.toEqual({ id: "raw" })
    expect(parse).not.toHaveBeenCalled()
  })

  it("uses an own response parser", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: "raw" }))
    const parse = vi.fn(() => ({ id: "parsed" }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)

    await expect(request("/v1/storage/connections", { parse })).resolves.toEqual({ id: "parsed" })
    expect(parse).toHaveBeenCalledWith({ id: "raw" })
  })

  it("reports Vercel error codes without leaking provider response details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: { code: "invalid_connection_type", message: "provider-secret" },
    }, { status: 400 }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)

    const error = await request("/v1/storage/connections", { method: "POST" }).catch(error => error)

    expect(error).toBeInstanceOf(ProvisionRequestError)
    expect(error).toMatchObject({ codes: ["invalid_connection_type"], status: 400 })
    expect(error.message).toBe("Provision request failed: POST /v1/storage/connections (400). Provider code: invalid_connection_type.")
    expect(error.message).not.toContain("provider-secret")
  })

  it("preserves Cloudflare numeric error codes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      errors: [{ code: 10004, message: "provider-secret" }],
    }, { status: 409 }))
    const request = createCloudflareProvisionClient({ accountId: "account", token: "token" }, fetch)

    const error = await request("/storage/buckets").catch(error => error)

    expect(error).toMatchObject({ codes: [10004], status: 409 })
    expect(error.message).toBe("Provision request failed: GET /storage/buckets (409). Provider code: 10004.")
    expect(error.message).not.toContain("provider-secret")
  })

  it("sends request headers without replacing the client authorization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ success: true, result: {} }))
    const request = createCloudflareProvisionClient({ accountId: "account", token: "token" }, fetch)

    await request("/r2/buckets", { body: { name: "assets" }, headers: { "authorization": "Bearer other", "cf-r2-jurisdiction": "eu" }, method: "POST" })

    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      "authorization": "Bearer token",
      "cf-r2-jurisdiction": "eu",
      "content-type": "application/json",
    })
  })

  it("ignores unsafe provider error codes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: { code: "provider-secret\nsecond-log-line" },
    }, { status: 400 }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)

    const error = await request("/v1/storage/connections").catch(error => error)

    expect(error).toMatchObject({ codes: [] })
    expect(error.message).toBe("Provision request failed: GET /v1/storage/connections (400).")
  })
})

describe("Cloudflare paged lists", () => {
  const parseNames = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("invalid list")
    return value
  }

  function pagedClient(pages: Record<string, { result: string[], result_info?: Record<string, number> }>) {
    const requests: URL[] = []
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push(url)
      return Response.json({ success: true, ...pages[url.searchParams.get("page") ?? ""] ?? { result: [] } })
    }
    return { request: createCloudflareProvisionClient({ accountId: "acc", token: "token" }, fetchImpl), requests }
  }

  it("follows total_pages", async () => {
    const { request, requests } = pagedClient({
      1: { result: ["a"], result_info: { page: 1, total_pages: 2 } },
      2: { result: ["b"], result_info: { page: 2, total_pages: 2 } },
    })

    await expect(listCloudflarePages(request, "/queues", { parse: parseNames })).resolves.toEqual(["a", "b"])
    expect(requests.map(url => [url.pathname, url.searchParams.get("page"), url.searchParams.get("per_page")])).toEqual([
      ["/client/v4/accounts/acc/queues", "1", null],
      ["/client/v4/accounts/acc/queues", "2", null],
    ])
  })

  it("follows total_count when a page is shorter than the requested size", async () => {
    const { request, requests } = pagedClient({
      1: { result: ["a"], result_info: { page: 1, per_page: 1, total_count: 2 } },
      2: { result: ["b"], result_info: { page: 2, per_page: 1, total_count: 2 } },
    })

    await expect(listCloudflarePages(request, "/d1/database", { parse: parseNames, perPage: 100 })).resolves.toEqual(["a", "b"])
    expect(requests.map(url => url.searchParams.get("per_page"))).toEqual(["100", "100"])
  })

  it("reads the next page after a full page without result_info", async () => {
    const { request, requests } = pagedClient({ 1: { result: ["a", "b"] }, 2: { result: ["c"] } })

    await expect(listCloudflarePages(request, "/storage/kv/namespaces", { parse: parseNames, perPage: 2 })).resolves.toEqual(["a", "b", "c"])
    expect(requests).toHaveLength(2)
  })

  it("stops after one page without result_info or a page size", async () => {
    const { request, requests } = pagedClient({ 1: { result: ["a"] }, 2: { result: ["b"] } })

    await expect(listCloudflarePages(request, "/queues", { parse: parseNames })).resolves.toEqual(["a"])
    expect(requests).toHaveLength(1)
  })

  it("stops on an empty page", async () => {
    const { request, requests } = pagedClient({ 1: { result: ["a"], result_info: { page: 1, total_pages: 5 } } })

    await expect(listCloudflarePages(request, "/queues", { parse: parseNames })).resolves.toEqual(["a"])
    expect(requests).toHaveLength(2)
  })

  it("fails when Cloudflare returns another page than the one requested", async () => {
    const { request } = pagedClient({
      1: { result: ["a"], result_info: { page: 1, total_pages: 2 } },
      2: { result: ["a"], result_info: { page: 1, total_pages: 2 } },
    })

    await expect(listCloudflarePages(request, "/queues", { parse: parseNames })).rejects.toMatchObject({
      code: "INTERNAL_R0010",
      why: expect.stringContaining("Cloudflare provisioning returned page 1 of /queues for page 2."),
    })
  })
})
