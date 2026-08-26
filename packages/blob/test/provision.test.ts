import { describe, expect, it, vi } from "vitest"

import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "../src/provision.ts"

import type { ProvisionContext } from "@vite-hub/internal/provision"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status })
}

function mockFetch(implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return vi.fn(implementation)
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  }
  catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("Expected promise to reject.")

describe("blob cloudflare provision step", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token", BLOB_BUCKET_NAME: "assets" }

  function context(fetchImpl: typeof globalThis.fetch): ProvisionContext {
    return { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
  }

  async function plan(fetchImpl: typeof globalThis.fetch) {
    return await createBlobCloudflareProvisionStep(() => ({ driver: "cloudflare-r2", bucketName: "assets" })).plan(context(fetchImpl))
  }

  it("finds an existing R2 bucket on the second cursor page", async () => {
    const urls: URL[] = []
    const fetchImpl = mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("must not create existing bucket")
      const url = new URL(String(input))
      urls.push(url)
      return url.searchParams.get("cursor") === "next-page"
        ? jsonResponse({ success: true, result: { buckets: [{ name: "assets" }] } })
        : jsonResponse({ success: true, result: { buckets: [{ name: "other" }] }, result_info: { cursor: "next-page" } })
    })

    const actions = await plan(fetchImpl)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)
    await actions[0]!.apply()
    expect(urls).toHaveLength(2)
    expect(urls[0]!.searchParams.get("per_page")).toBe("1000")
    expect(urls[1]!.searchParams.get("cursor")).toBe("next-page")
  })

  it("creates a missing R2 bucket", async () => {
    const posted: unknown[] = []
    const fetchImpl = mockFetch(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)))
        return jsonResponse({ success: true, result: {} })
      }
      return jsonResponse({ success: true, result: { buckets: [] } })
    })

    const actions = await plan(fetchImpl)
    expect(actions[0]!.exists).toBe(false)
    await actions[0]!.apply()
    expect(posted).toEqual([{ name: "assets" }])
  })

  it("rejects a repeated R2 pagination cursor", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({
      success: true,
      result: { buckets: [] },
      result_info: { cursor: "repeated" },
    }))

    await expect(plan(fetchImpl)).rejects.toThrow("repeated pagination cursor")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("bounds R2 bucket pagination", async () => {
    let calls = 0
    const fetchImpl = mockFetch(async () => jsonResponse({
      success: true,
      result: { buckets: [] },
      result_info: { cursor: `cursor-${++calls}` },
    }))

    await expect(plan(fetchImpl)).rejects.toThrow("exceeded 100 pages")
    expect(fetchImpl).toHaveBeenCalledTimes(100)
  })

  it("accepts a create conflict only after the exact R2 bucket becomes visible", async () => {
    const requests: Array<{ method: string | undefined, url: URL }> = []
    const fetchImpl = mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ method: init?.method, url })
      if (url.pathname.endsWith("/r2/buckets/assets")) {
        return jsonResponse({ success: true, result: { name: "assets" } })
      }
      if (init?.method === "POST") {
        return jsonResponse({ errors: [{ message: "bucket already exists" }], success: false }, 409)
      }
      return jsonResponse({ success: true, result: { buckets: [] } })
    })

    const actions = await plan(fetchImpl)
    await expect(actions[0]!.apply()).resolves.toEqual({})
    expect(requests.map(request => [request.method, request.url.pathname])).toEqual([
      ["GET", "/client/v4/accounts/acc/r2/buckets"],
      ["POST", "/client/v4/accounts/acc/r2/buckets"],
      ["GET", "/client/v4/accounts/acc/r2/buckets/assets"],
    ])
  })

  it("preserves a create conflict when the exact R2 read returns a different bucket", async () => {
    const fetchImpl = mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/r2/buckets/assets")) {
        return jsonResponse({ success: true, result: { name: "different" } })
      }
      if (init?.method === "POST") return jsonResponse({ success: false }, 409)
      return jsonResponse({ success: true, result: { buckets: [] } })
    })

    const actions = await plan(fetchImpl)
    await expect(actions[0]!.apply()).rejects.toThrow("POST /r2/buckets (409)")
  })

  it("rejects a create conflict when the exact R2 bucket cannot be read", async () => {
    const fetchImpl = mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/r2/buckets/assets")) {
        return jsonResponse({ errors: [{ message: "provider-secret" }], success: false }, 403)
      }
      if (init?.method === "POST") return jsonResponse({ success: false }, 409)
      return jsonResponse({ success: true, result: { buckets: [] } })
    })

    const actions = await plan(fetchImpl)
    const error = await captureError(actions[0]!.apply())
    expect(error.message).toContain("GET /r2/buckets/assets (403)")
    expect(error.message).not.toContain("provider-secret")
  })

  it("propagates a redacted R2 authentication error", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({
      errors: [{ message: "invalid token token" }],
      success: false,
    }, 401))

    const error = await captureError(plan(fetchImpl))
    expect(error.message).toContain("GET /r2/buckets (401)")
    expect(error.message).not.toContain("token")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("reuses the R2 bucket on repeated provision", async () => {
    let exists = false
    let creates = 0
    const fetchImpl = mockFetch(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        creates++
        exists = true
        return jsonResponse({ success: true, result: { name: "assets" } })
      }
      return jsonResponse({ success: true, result: { buckets: exists ? [{ name: "assets" }] : [] } })
    })

    const first = await plan(fetchImpl)
    expect(first[0]!.exists).toBe(false)
    await first[0]!.apply()
    const second = await plan(fetchImpl)
    expect(second[0]!.exists).toBe(true)
    await second[0]!.apply()
    expect(creates).toBe(1)
  })
})

