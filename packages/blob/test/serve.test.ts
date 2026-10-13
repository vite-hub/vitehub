import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3Event } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"
import { createBlobStorage } from "../src/storage.ts"
import type { BlobStorage } from "../src/types.ts"

describe("Blob response transforms", () => {
  let directory: string
  let driver: ReturnType<typeof createDriver>
  let storage: BlobStorage

  function event(headers?: Record<string, string>, method = "GET") {
    return new H3Event(new Request("https://example.test/photo", { headers, method }))
  }

  const run = vi.fn(async (original: Blob) => new Blob([
    (await original.text()).split(":")[0],
  ], { type: "text/plain" }))
  const options = { cacheControl: "public, max-age=300", transform: { key: "public-v1", run } }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-serve-"))
    driver = createDriver({ driver: "fs", base: directory })
    storage = createBlobStorage(driver)
    run.mockClear()
    await storage.put("private/original", "public:private-camera-data", { contentType: "text/plain" })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it("serves normal objects with private cache headers and their stored content type", async () => {
    const request = event()
    const [error, body] = await storage.serve(request, "private/original")
    expect(error).toBeNull()
    expect(await new Response(body).text()).toBe("public:private-camera-data")
    expect(request.res.headers.get("content-type")).toBe("text/plain")
    expect(request.res.headers.get("cache-control")).toBe("private, no-cache")
  })

  it("accepts native HTTP request and response fields without an H3 event", async () => {
    const request = { req: new Request("https://example.test/photo"), res: { headers: new Headers(), status: 200 } }
    const [error, body] = await storage.serve(request, "private/original", options)
    expect(error).toBeNull()
    expect(await new Response(body).text()).toBe("public")
    const conditional = {
      req: new Request("https://example.test/photo", { headers: { "if-none-match": request.res.headers.get("etag")! } }),
      res: { headers: new Headers(), status: 200 },
    }
    const [, response] = await storage.serve(conditional, "private/original", options)
    expect(response).toBeNull()
    expect(conditional.res.status).toBe(304)
  })

  it("revalidates normal reads when another writer replaces the body and content type", async () => {
    const get = driver.get.bind(driver)
    let replace = true
    vi.spyOn(driver, "get").mockImplementation(async (path) => {
      if (replace) {
        replace = false
        await storage.put(path, "updated", { contentType: "text/html" })
      }
      return get(path)
    })
    const request = event()
    const [, body] = await storage.serve(request, "private/original")
    expect(await new Response(body).text()).toBe("updated")
    expect(request.res.headers.get("content-type")).toBe("text/html")
    const fresh = event()
    await storage.serve(fresh, "private/original")
    expect(request.res.headers.get("etag")).toBe(fresh.res.headers.get("etag"))
  })

  it("invalidates normal HTTP validators when identical bytes get a different content type", async () => {
    const first = event()
    await storage.serve(first, "private/original")
    await storage.put("private/original", "public:private-camera-data", { contentType: "text/html" })
    const second = event({ "if-none-match": first.res.headers.get("etag")! })
    const [, body] = await storage.serve(second, "private/original")
    expect(second.res.status).not.toBe(304)
    expect(second.res.headers.get("content-type")).toBe("text/html")
    expect(second.res.headers.get("etag")).not.toBe(first.res.headers.get("etag"))
    expect(await new Response(body).text()).toBe("public:private-camera-data")
  })

  it("caches only the derived body and keeps the original unchanged", async () => {
    for (let count = 0; count < 2; count++) {
      const request = event()
      const [error, body] = await storage.serve(request, "private/original", options)
      expect(error).toBeNull()
      expect(await new Response(body).text()).toBe("public")
      expect(request.res.headers.get("content-length")).toBe("6")
      expect(request.res.headers.get("content-type")).toBe("text/plain")
      expect(request.res.headers.get("cache-control")).toBe("public, max-age=300")
      expect(request.res.headers.get("x-content-type-options")).toBe("nosniff")
    }
    expect(run).toHaveBeenCalledTimes(1)
    const [, original] = await storage.get("private/original")
    expect(await original?.text()).toBe("public:private-camera-data")
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(1)
  })

  it("caches through drivers that reject custom metadata", async () => {
    const put = driver.put.bind(driver)
    vi.spyOn(driver, "put").mockImplementation(async (path, body, settings) => {
      if (Object.keys(settings?.customMetadata ?? {}).length) throw new Error("custom metadata unsupported")
      return put(path, body, settings)
    })
    for (let count = 0; count < 2; count++) {
      const [, body] = await storage.serve(event(), "private/original", options)
      expect(await new Response(body).text()).toBe("public")
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("preserves the configured store access for cached derivatives", async () => {
    const put = driver.put.bind(driver)
    vi.spyOn(driver, "put").mockImplementation(async (path, body, settings) => {
      if (settings?.access) throw new Error("object access differs from store access")
      return put(path, body, settings)
    })
    for (let count = 0; count < 2; count++) {
      const [, body] = await storage.serve(event(), "private/original", options)
      expect(await new Response(body).text()).toBe("public")
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("replaces stale cache entries when a provider forbids overwriting objects", async () => {
    const put = driver.put.bind(driver)
    vi.spyOn(driver, "put").mockImplementation(async (path, body, settings) => {
      if (path.startsWith("_vitehub/derived/") && await driver.head(path)) throw new Error("overwrite forbidden")
      return put(path, body, settings)
    })
    await storage.serve(event(), "private/original", options)
    await driver.delete("private/original")
    await storage.put("private/original", "updated:private")
    for (let count = 0; count < 2; count++) {
      const [, body] = await storage.serve(event(), "private/original", options)
      expect(await new Response(body).text()).toBe("updated")
    }
    expect(run).toHaveBeenCalledTimes(2)
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(1)
  })

  it("backfills filesystem hashes and reuses the persisted file version", async () => {
    const path = "legacy/photo"
    const file = join(directory, path)
    await driver.put(path, "legacy")
    const metadataFile = join(directory, ".vitehub/blob-meta", `${Buffer.from(path).toString("base64url")}.json`)
    const hashFile = join(directory, ".vitehub/blob-hashes", `${Buffer.from(path).toString("base64url")}.json`)
    await rm(hashFile)
    await writeFile(metadataFile, JSON.stringify({ contentType: "text/plain" }))
    const meta = await driver.head(path)
    const backfilled = JSON.parse(await readFile(hashFile, "utf8"))
    expect(backfilled.contentHash).toBe(meta!.httpEtag!.slice(1, -1))
    expect(backfilled.fileVersion).toBeTypeOf("string")
    const before = await stat(hashFile)
    expect((await driver.head(path))!.httpEtag).toBe(meta!.httpEtag)
    expect((await stat(hashFile)).mtimeMs).toBe(before.mtimeMs)
    expect(JSON.parse(await readFile(metadataFile, "utf8"))).toEqual({ contentType: "text/plain" })
    await writeFile(file, "updated")
    expect((await driver.head(path))!.httpEtag).not.toBe(meta!.httpEtag)
    expect(JSON.parse(await readFile(hashFile, "utf8")).contentHash).not.toBe(backfilled.contentHash)
  })

  it("invalidates the derivative when source bytes or the transform key change", async () => {
    const first = event()
    await storage.serve(first, "private/original", options)
    await storage.put("private/original", "updated:private-camera-data")
    const second = event()
    const [, updated] = await storage.serve(second, "private/original", options)
    expect(await new Response(updated).text()).toBe("updated")
    expect(second.res.headers.get("etag")).not.toBe(first.res.headers.get("etag"))
    const third = event()
    await storage.serve(third, "private/original", { ...options, transform: { ...options.transform, key: "public-v2" } })
    expect(third.res.headers.get("etag")).not.toBe(second.res.headers.get("etag"))
    expect(run).toHaveBeenCalledTimes(3)
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    // Source changes replace a variant; distinct transform keys keep distinct variants.
    expect(cache?.blobs).toHaveLength(2)
  })

  it("uses h3 conditional GET and HEAD handling without returning a body", async () => {
    const first = event()
    await storage.serve(first, "private/original", options)
    const etag = first.res.headers.get("etag")!
    for (const method of ["GET", "HEAD"]) {
      const request = event({ "if-none-match": `"other", W/${etag}` }, method)
      const [error, body] = await storage.serve(request, "private/original", options)
      expect(error).toBeNull()
      expect(body).toBeNull()
      expect(request.res.status).toBe(304)
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("does not serve a cached derivative after the source is deleted", async () => {
    const first = event()
    await storage.serve(first, "private/original", options)
    await storage.del("private/original")
    const [error] = await storage.serve(event({ "if-none-match": first.res.headers.get("etag")! }), "private/original", options)
    expect(error?.code).toBe("BLOB_NOT_FOUND")
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(0)
  })

  it("shares and removes filesystem derivatives across pathname aliases", async () => {
    const first = event()
    await storage.serve(first, "alias/../private/original", options)
    const second = event()
    await storage.serve(second, "private/original", options)
    expect(second.res.headers.get("etag")).toBe(first.res.headers.get("etag"))
    expect(run).toHaveBeenCalledTimes(1)
    await storage.del("private/original")
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(0)
  })

  it("rejects public writes and multipart uploads into the derived cache", async () => {
    await storage.serve(event(), "private/original", options)
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    const path = cache!.blobs[0]!.pathname
    for (const pathname of ["_vitehub", "_VITEHUB/", "elsewhere/../_vitehub", "%5Fvitehub", path, `elsewhere/../${path}`, path.replace("_", "%5F"), path.replaceAll("/", "\\")]) {
      await expect(storage.put(pathname, "forged")).rejects.toThrow("reserved derived cache")
      await expect(storage.createMultipartUpload(pathname)).rejects.toThrow("reserved derived cache")
      await expect(storage.resumeMultipartUpload(pathname, "forged-upload")).rejects.toThrow("reserved derived cache")
    }
    await expect(storage.put("forged", "body", { prefix: "_vitehub/derived" })).rejects.toThrow("reserved derived cache")
    const [, body] = await storage.serve(event(), "private/original", options)
    expect(await new Response(body).text()).toBe("public")
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each(["_vitehub", "_vitehub/derived"])("serves fresh derivatives when legacy file %s blocks caching", async (pathname) => {
    await driver.put(pathname, "legacy data")
    const warning = vi.spyOn(console, "error").mockImplementation(() => {})
    for (let count = 0; count < 2; count++) {
      const [error, body] = await storage.serve(event(), "private/original", options)
      expect(error).toBeNull()
      expect(await new Response(body).text()).toBe("public")
    }
    expect(run).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledTimes(2)
    expect(await (await driver.get(pathname))?.text()).toBe("legacy data")
    expect(await driver.head(`${pathname}/missing`)).toBeNull()
    expect(await driver.get(`${pathname}/missing`)).toBeNull()
  })

  it("detects same-size filesystem changes even when the modification date is restored", async () => {
    const path = join(directory, "private/original")
    const date = new Date("2026-01-01T00:00:00.000Z")
    await writeFile(path, "first:private")
    await utimes(path, date, date)
    const first = event()
    await storage.serve(first, "private/original", options)
    await writeFile(path, "later:private")
    await utimes(path, date, date)
    const second = event({ "if-none-match": first.res.headers.get("etag")! })
    const [, body] = await storage.serve(second, "private/original", options)
    expect(second.res.status).not.toBe(304)
    expect(await new Response(body).text()).toBe("later")
    expect(second.res.headers.get("etag")).not.toBe(first.res.headers.get("etag"))
  })

  it("hashes source bytes when the driver has no ETag", async () => {
    const head = driver.head.bind(driver)
    vi.spyOn(driver, "head").mockImplementation(async (path) => {
      const meta = await head(path)
      return meta ? { ...meta, httpEtag: undefined, uploadedAt: new Date(0) } : null
    })
    const first = event()
    await storage.serve(first, "private/original", options)
    await storage.put("private/original", "updated:private-camera-data")
    const second = event({ "if-none-match": first.res.headers.get("etag")! })
    const [, body] = await storage.serve(second, "private/original", options)
    expect(second.res.status).not.toBe(304)
    expect(await new Response(body).text()).toBe("updated")
  })

  it("uses stable ETags when a provider synthesizes upload timestamps", async () => {
    const head = driver.head.bind(driver)
    let time = 0
    vi.spyOn(driver, "head").mockImplementation(async (path) => {
      const meta = await head(path)
      return meta ? { ...meta, uploadedAt: new Date(time++) } : null
    })
    for (let count = 0; count < 2; count++) {
      const [, body] = await storage.serve(event(), "private/original", options)
      expect(await new Response(body).text()).toBe("public")
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("retries a replaced source so the response body and ETag describe the same version", async () => {
    const get = driver.get.bind(driver)
    let replace = true
    vi.spyOn(driver, "get").mockImplementation(async (path) => {
      if (path === "private/original" && replace) {
        replace = false
        await storage.put(path, "updated:private")
      }
      return get(path)
    })
    const first = event()
    const [, body] = await storage.serve(first, "private/original", options)
    expect(await new Response(body).text()).toBe("updated")
    const second = event()
    const [, cached] = await storage.serve(second, "private/original", options)
    expect(await new Response(cached).text()).toBe("updated")
    expect(first.res.headers.get("etag")).toBe(second.res.headers.get("etag"))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("does not recreate a derivative after the source is deleted during transformation", async () => {
    let started!: () => void
    let finish!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const pending = storage.serve(event(), "private/original", {
      transform: { key: "slow", async run() {
        started()
        await new Promise<void>(resolve => { finish = resolve })
        return new Blob(["public"])
      } },
    })
    await ready
    await storage.del("private/original")
    finish()
    await pending
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(0)
  })

  it("removes a derivative if deletion finishes while its cache write is in flight", async () => {
    const put = driver.put.bind(driver)
    let started!: () => void
    let finish!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(driver, "put").mockImplementationOnce(async (...args) => {
      started()
      await new Promise<void>(resolve => { finish = resolve })
      return put(...args)
    })
    const pending = storage.serve(event(), "private/original", options)
    await ready
    await storage.del("private/original")
    finish()
    await pending
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(0)
  })

  it("shares an in-flight transformation between concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => storage.serve(event(), "private/original", options)))
    for (const [error, body] of results) {
      expect(error).toBeNull()
      expect(await new Response(body).text()).toBe("public")
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("keeps concurrent source versions separate when they change before cache validation", async () => {
    let started!: () => void
    let finish!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const transform = { key: "concurrent", async run(original: Blob) {
      const text = await original.text()
      if (text.startsWith("public:")) {
        started()
        await new Promise<void>(resolve => { finish = resolve })
      }
      return new Blob([text.split(":")[0]])
    } }
    const older = storage.serve(event(), "private/original", { transform })
    await ready
    await storage.put("private/original", "updated:private")
    const [, newer] = await storage.serve(event(), "private/original", { transform })
    expect(await new Response(newer).text()).toBe("updated")
    finish()
    await older
    const [, cached] = await storage.serve(event(), "private/original", { transform })
    expect(await new Response(cached).text()).toBe("updated")
  })

  it("recomputes the current version after a cross-runtime cache replacement race", async () => {
    await storage.serve(event(), "private/original", options)
    await storage.put("private/original", "older:private")
    const otherRuntime = createBlobStorage(driver)
    const remove = driver.delete.bind(driver)
    let started!: () => void
    let finish!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(driver, "delete").mockImplementationOnce(async (paths) => {
      started()
      await new Promise<void>(resolve => { finish = resolve })
      return remove(paths)
    })
    const older = storage.serve(event(), "private/original", options)
    await ready
    await otherRuntime.put("private/original", "newer:private")
    const [, newer] = await otherRuntime.serve(event(), "private/original", options)
    expect(await new Response(newer).text()).toBe("newer")
    finish()
    await older
    const [, fresh] = await otherRuntime.serve(event(), "private/original", options)
    expect(await new Response(fresh).text()).toBe("newer")
    expect(run).toHaveBeenCalledTimes(4)
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(1)
  })

  it("returns transformation failures through the Blob error contract", async () => {
    const request = event()
    const [error] = await storage.serve(request, "private/original", {
      cacheControl: "public, max-age=300",
      transform: { key: "failing", run() { throw new Error("private transform detail") } },
    })
    expect(error).toMatchObject({ code: "BLOB_OPERATION_FAILED", details: { operation: "serve" } })
    expect(error?.message).not.toContain("private transform detail")
    expect(request.res.headers.get("cache-control")).toBeNull()
    expect(request.res.headers.get("etag")).toBeNull()
  })

  it("leaves caller headers unchanged when a source read fails", async () => {
    vi.spyOn(driver, "get").mockRejectedValue(new Error("storage unavailable"))
    const request = event()
    request.res.headers.set("cache-control", "private, no-store")
    const [error] = await storage.serve(request, "private/original", options)
    expect(error?.code).toBe("BLOB_OPERATION_FAILED")
    expect(request.res.headers.get("cache-control")).toBe("private, no-store")
    expect(request.res.headers.get("etag")).toBeNull()
  })

  it("validates content headers before committing the public cache policy", async () => {
    const head = driver.head.bind(driver)
    vi.spyOn(driver, "head").mockImplementation(async path => {
      const meta = await head(path)
      return meta ? { ...meta, contentType: "text/plain\ninvalid" } : null
    })
    const request = event()
    const [error] = await storage.serve(request, "private/original", { cacheControl: "public, max-age=300" })
    expect(error?.code).toBe("BLOB_OPERATION_FAILED")
    expect(request.res.headers.get("cache-control")).toBeNull()
    expect(request.res.headers.get("etag")).toBeNull()
  })

  it("serves a fresh derivative when reading the cache fails", async () => {
    const get = driver.get.bind(driver)
    const failure = new Error("Cache read unavailable")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "get").mockImplementation(async pathname => {
      if (pathname.startsWith("_vitehub/derived/")) throw failure
      return get(pathname)
    })

    const request = event()
    const [error, body] = await storage.serve(request, "private/original", options)
    expect(error).toBeNull()
    expect(await new Response(body).text()).toBe("public")
    expect(run).toHaveBeenCalledTimes(1)
    expect(request.res.headers.get("cache-control")).toBe(options.cacheControl)
    expect(log).toHaveBeenCalledWith("[vitehub/blob] Transform cache read failed", failure)
  })

  it("serves the fresh derivative even when caching fails", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "put").mockRejectedValue(new Error("storage unavailable"))
    const [error, body] = await storage.serve(event(), "private/original", options)
    expect(error).toBeNull()
    expect(await new Response(body).text()).toBe("public")
    expect(warning).toHaveBeenCalledOnce()
  })

  it("keeps the original deleted when derived-cache cleanup fails", async () => {
    await storage.serve(event(), "private/original", options)
    const warning = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "list").mockRejectedValue(new Error("cache listing unavailable"))
    const [error] = await storage.del("private/original")
    expect(error).toBeNull()
    expect(await driver.head("private/original")).toBeNull()
    expect(warning).toHaveBeenCalledOnce()
  })
})
