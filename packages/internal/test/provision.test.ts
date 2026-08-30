import { describe, expect, it, vi } from "vitest"

import { createCloudflareProvisionClient, createVercelProvisionClient, ProvisionRequestError } from "../src/provision.ts"

describe("provision request errors", () => {
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