describe("blob vercel provision step", () => {
  const env = { VERCEL_TOKEN: "vtoken", VERCEL_PROJECT_ID: "prj_1", BLOB_READ_WRITE_TOKEN: "secret-token" }
  const requiredEnvironments = ["production", "preview", "development"]

  function context(fetchImpl: typeof globalThis.fetch): ProvisionContext {
    return { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
  }

  function connectedProject(projectId = "prj_1", environments = requiredEnvironments) {
    return { environments, projectId }
  }

  it("re-reads list entries without connection metadata before connecting", async () => {
    const requests: Array<{ method: string, url: string, body: unknown }> = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, method: init?.method ?? "GET", url })
      if (url.includes("/v1/storage/stores/store_1/connections")) return jsonResponse({}, 201)
      if (url.includes("/storage/stores/store_1")) return jsonResponse({ store: { projectsMetadata: [] } })
      return jsonResponse({ stores: [{ id: "store_1", name: "vitehub-blob", type: "blob" }] })
    })

    const actions = await createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" })).plan(context(fetchImpl))
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)
    const result = await actions[0]!.apply()

    expect(result.ids).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("secret-token")
    expect(JSON.stringify(requests)).not.toContain("secret-token")
    expect(requests).toEqual([
      { body: undefined, method: "GET", url: expect.stringContaining("/v1/storage/stores") },
      { body: undefined, method: "GET", url: expect.stringContaining("/storage/stores/store_1") },
      {
        body: { envVarEnvironments: requiredEnvironments, projectId: "prj_1", type: "integration" },
        method: "POST",
        url: expect.stringContaining("/v1/storage/stores/store_1/connections"),
      },
    ])
  })

  it("trusts the exact store state over omitted list metadata for an existing connection", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (init?.method === "POST") throw new Error("must not reconnect an equivalent store")
      if (url.includes("/storage/stores/store_private")) {
        return jsonResponse({ store: { projectsMetadata: [connectedProject()] } })
      }
      return jsonResponse({ stores: [{ access: "private", id: "store_private", name: "vitehub-blob", type: "blob" }] })
    })

    const actions = await createBlobVercelProvisionStep(() => ({ access: "private", driver: "vercel-blob" })).plan(context(fetchImpl))
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)
    await actions[0]!.apply()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("is idempotent across repeated provision runs", async () => {
    let connected = false
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes("/v1/storage/stores/store_1/connections")) {
        connected = true
        return jsonResponse({}, 201)
      }
      if (url.includes("/storage/stores/store_1")) {
        return jsonResponse({ store: { projectsMetadata: connected ? [connectedProject()] : [] } })
      }
      return jsonResponse({ stores: [{ id: "store_1", name: "vitehub-blob", type: "blob" }] })
    })
    const fetchImpl = fetchMock

    const step = createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" }))
    await (await step.plan(context(fetchImpl)))[0]!.apply()
    await (await step.plan(context(fetchImpl)))[0]!.apply()

    const connectionRequests = fetchMock.mock.calls.filter(([input, init]) =>
      String(input).includes("/connections") && init?.method === "POST")
    expect(connectionRequests).toHaveLength(1)
  })

  it("creates and connects a private Blob store instead of selecting an existing public store", async () => {
    const requests: Array<{ method: string | undefined, url: string, body: unknown }> = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method,
        url,
      })
      if (url.includes("/v1/storage/stores/blob")) {
        return jsonResponse({ store: { access: "private", id: "store_private", name: "vitehub-blob", type: "blob" } })
      }
      if (url.includes("/storage/stores/store_private")) return jsonResponse({ store: { projectsMetadata: [] } })
      if (init?.method === "POST") return jsonResponse({}, 201)
      return jsonResponse({ stores: [{ access: "public", id: "store_public", name: "existing-public", type: "blob" }] })
    })

    const actions = await createBlobVercelProvisionStep(() => ({ access: "private", driver: "vercel-blob" })).plan(context(fetchImpl))
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(false)
    await actions[0]!.apply()

    expect(requests).toEqual([
      { body: undefined, method: "GET", url: expect.stringContaining("/v1/storage/stores") },
      {
        body: { access: "private", name: "vitehub-blob", region: "iad1" },
        method: "POST",
        url: expect.stringContaining("/v1/storage/stores/blob"),
      },
      {
        body: undefined,
        method: "GET",
        url: expect.stringContaining("/storage/stores/store_private"),
      },
      {
        body: { envVarEnvironments: requiredEnvironments, projectId: "prj_1", type: "integration" },
        method: "POST",
        url: expect.stringContaining("/v1/storage/stores/store_private/connections"),
      },
    ])
  })

  it("rejects an existing project connection with incomplete environments", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST") throw new Error("must not create a duplicate project connection")
      const url = String(input)
      if (url.includes("/storage/stores/store_1")) {
        return jsonResponse({ store: { projectsMetadata: [connectedProject("prj_1", ["production"])] } })
      }
      return jsonResponse({ stores: [{ id: "store_1", type: "blob" }] })
    })

    const actions = await createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" })).plan(context(fetchImpl))
    await expect(actions[0]!.apply()).rejects.toThrow("without all required environments")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("accepts a concurrent connection only after the exact store proves equivalence", async () => {
    let reads = 0
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (init?.method === "POST") return jsonResponse({ error: { code: "already_connected" } }, 400)
      if (url.includes("/storage/stores/store_1")) {
        reads++
        return jsonResponse({ store: { projectsMetadata: reads === 1 ? [] : [connectedProject()] } })
      }
      return jsonResponse({ stores: [{ id: "store_1", type: "blob" }] })
    })

    const actions = await createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" })).plan(context(fetchImpl))
    await expect(actions[0]!.apply()).resolves.toEqual({})
    expect(reads).toBe(2)
  })

  it("does not treat an invalid connection type or a different project as success", async () => {
    const leakedSecret = "provider-secret-in-error-body"
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (init?.method === "POST") {
        expect(String(init.body)).toBe(JSON.stringify({
          envVarEnvironments: requiredEnvironments,
          projectId: "prj_1",
          type: "integration",
        }))
        return jsonResponse({ error: { code: "invalid_connection_type", detail: leakedSecret } }, 400)
      }
      if (url.includes("/storage/stores/store_1")) {
        return jsonResponse({ store: { projectsMetadata: [connectedProject("prj_other")] } })
      }
      return jsonResponse({ stores: [{ id: "store_1", type: "blob" }] })
    })

    const actions = await createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" })).plan(context(fetchImpl))
    let provisionError: Error | undefined
    try {
      await actions[0]!.apply()
    }
    catch (error) {
      provisionError = error instanceof Error ? error : new Error(String(error))
    }
    expect(provisionError?.message).toContain("POST /v1/storage/stores/store_1/connections (400)")
    expect(provisionError?.message).not.toContain(leakedSecret)
  })

  it("surfaces wrong-team authorization without attempting a connection", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes("/storage/stores/store_1")) return jsonResponse({ error: "wrong team" }, 403)
      if (init?.method === "POST") throw new Error("must not connect a store outside the team scope")
      return jsonResponse({ stores: [{ id: "store_1", type: "blob" }] })
    })

    const actions = await createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" })).plan(context(fetchImpl))
    await expect(actions[0]!.apply()).rejects.toThrow("GET /storage/stores/store_1 (403)")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
