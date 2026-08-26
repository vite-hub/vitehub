import { describe, expect, it, vi } from "vitest"

import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "../src/provision.ts"

import type { ProvisionContext } from "@vite-hub/internal/provision"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status })
}

describe("blob cloudflare provision step", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token", BLOB_BUCKET_NAME: "assets" }

  it("does not create an existing R2 bucket", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") throw new Error("must not create existing bucket")
      return jsonResponse({ success: true, result: { buckets: [{ name: "assets" }] } })
    })

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobCloudflareProvisionStep(() => ({ driver: "cloudflare-r2", bucketName: "assets" })).plan(context)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)
    await actions[0]!.apply()
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false)
  })

  it("creates a missing R2 bucket", async () => {
    const posted: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)))
        return jsonResponse({ success: true, result: {} })
      }
      return jsonResponse({ success: true, result: { buckets: [] } })
    })

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobCloudflareProvisionStep(() => ({ driver: "cloudflare-r2", bucketName: "assets" })).plan(context)
    expect(actions[0]!.exists).toBe(false)
    await actions[0]!.apply()
    expect(posted).toEqual([{ name: "assets" }])
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
