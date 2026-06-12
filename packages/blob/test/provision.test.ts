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

  it("pushes the blob token to project env without ever returning it as a non-secret id", async () => {
    const requests: Array<{ url: string, body: unknown }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "POST") {
        requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        return jsonResponse({})
      }
      // existing blob store so no creation happens
      return jsonResponse({ stores: [{ id: "store_1", name: "vitehub-blob", type: "blob" }] })
    }) as unknown as typeof globalThis.fetch

    const context: ProvisionContext = { env, fetch: fetchImpl, logger: { log: () => {}, warn: () => {} } }
    const actions = await createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" })).plan(context)
    expect(actions).toHaveLength(1)
    const result = await actions[0]!.apply()

    // Secret must never be written to Provision State.
    expect(result.ids).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("secret-token")

    const envPush = requests.find(request => request.url.includes("/env"))
    expect(envPush?.body).toMatchObject({ key: "BLOB_READ_WRITE_TOKEN", value: "secret-token" })
  })
})
