import { describe, expect, it } from "vitest"

import { createBlobStorage } from "../src/storage.ts"

import type { BlobDriverAdapter, BlobObject } from "../src/types.ts"

function memoryStore() {
  const objects = new Map<string, Blob>()
  const reads: string[] = []
  const object = (pathname: string, body: Blob): BlobObject => ({ contentType: body.type, customMetadata: {}, httpEtag: "\"1\"", httpMetadata: {}, pathname, size: body.size, uploadedAt: new Date(0) })
  const driver: BlobDriverAdapter<object> = {
    name: "memory",
    options: {},
    async delete(pathnames) { for (const pathname of [pathnames].flat()) objects.delete(pathname) },
    async get(pathname) {
      reads.push(pathname)
      return objects.get(pathname) ?? null
    },
    async getArrayBuffer(pathname) { return await objects.get(pathname)?.arrayBuffer() ?? null },
    async head(pathname) {
      const body = objects.get(pathname)
      return body ? object(pathname, body) : null
    },
    async list() { return { blobs: [], hasMore: false } },
    async put(pathname, body) {
      const blob = body instanceof Blob ? body : new Blob([String(body)])
      objects.set(pathname, blob)
      return object(pathname, blob)
    },
  }
  return { reads, storage: createBlobStorage(driver) }
}

/** A Request with the `waitUntil` that srvx sets on Cloudflare, and a way to wait for what it was given. */
function request(path: string, init?: RequestInit) {
  const pending: Promise<unknown>[] = []
  const req = Object.assign(new Request(`https://app.example${path}`, init), { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) })
  return { req, settled: () => Promise.all(pending) }
}

const edgeCache = { maxAge: 3600 }

async function serveOnce(storage: ReturnType<typeof memoryStore>["storage"], pathname: string) {
  const first = request(`/files/${pathname}`)
  const response = await storage.serve(first.req, pathname, { edgeCache })
  const text = await response.text()
  await first.settled()
  return { response, text }
}

describe("blob.serve() with edgeCache in workerd", () => {
  it("answers the next GET from the Cloudflare cache with the headers of its own options", async () => {
    const { reads, storage } = memoryStore()
    await storage.put("assets/app.js", new Blob(["console.log(1)"], { type: "text/javascript" }))
    const first = await serveOnce(storage, "assets/app.js")
    expect(first.response.status).toBe(200)
    expect(reads).toHaveLength(1)

    const next = request("/files/assets/app.js")
    const kept = await storage.serve(next.req, "assets/app.js", { cacheControl: "private, max-age=60", download: true, edgeCache })
    expect(kept.status).toBe(200)
    expect(await kept.text()).toBe("console.log(1)")
    expect(reads).toHaveLength(1)
    expect(Object.fromEntries(kept.headers)).toMatchObject({
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=60",
      "content-disposition": "attachment; filename=\"app.js\"; filename*=UTF-8''app.js",
      "content-length": "14",
      "content-type": "text/javascript",
      "etag": first.response.headers.get("etag"),
      "x-content-type-options": "nosniff",
    })
  })

  it("answers a range and a matching If-None-Match from the cache", async () => {
    const { reads, storage } = memoryStore()
    await storage.put("clip.txt", new Blob(["0123456789"], { type: "text/plain" }))
    const { response } = await serveOnce(storage, "clip.txt")
    const etag = response.headers.get("etag")!

    const ranged = await storage.serve(request("/files/clip.txt", { headers: { range: "bytes=2-5" } }).req, "clip.txt", { edgeCache })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(await ranged.text()).toBe("2345")

    const fresh = await storage.serve(request("/files/clip.txt", { headers: { "if-none-match": etag } }).req, "clip.txt", { edgeCache })
    expect(fresh.status).toBe(304)
    expect(fresh.headers.get("etag")).toBe(etag)
    expect(reads).toHaveLength(1)
  })

  it("keeps the sandbox of an active content type on a cached answer", async () => {
    const { reads, storage } = memoryStore()
    await storage.put("page.html", new Blob(["<script>1</script>"], { type: "text/html" }))
    await serveOnce(storage, "page.html")
    const kept = await storage.serve(request("/files/page.html").req, "page.html", { edgeCache })
    expect(kept.headers.get("content-security-policy")).toBe("sandbox")
    expect(reads).toHaveLength(1)
    await kept.body?.cancel()
  })

  it("reads storage without edgeCache, and for a transform", async () => {
    const { reads, storage } = memoryStore()
    await storage.put("other.txt", new Blob(["text"], { type: "text/plain" }))
    for (let index = 0; index < 2; index++) {
      const plain = request("/files/other.txt")
      await (await storage.serve(plain.req, "other.txt")).text()
      await plain.settled()
    }
    expect(reads).toHaveLength(2)

    await serveOnce(storage, "other.txt")
    expect(reads).toHaveLength(3)
    const transformed = await storage.serve(request("/files/other.txt").req, "other.txt", { edgeCache, transform: { key: "upper", run: async original => new Blob([(await original.text()).toUpperCase()], { type: "text/plain" }) } })
    expect(await transformed.text()).toBe("TEXT")
    expect(reads.length).toBeGreaterThan(3)
  })
})
