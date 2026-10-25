import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { H3, H3Event } from "h3"
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

  it("serves Nuxt H3 v1 requests with cache validators, HEAD, and byte ranges", async () => {
    const h3 = join(dirname(createRequire(import.meta.resolve("nitropack/package.json")).resolve("h3/package.json")), "dist/index.mjs")
    const { createApp, toWebHandler } = await import(pathToFileURL(h3).href) as {
      createApp: () => { use: (path: string, handler: (event: Parameters<BlobStorage["serve"]>[0]) => unknown) => void }
      toWebHandler: (app: unknown) => (request: Request) => Promise<Response>
    }
    const app = createApp()
    app.use("/photo", async (event) => {
      const [error, body] = await storage.serve(event, "private/original")
      if (error) throw error
      return body
    })
    const fetch = toWebHandler(app)
    const response = await fetch(new Request("https://example.test/photo"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("public:private-camera-data")
    expect(response.headers.get("cache-control")).toBe("private, no-cache")
    const etag = response.headers.get("etag")!
    expect(etag).toBeTruthy()
    for (const condition of [etag, `"unrelated", W/${etag}`, "*"]) {
      const conditional = await fetch(new Request("https://example.test/photo", { headers: { "if-none-match": condition } }))
      expect(conditional.status).toBe(304)
      expect(conditional.headers.get("cache-control")).toBe("private, no-cache")
      expect(await conditional.text()).toBe("")
    }
    const head = await fetch(new Request("https://example.test/photo", { method: "HEAD" }))
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("26")
    expect(await head.text()).toBe("")
    const partial = await fetch(new Request("https://example.test/photo", { headers: { range: "bytes=0-5" } }))
    expect(partial.status).toBe(206)
    expect(await partial.text()).toBe("public")
    const invalid = await fetch(new Request("https://example.test/photo", { headers: { range: "bytes=99-" } }))
    expect(invalid.status).toBe(416)
    expect(await invalid.text()).toBe("")
  })

  it.each([undefined, "bytes=0-9", "bytes=999-"])("serves HEAD from metadata with Range %s", async (range) => {
    const app = new H3().all("/photo", async (request) => {
      const [error, body] = await storage.serve(request, "private/original")
      if (error) throw error
      return body
    })
    const full = await app.fetch(new Request("https://example.test/photo"))
    await full.text()
    const get = vi.spyOn(driver, "get")
    const response = await app.fetch(new Request("https://example.test/photo", {
      method: "HEAD",
      headers: range ? { range } : undefined,
    }))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
    for (const name of ["content-length", "content-type", "etag", "cache-control", "accept-ranges", "x-content-type-options"]) {
      expect(response.headers.get(name), name).toBe(full.headers.get(name))
    }
    expect(response.headers.get("content-range")).toBeNull()
    expect(get).not.toHaveBeenCalled()

    const conditional = await app.fetch(new Request("https://example.test/photo", {
      method: "HEAD",
      headers: { "if-none-match": full.headers.get("etag")! },
    }))
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe("")
    expect(get).not.toHaveBeenCalled()
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

  it.each(["size", "contentType"] as const)("reads the body for HEAD when metadata lacks %s", async (field) => {
    const head = driver.head.bind(driver)
    vi.spyOn(driver, "head").mockImplementation(async (path) => {
      const meta = await head(path)
      return meta ? { ...meta, [field]: undefined } : null
    })
    const get = vi.spyOn(driver, "get")
    const request = event(undefined, "HEAD")
    const [error, body] = await storage.serve(request, "private/original")
    expect(error).toBeNull()
    await body?.cancel()
    expect(request.res.headers.get("content-length")).toBe("26")
    expect(request.res.headers.get("content-type")).toBe("text/plain")
    expect(get).toHaveBeenCalledOnce()
  })

  it("uses the derived size and type for transformed HEAD responses", async () => {
    const request = event(undefined, "HEAD")
    const [error, body] = await storage.serve(request, "private/original", options)
    expect(error).toBeNull()
    await body?.cancel()
    expect(request.res.headers.get("content-length")).toBe("6")
    expect(request.res.headers.get("content-type")).toBe("text/plain")
    expect(run).toHaveBeenCalledOnce()
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

  it("handles conditional GET and HEAD without returning a body", async () => {
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
    await storage.serve(first, "private//original", options)
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
    for (const pathname of ["_vitehub", "_VITEHUB/", "%5Fvitehub", "_vitehub/media/records/forged", path, path.replace("_", "%5F"), path.replaceAll("/", "\\")]) {
      await expect(storage.put(pathname, "forged")).rejects.toThrow("reserved ViteHub namespace")
      await expect(storage.createMultipartUpload(pathname)).rejects.toThrow("reserved ViteHub namespace")
      await expect(storage.resumeMultipartUpload(pathname, "forged-upload")).rejects.toThrow("reserved ViteHub namespace")
    }
    for (const pathname of ["elsewhere/../_vitehub", `elsewhere/../${path}`]) {
      await expect(storage.put(pathname, "forged")).rejects.toMatchObject({ code: "BLOB_R0034" })
      await expect(storage.createMultipartUpload(pathname)).rejects.toMatchObject({ code: "BLOB_R0034" })
      await expect(storage.resumeMultipartUpload(pathname, "forged-upload")).rejects.toMatchObject({ code: "BLOB_R0034" })
    }
    await expect(storage.put("forged", "body", { prefix: "_vitehub/derived" })).rejects.toThrow("reserved ViteHub namespace")
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

describe("Blob byte ranges", () => {
  let directory: string
  let storage: BlobStorage
  const content = "0123456789abcdefghij"

  function event(headers?: Record<string, string>, method = "GET") {
    return new H3Event(new Request("https://example.test/video", { headers, method }))
  }

  async function serve(headers?: Record<string, string>, method?: string, options?: Parameters<BlobStorage["serve"]>[2]) {
    const request = event(headers, method)
    const [error, body] = await storage.serve(request, "media/video.mp4", options)
    expect(error).toBeNull()
    return { request, text: await new Response(body).text() }
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-range-"))
    storage = createBlobStorage(createDriver({ driver: "fs", base: directory }))
    await storage.put("media/video.mp4", content, { contentType: "video/mp4" })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it("advertises byte ranges and sends the whole body without a Range header", async () => {
    const { request, text } = await serve()
    expect(text).toBe(content)
    expect(request.res.status).not.toBe(206)
    expect(request.res.headers.get("accept-ranges")).toBe("bytes")
    expect(request.res.headers.get("content-range")).toBeNull()
  })

  it("returns 206 with the requested bytes", async () => {
    const { request, text } = await serve({ range: "bytes=2-5" })
    expect(request.res.status).toBe(206)
    expect(text).toBe("2345")
    expect(request.res.headers.get("content-range")).toBe("bytes 2-5/20")
    expect(request.res.headers.get("content-length")).toBe("4")
    expect(request.res.headers.get("content-type")).toBe("video/mp4")
  })

  it("accepts a case-insensitive range unit", async () => {
    const { request, text } = await serve({ range: "Bytes=0-1" })
    expect(request.res.status).toBe(206)
    expect(text).toBe("01")
    expect(request.res.headers.get("content-range")).toBe("bytes 0-1/20")
  })

  it("serves open-ended ranges and clamps the end to the body size", async () => {
    const open = await serve({ range: "bytes=15-" })
    expect(open.request.res.status).toBe(206)
    expect(open.text).toBe("fghij")
    expect(open.request.res.headers.get("content-range")).toBe("bytes 15-19/20")
    const clamped = await serve({ range: "bytes=18-100" })
    expect(clamped.text).toBe("ij")
    expect(clamped.request.res.headers.get("content-range")).toBe("bytes 18-19/20")
  })

  it("serves suffix ranges", async () => {
    const { request, text } = await serve({ range: "bytes=-3" })
    expect(request.res.status).toBe(206)
    expect(text).toBe("hij")
    expect(request.res.headers.get("content-range")).toBe("bytes 17-19/20")
    const longer = await serve({ range: "bytes=-50" })
    expect(longer.text).toBe(content)
    expect(longer.request.res.headers.get("content-range")).toBe("bytes 0-19/20")
  })

  it("returns 416 when the range starts past the end", async () => {
    for (const range of ["bytes=20-", "bytes=25-30", "bytes=-0"]) {
      const { request, text } = await serve({ range })
      expect(request.res.status).toBe(416)
      expect(text).toBe("")
      expect(request.res.headers.get("content-range")).toBe("bytes */20")
      expect(request.res.headers.get("content-length")).toBe("0")
    }
  })

  it("sends the whole body for malformed or multiple ranges", async () => {
    for (const range of ["bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=-"]) {
      const { request, text } = await serve({ range })
      expect(request.res.status).not.toBe(206)
      expect(text).toBe(content)
      expect(request.res.headers.get("content-range")).toBeNull()
    }
  })

  it("honors If-Range only when it matches the current ETag", async () => {
    const { request } = await serve()
    const etag = request.res.headers.get("etag")!
    expect(etag).toBeTruthy()
    const matching = await serve({ range: "bytes=0-1", "if-range": etag })
    expect(matching.request.res.status).toBe(206)
    expect(matching.text).toBe("01")
    for (const ifRange of ['"stale"', "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      const stale = await serve({ range: "bytes=0-1", "if-range": ifRange })
      expect(stale.request.res.status).not.toBe(206)
      expect(stale.text).toBe(content)
      expect(stale.request.res.headers.get("content-range")).toBeNull()
    }
  })

  it.each(["bytes=0-9", "bytes=25-30"])("ignores Range %s for HEAD", async (range) => {
    const { request: whole } = await serve(undefined, "HEAD")
    const { request } = await serve({ range }, "HEAD")
    expect(request.res.status).toBe(whole.res.status)
    expect(request.res.headers.get("content-range")).toBeNull()
    expect(request.res.headers.get("content-length")).toBe("20")
    expect(request.res.headers.get("accept-ranges")).toBe("bytes")
  })

  it("ignores Range for transformed responses", async () => {
    const transform = { key: "upper-v1", run: async (original: Blob) => new Blob([(await original.text()).toUpperCase()], { type: "text/plain" }) }
    const { request, text } = await serve({ range: "bytes=0-1" }, "GET", { transform })
    expect(request.res.status).not.toBe(206)
    expect(text).toBe(content.toUpperCase())
    expect(request.res.headers.get("accept-ranges")).toBeNull()
    expect(request.res.headers.get("content-range")).toBeNull()
  })
})
