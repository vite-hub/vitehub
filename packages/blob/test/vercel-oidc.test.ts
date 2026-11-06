import { afterEach, expect, it, vi } from "vitest"

import { createDriver } from "@vite-hub/blob/drivers/vercel"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it("authenticates the published Vercel driver with OIDC without a read-write token", async () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  const token = `e30.${payload}.signature`
  vi.stubEnv("VERCEL_OIDC_TOKEN", token)
  vi.stubEnv("BLOB_STORE_ID", "store_oidc")
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", undefined)
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ blobs: [], hasMore: false }))
  vi.stubGlobal("fetch", fetchImpl)
  const driver = createDriver({ access: "public", driver: "vercel-blob" })

  await expect(driver.list({})).resolves.toMatchObject({ blobs: [], hasMore: false })

  expect(fetchImpl).toHaveBeenCalledOnce()
  const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers)
  expect(headers.get("authorization")).toBe(`Bearer ${token}`)
  expect(headers.get("x-vercel-blob-store-id")).toBe("oidc")
})
