import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createBundledVercelBlobDriver } from "../src/drivers/vercel-bundled.ts"
import { createBlobStorage } from "../src/storage.ts"

const requested: URLSearchParams[] = []
let pathnames = ["a.txt", "b.txt", "c.txt"]
const server = createServer((request, response) => {
  const params = new URL(request.url ?? "/", "http://localhost").searchParams
  requested.push(params)
  const limit = Number(params.get("limit") ?? 1000)
  const page = pathnames.slice(0, limit)
  const hasMore = page.length < pathnames.length
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({
    blobs: page.map(pathname => ({ downloadUrl: `https://store.test/${pathname}?download=1`, etag: "\"etag\"", pathname, size: 1, uploadedAt: new Date(0).toISOString(), url: `https://store.test/${pathname}` })),
    hasMore,
    ...(hasMore ? { cursor: "next" } : {}),
  }))
})
const previousApiUrl = process.env.VERCEL_BLOB_API_URL

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (previousApiUrl === undefined) delete process.env.VERCEL_BLOB_API_URL
  else process.env.VERCEL_BLOB_API_URL = previousApiUrl
  await new Promise(resolve => server.close(resolve))
})

describe("Vercel Blob list({ limit: 0 })", () => {
  it("returns an empty page, as the fs driver does", async () => {
    const storage = createBlobStorage(createBundledVercelBlobDriver({ access: "public", driver: "vercel", token: "vercel_blob_rw_store_secret" }), "default")

    const [error, page] = await storage.list({ limit: 0 })
    expect(error).toBeUndefined()
    expect(page).toMatchObject({ blobs: [], hasMore: true })
    expect(requested.at(-1)?.get("limit")).toBe("1")

    pathnames = []
    const [emptyError, emptyPage] = await storage.list({ limit: 0 })
    expect(emptyError).toBeUndefined()
    expect(emptyPage).toMatchObject({ blobs: [], hasMore: false })
  })
})
