import { describe, expect, it, vi } from "vitest"

import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "../src/provision.ts"

import type { ProvisionContext } from "@vite-hub/internal/provision"

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

describe("blob cloudflare provision step", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token", BLOB_BUCKET_NAME: "assets" }

  it("does not create an existing R2 bucket", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("must not create existing bucket")
      return jsonResponse({ success: true, result: { buckets: [{ name: "assets" }] } })
    }) as unknown as typeof globalThis.fetch

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobCloudflareProvisionStep(() => ({ driver: "cloudflare-r2", bucketName: "assets" })).plan(context)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)
    await actions[0]!.apply()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("creates a missing R2 bucket", async () => {
    const posted: unknown[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)))
        return jsonResponse({ success: true, result: {} })
      }
      return jsonResponse({ success: true, result: { buckets: [] } })
    }) as unknown as typeof globalThis.fetch

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobCloudflareProvisionStep(() => ({ driver: "cloudflare-r2", bucketName: "assets" })).plan(context)
    expect(actions[0]!.exists).toBe(false)
    await actions[0]!.apply()
    expect(posted).toEqual([{ name: "assets" }])
  })
})

describe("blob vercel provision step", () => {
  const env = { VERCEL_TOKEN: "vtoken", VERCEL_PROJECT_ID: "prj_1", BLOB_READ_WRITE_TOKEN: "secret-token" }

  it("reuses a public Blob store and connects it without exposing its token", async () => {
    const requests: Array<{ url: string, body: unknown }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "POST") {
        requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        return jsonResponse({})
      }
      return jsonResponse({ stores: [{ id: "store_1", name: "vitehub-blob", type: "blob" }] })
    }) as unknown as typeof globalThis.fetch

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" })).plan(context)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)
    const result = await actions[0]!.apply()

    expect(result.ids).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("secret-token")
    expect(JSON.stringify(requests)).not.toContain("secret-token")
    expect(requests).toEqual([{
      body: {
        envVarEnvironments: ["production", "preview", "development"],
        projectId: "prj_1",
        type: "integration",
      },
      url: expect.stringContaining("/v1/storage/stores/store_1/connections"),
    }])
  })

  it("does not reconnect an already connected private Blob store", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      stores: [{
        access: "private",
        id: "store_private",
        name: "vitehub-blob",
        projectsMetadata: [{ projectId: "prj_1" }],
        type: "blob",
      }],
    })) as unknown as typeof globalThis.fetch

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobVercelProvisionStep(() => ({ access: "private", driver: "vercel-blob" })).plan(context)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)
    await actions[0]!.apply()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("creates and connects a private Blob store instead of selecting an existing public store", async () => {
    const requests: Array<{ method: string | undefined, url: string, body: unknown }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method,
        url,
      })
      if (url.includes("/v1/storage/stores/blob")) {
        return jsonResponse({ store: { access: "private", id: "store_private", name: "vitehub-blob", type: "blob" } })
      }
      if (init?.method === "POST") return jsonResponse({})
      return jsonResponse({ stores: [{ access: "public", id: "store_public", name: "existing-public", type: "blob" }] })
    }) as unknown as typeof globalThis.fetch

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobVercelProvisionStep(() => ({ access: "private", driver: "vercel-blob" })).plan(context)
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
        body: {
          envVarEnvironments: ["production", "preview", "development"],
          projectId: "prj_1",
          type: "integration",
        },
        method: "POST",
        url: expect.stringContaining("/v1/storage/stores/store_private/connections"),
      },
    ])
  })
})
