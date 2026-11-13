import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver as createR2Driver } from "../src/drivers/cloudflare.ts"
import { createDriver } from "../src/drivers/fs.ts"
import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "../src/runtime/state.ts"
import { createBlobStorage } from "../src/storage.ts"
import type { BlobStorage } from "../src/types.ts"

describe("Blob response transforms", () => {
  let directory: string
  let driver: ReturnType<typeof createDriver>
  let storage: BlobStorage

  function request(headers?: Record<string, string>, method = "GET") {
    return new Request("https://example.test/photo", { headers, method })
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
    const response = await storage.serve(request(), "private/original")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("public:private-camera-data")
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(response.headers.get("cache-control")).toBe("private, no-cache")
  })

  it("reads Cache-Control from the headers option when cacheControl is not set", async () => {
    const response = await storage.serve(request(), "private/original", { headers: { "cache-control": "public, max-age=60" } })
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
    await response.body?.cancel()
  })

  it("adds the headers option only to responses that serve the object", async () => {
    const headers = { "X-Frame-Options": "DENY", "Content-Type": "text/html" }
    const served = await storage.serve(request(), "private/original", { headers })
    expect(served.headers.get("x-frame-options")).toBe("DENY")
    // The headers that serve() sets replace the option.
    expect(served.headers.get("content-type")).toBe("text/plain")
    await served.body?.cancel()

    const etag = served.headers.get("etag")!
    const conditional = await storage.serve(request({ "if-none-match": etag }), "private/original", { headers })
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get("x-frame-options")).toBe("DENY")
    expect(conditional.headers.get("content-type")).toBeNull()

    const missing = await storage.serve(request(), "private/missing", { headers })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Blob not found." })
    expect(missing.headers.has("x-frame-options")).toBe(false)
  })

  it("serves H3 requests with cache validators, HEAD, and byte ranges", async () => {
    const app = new H3().all("/photo", event => storage.serve(event.req, "private/original"))
    const fetch = (request: Request) => app.fetch(request)
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

  it("adds the headers that H3 middleware sets once", async () => {
    const app = new H3()
      .use((event) => {
        event.res.headers.append("set-cookie", "a=1; Path=/")
        event.res.headers.append("set-cookie", "b=2; Path=/")
        event.res.headers.set("x-middleware", "yes")
      })
      .all("/photo", event => storage.serve(event.req, "private/original"))
    const response = await app.fetch(new Request("https://example.test/photo"))
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])
    expect(response.headers.get("x-middleware")).toBe("yes")
    expect(await response.text()).toBe("public:private-camera-data")
  })

  it.each([undefined, "bytes=0-9", "bytes=999-"])("serves HEAD from metadata with Range %s", async (range) => {
    const app = new H3().all("/photo", event => storage.serve(event.req, "private/original"))
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

  it("leaves the Standard Context of the request unchanged", async () => {
    const res = { headers: new Headers({ "x-caller": "kept" }), status: 200 }
    const withContext = Object.assign(new Request("https://example.test/photo", { headers: { range: "bytes=0-5" } }), {
      "~standard": { vendor: "host", req: new Request("https://example.test/photo"), res },
    })
    const response = await storage.serve(withContext, "private/original", options)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("public")
    expect(res.status).toBe(200)
    expect([...res.headers]).toEqual([["x-caller", "kept"]])
  })

  it.each(["missing", "read failure", "invalid pathname"])("does not add the headers option after a failed serve: %s", async (failure) => {
    if (failure === "read failure") vi.spyOn(driver, "get").mockRejectedValue(new Error("storage unavailable"))
    const result = storage.serve(request(), failure === "missing" ? "missing.txt" : failure === "invalid pathname" ? "../private/original" : "private/original", {
      headers: { "X-Frame-Options": "SAMEORIGIN", "Set-Cookie": "session=temporary; Path=/" },
    })
    if (failure === "read failure") {
      await expect(result).rejects.toMatchObject({ code: "BLOB_OPERATION_FAILED" })
      return
    }
    const response = await result
    expect(response.status).toBe(failure === "missing" ? 404 : 400)
    expect(response.headers.get("x-frame-options")).toBeNull()
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it.each(["size", "contentType"] as const)("reads the body for HEAD when metadata lacks %s", async (field) => {
    const head = driver.head.bind(driver)
    vi.spyOn(driver, "head").mockImplementation(async (path) => {
      const meta = await head(path)
      return meta ? { ...meta, [field]: undefined } : null
    })
    const get = vi.spyOn(driver, "get")
    const response = await storage.serve(request(undefined, "HEAD"), "private/original")
    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get("content-length")).toBe("26")
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(get).toHaveBeenCalledOnce()
  })

  it("uses the derived size and type for transformed HEAD responses", async () => {
    const response = await storage.serve(request(undefined, "HEAD"), "private/original", options)
    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get("content-length")).toBe("6")
    expect(response.headers.get("content-type")).toBe("text/plain")
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
    const response = await storage.serve(request(), "private/original")
    expect(await response.text()).toBe("updated")
    expect(response.headers.get("content-type")).toBe("text/html")
    const fresh = await storage.serve(request(), "private/original")
    await fresh.body?.cancel()
    expect(response.headers.get("etag")).toBe(fresh.headers.get("etag"))
  })

  it("invalidates normal HTTP validators when identical bytes get a different content type", async () => {
    const first = await storage.serve(request(), "private/original")
    await first.body?.cancel()
    await storage.put("private/original", "public:private-camera-data", { contentType: "text/html" })
    const second = await storage.serve(request({ "if-none-match": first.headers.get("etag")! }), "private/original")
    expect(second.status).toBe(200)
    expect(second.headers.get("content-type")).toBe("text/html")
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"))
    expect(await second.text()).toBe("public:private-camera-data")
  })

  it("caches only the derived body and keeps the original unchanged", async () => {
    for (let count = 0; count < 2; count++) {
      const response = await storage.serve(request(), "private/original", options)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("public")
      expect(response.headers.get("content-length")).toBe("6")
      expect(response.headers.get("content-type")).toBe("text/plain")
      expect(response.headers.get("cache-control")).toBe("public, max-age=300")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
    expect(run).toHaveBeenCalledTimes(1)
    const [, original] = await storage.get("private/original")
    expect(await original?.text()).toBe("public:private-camera-data")
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(1)
  })

  it.each(["x".repeat(8192), "€".repeat(3000)])("reuses and inspects cached transforms with long keys (%#)", async (key) => {
    const settings = { transform: { key, run } }
    const app = new H3().all("/photo", event => storage.serve(event.req, "private/original", settings))
    for (let count = 0; count < 2; count++) {
      const response = await app.fetch(new Request("https://example.test/photo"))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/plain")
      expect(response.headers.get("content-length")).toBe("6")
      expect(await response.text()).toBe("public")
      storage = createBlobStorage(createDriver({ driver: "fs", base: directory }))
    }
    expect.soft(run).toHaveBeenCalledOnce()
    const [error, variants] = await storage.media.variants("private/original")
    expect(error).toBeUndefined()
    expect(variants).toHaveLength(1)
    expect(variants?.[0]).toMatchObject({ contentType: "text/plain", key, size: 6 })
  })

  it.each(["not-json\npayload", '{"type":"text/plain"}'])("regenerates damaged cache headers (%#)", async (damaged) => {
    const first = await storage.serve(request(), "private/original", options)
    await first.body?.cancel()
    const cache = await driver.list({ prefix: "_vitehub/derived/" })
    await driver.put(cache.blobs[0]!.pathname, damaged)

    const [, variants] = await storage.media.variants("private/original")
    expect(variants?.[0]?.size).toBe(new TextEncoder().encode(damaged).length)
    const response = await storage.serve(request(), "private/original", options)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("public")
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("caches through drivers that reject custom metadata", async () => {
    const put = driver.put.bind(driver)
    vi.spyOn(driver, "put").mockImplementation(async (path, body, settings) => {
      if (Object.keys(settings?.customMetadata ?? {}).length) throw new Error("custom metadata unsupported")
      return put(path, body, settings)
    })
    for (let count = 0; count < 2; count++) {
      const response = await storage.serve(request(), "private/original", options)
      expect(await response.text()).toBe("public")
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
      const response = await storage.serve(request(), "private/original", options)
      expect(await response.text()).toBe("public")
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("replaces stale cache entries when a provider forbids overwriting objects", async () => {
    const put = driver.put.bind(driver)
    vi.spyOn(driver, "put").mockImplementation(async (path, body, settings) => {
      if (path.startsWith("_vitehub/derived/") && await driver.head(path)) throw new Error("overwrite forbidden")
      return put(path, body, settings)
    })
    await (await storage.serve(request(), "private/original", options)).body?.cancel()
    await driver.delete("private/original")
    await storage.put("private/original", "updated:private")
    for (let count = 0; count < 2; count++) {
      const response = await storage.serve(request(), "private/original", options)
      expect(await response.text()).toBe("updated")
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
    const first = await storage.serve(request(), "private/original", options)
    await first.body?.cancel()
    await storage.put("private/original", "updated:private-camera-data")
    const second = await storage.serve(request(), "private/original", options)
    expect(await second.text()).toBe("updated")
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"))
    const third = await storage.serve(request(), "private/original", { ...options, transform: { ...options.transform, key: "public-v2" } })
    await third.body?.cancel()
    expect(third.headers.get("etag")).not.toBe(second.headers.get("etag"))
    expect(run).toHaveBeenCalledTimes(3)
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    // Source changes replace a variant; distinct transform keys keep distinct variants.
    expect(cache?.blobs).toHaveLength(2)
  })

  it("handles conditional GET and HEAD without returning a body", async () => {
    const first = await storage.serve(request(), "private/original", options)
    await first.body?.cancel()
    const etag = first.headers.get("etag")!
    for (const method of ["GET", "HEAD"]) {
      const response = await storage.serve(request({ "if-none-match": `"other", W/${etag}` }, method), "private/original", options)
      expect(response.status).toBe(304)
      expect(response.body).toBeNull()
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("answers 404 with a JSON body for a missing object", async () => {
    const app = new H3().get("/files/**", event => storage.serve(event.req, "missing.txt"))
    const response = await app.fetch(new Request("https://example.test/files/missing.txt"))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Blob not found." })
  })

  it("does not serve a cached derivative after the source is deleted", async () => {
    const first = await storage.serve(request(), "private/original", options)
    await first.body?.cancel()
    await storage.delete("private/original")
    const response = await storage.serve(request({ "if-none-match": first.headers.get("etag")! }), "private/original", options)
    expect(response.status).toBe(404)
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(0)
  })

  it("shares and removes filesystem derivatives across pathname aliases", async () => {
    const first = await storage.serve(request(), "private//original", options)
    await first.body?.cancel()
    const second = await storage.serve(request(), "private/original", options)
    await second.body?.cancel()
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"))
    expect(run).toHaveBeenCalledTimes(1)
    await storage.delete("private/original")
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(0)
  })

  it("rejects public writes and multipart uploads into the derived cache", async () => {
    await (await storage.serve(request(), "private/original", options)).body?.cancel()
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
    const response = await storage.serve(request(), "private/original", options)
    expect(await response.text()).toBe("public")
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each(["_vitehub", "_vitehub/derived"])("serves fresh derivatives when legacy file %s blocks caching", async (pathname) => {
    await driver.put(pathname, "legacy data")
    const warning = vi.spyOn(console, "error").mockImplementation(() => {})
    for (let count = 0; count < 2; count++) {
      const response = await storage.serve(request(), "private/original", options)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("public")
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
    const first = await storage.serve(request(), "private/original", options)
    await first.body?.cancel()
    await writeFile(path, "later:private")
    await utimes(path, date, date)
    const second = await storage.serve(request({ "if-none-match": first.headers.get("etag")! }), "private/original", options)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe("later")
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"))
  })

  it("hashes source bytes when the driver has no ETag", async () => {
    const head = driver.head.bind(driver)
    vi.spyOn(driver, "head").mockImplementation(async (path) => {
      const meta = await head(path)
      return meta ? { ...meta, httpEtag: undefined, uploadedAt: new Date(0) } : null
    })
    const first = await storage.serve(request(), "private/original", options)
    await first.body?.cancel()
    await storage.put("private/original", "updated:private-camera-data")
    const second = await storage.serve(request({ "if-none-match": first.headers.get("etag")! }), "private/original", options)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe("updated")
  })

  it("uses stable ETags when a provider synthesizes upload timestamps", async () => {
    const head = driver.head.bind(driver)
    let time = 0
    vi.spyOn(driver, "head").mockImplementation(async (path) => {
      const meta = await head(path)
      return meta ? { ...meta, uploadedAt: new Date(time++) } : null
    })
    for (let count = 0; count < 2; count++) {
      const response = await storage.serve(request(), "private/original", options)
      expect(await response.text()).toBe("public")
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
    const first = await storage.serve(request(), "private/original", options)
    expect(await first.text()).toBe("updated")
    const second = await storage.serve(request(), "private/original", options)
    expect(await second.text()).toBe("updated")
    expect(first.headers.get("etag")).toBe(second.headers.get("etag"))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("does not recreate a derivative after the source is deleted during transformation", async () => {
    let started!: () => void
    let finish!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const pending = storage.serve(request(), "private/original", {
      transform: { key: "slow", async run() {
        started()
        await new Promise<void>(resolve => { finish = resolve })
        return new Blob(["public"])
      } },
    })
    await ready
    await storage.delete("private/original")
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
    const pending = storage.serve(request(), "private/original", options)
    await ready
    await storage.delete("private/original")
    finish()
    await pending
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(0)
  })

  it("shares an in-flight transformation between concurrent requests", async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => storage.serve(request(), "private/original", options)))
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("public")
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
    const older = storage.serve(request(), "private/original", { transform })
    await ready
    await storage.put("private/original", "updated:private")
    const newer = await storage.serve(request(), "private/original", { transform })
    expect(await newer.text()).toBe("updated")
    finish()
    await (await older).body?.cancel()
    const cached = await storage.serve(request(), "private/original", { transform })
    expect(await cached.text()).toBe("updated")
  })

  it("recomputes the current version after a cross-runtime cache replacement race", async () => {
    await (await storage.serve(request(), "private/original", options)).body?.cancel()
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
    const older = storage.serve(request(), "private/original", options)
    await ready
    await otherRuntime.put("private/original", "newer:private")
    const newer = await otherRuntime.serve(request(), "private/original", options)
    expect(await newer.text()).toBe("newer")
    finish()
    await (await older).body?.cancel()
    const fresh = await otherRuntime.serve(request(), "private/original", options)
    expect(await fresh.text()).toBe("newer")
    expect(run).toHaveBeenCalledTimes(4)
    const [, cache] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(cache?.blobs).toHaveLength(1)
  })

  it("throws transformation failures as Blob errors without their detail", async () => {
    const result = storage.serve(request(), "private/original", {
      cacheControl: "public, max-age=300",
      transform: { key: "failing", run() { throw new Error("private transform detail") } },
    })
    await expect(result).rejects.toMatchObject({ code: "BLOB_OPERATION_FAILED", why: expect.stringMatching(/^The Blob serve operation failed on the ".+" store\.$/) })
    await expect(result).rejects.not.toThrow("private transform detail")
  })

  it("throws a source read failure as a Blob error", async () => {
    vi.spyOn(driver, "get").mockRejectedValue(new Error("storage unavailable"))
    await expect(storage.serve(request(), "private/original", options)).rejects.toMatchObject({ code: "BLOB_OPERATION_FAILED" })
  })

  it("validates content headers before committing the public cache policy", async () => {
    const head = driver.head.bind(driver)
    vi.spyOn(driver, "head").mockImplementation(async path => {
      const meta = await head(path)
      return meta ? { ...meta, contentType: "text/plain\ninvalid" } : null
    })
    await expect(storage.serve(request(), "private/original", { cacheControl: "public, max-age=300" })).rejects.toMatchObject({ code: "BLOB_OPERATION_FAILED" })
  })

  it("serves a fresh derivative when reading the cache fails", async () => {
    const get = driver.get.bind(driver)
    const failure = new Error("Cache read unavailable")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "get").mockImplementation(async pathname => {
      if (pathname.startsWith("_vitehub/derived/")) throw failure
      return get(pathname)
    })

    const response = await storage.serve(request(), "private/original", options)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("public")
    expect(run).toHaveBeenCalledTimes(1)
    expect(response.headers.get("cache-control")).toBe(options.cacheControl)
    expect(log).toHaveBeenCalledWith("[vitehub/blob] Transform cache read failed", failure)
  })

  it("serves the fresh derivative even when caching fails", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "put").mockRejectedValue(new Error("storage unavailable"))
    const response = await storage.serve(request(), "private/original", options)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("public")
    expect(warning).toHaveBeenCalledOnce()
  })

  it("keeps the original deleted when derived-cache cleanup fails", async () => {
    await (await storage.serve(request(), "private/original", options)).body?.cancel()
    const warning = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "list").mockRejectedValue(new Error("cache listing unavailable"))
    const [error] = await storage.delete("private/original")
    expect(error).toBeUndefined()
    expect(await driver.head("private/original")).toBeNull()
    expect(warning).toHaveBeenCalledOnce()
  })
})

describe("Blob responses for types that a browser opens as a page", () => {
  let directory: string
  let storage: BlobStorage

  function request(headers?: Record<string, string>, method = "GET") {
    return new Request("https://example.test/file", { headers, method })
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-active-"))
    storage = createBlobStorage(createDriver({ driver: "fs", base: directory }))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    "text/html",
    "Text/HTML; charset=utf-8",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/xml",
    "application/xml",
    "application/rss+xml",
    "text/xsl",
    "image/png, text/html",
    "image/png,image/svg+xml",
    "text/html (comment)",
    "text/html extra",
    "multipart/x-mixed-replace; boundary=b",
    "multipart/mixed; boundary=b",
    "Multipart/Byteranges; boundary=b",
    "image/png,multipart/x-mixed-replace;boundary=b",
  ])("serves %s in a CSP sandbox on GET, HEAD, 206, and 304", async (contentType) => {
    await storage.put("uploads/file", "content", { contentType })

    const served = await storage.serve(request(), "uploads/file")
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe(contentType)
    expect(served.headers.get("content-security-policy")).toBe("sandbox")
    expect(served.headers.get("x-content-type-options")).toBe("nosniff")
    expect(served.headers.get("content-disposition")).toBeNull()
    expect(await served.text()).toBe("content")

    const head = await storage.serve(request(undefined, "HEAD"), "uploads/file")
    expect(head.headers.get("content-security-policy")).toBe("sandbox")

    const range = await storage.serve(request({ range: "bytes=0-1" }), "uploads/file")
    expect(range.status).toBe(206)
    expect(range.headers.get("content-security-policy")).toBe("sandbox")
    await range.body?.cancel()

    const conditional = await storage.serve(request({ "if-none-match": served.headers.get("etag")! }), "uploads/file")
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get("content-security-policy")).toBe("sandbox")
  })

  it("serves a type guessed from the pathname in a CSP sandbox", async () => {
    await storage.put("uploads/page.html", "content")
    const served = await storage.serve(request(), "uploads/page.html")
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(served.headers.get("content-security-policy")).toBe("sandbox")
    await served.body?.cancel()
  })

  it.each(["image/png", "text/plain", "application/pdf", "video/mp4", "application/json"])("sends no CSP for %s", async (contentType) => {
    await storage.put("uploads/file", "content", { contentType })
    const served = await storage.serve(request(), "uploads/file")
    expect(served.headers.get("content-security-policy")).toBeNull()
    await served.body?.cancel()
  })

  it("adds the sandbox to a CSP from the headers option and does not let it replace the sandbox", async () => {
    await storage.put("uploads/file.svg", "content", { contentType: "image/svg+xml" })
    const served = await storage.serve(request(), "uploads/file.svg", { headers: { "Content-Security-Policy": "default-src 'self'" } })
    expect(served.headers.get("content-security-policy")).toBe("default-src 'self', sandbox")
    await served.body?.cancel()
  })

  it("serves a transform result by its own type", async () => {
    await storage.put("uploads/source.txt", "content", { contentType: "text/plain" })
    const served = await storage.serve(request(), "uploads/source.txt", {
      transform: { key: "as-svg", run: async original => new Blob([await original.text()], { type: "image/svg+xml" }) },
    })
    expect(served.headers.get("content-type")).toBe("image/svg+xml")
    expect(served.headers.get("content-security-policy")).toBe("sandbox")
    await served.body?.cancel()
  })

  it("keeps the sandbox on a 304 for a transform result, with a CSP from the headers option", async () => {
    await storage.put("uploads/source.txt", "content", { contentType: "text/plain" })
    const options = {
      headers: { "Content-Security-Policy": "default-src 'self'" },
      transform: { key: "as-html", run: async (original: Blob) => new Blob([await original.text()], { type: "text/html" }) },
    }
    const served = await storage.serve(request(), "uploads/source.txt", options)
    expect(served.headers.get("content-security-policy")).toBe("default-src 'self', sandbox")
    await served.body?.cancel()

    // A 304 replaces the headers that a cache stored. The output type is not known before the transform runs.
    for (const method of ["GET", "HEAD"]) {
      const conditional = await storage.serve(request({ "if-none-match": served.headers.get("etag")! }, method), "uploads/source.txt", options)
      expect(conditional.status).toBe(304)
      expect(conditional.headers.get("content-security-policy")).toBe("default-src 'self', sandbox")
    }
  })

  it("sends Content-Disposition: attachment with the pathname file name for download: true", async () => {
    await storage.put("reports/2026/summary.pdf", "content", { contentType: "application/pdf" })
    const served = await storage.serve(request(), "reports/2026/summary.pdf", { download: true })
    expect(served.headers.get("content-disposition")).toBe("attachment; filename=\"summary.pdf\"; filename*=UTF-8''summary.pdf")
    await served.body?.cancel()

    const conditional = await storage.serve(request({ "if-none-match": served.headers.get("etag")! }), "reports/2026/summary.pdf", { download: true })
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get("content-disposition")).toBe(served.headers.get("content-disposition"))
  })

  it("writes a safe file name for download: string", async () => {
    await storage.put("uploads/file", "content", { contentType: "text/html" })
    const download = async (name: string) => {
      const served = await storage.serve(request(), "uploads/file", { download: name })
      await served.body?.cancel()
      return served.headers.get("content-disposition")
    }
    expect(await download("Résumé (final).html")).toBe("attachment; filename=\"R_sum_ (final).html\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%28final%29.html")
    expect(await download("a\"b\r\nc.txt")).toBe("attachment; filename=\"a_bc.txt\"; filename*=UTF-8''a%22bc.txt")
    expect(await download("../../etc/report.txt")).toBe("attachment; filename=\"report.txt\"; filename*=UTF-8''report.txt")
    expect(await download("..\\..\\report.txt")).toBe("attachment; filename=\"report.txt\"; filename*=UTF-8''report.txt")
    expect(await download("")).toBe("attachment; filename=\"file\"; filename*=UTF-8''file")
    expect(await download("a\uD800.txt")).toBe("attachment; filename=\"a_.txt\"; filename*=UTF-8''a%EF%BF%BD.txt")
  })
})

describe("Blob byte ranges", () => {
  let directory: string
  let storage: BlobStorage
  const content = "0123456789abcdefghij"

  async function serve(headers?: Record<string, string>, method = "GET", options?: Parameters<BlobStorage["serve"]>[2]) {
    const response = await storage.serve(new Request("https://example.test/video", { headers, method }), "media/video.mp4", options)
    return { response, text: await response.text() }
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
    const { response, text } = await serve()
    expect(text).toBe(content)
    expect(response.status).toBe(200)
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("content-range")).toBeNull()
  })

  it("returns 206 with the requested bytes", async () => {
    const { response, text } = await serve({ range: "bytes=2-5" })
    expect(response.status).toBe(206)
    expect(text).toBe("2345")
    expect(response.headers.get("content-range")).toBe("bytes 2-5/20")
    expect(response.headers.get("content-length")).toBe("4")
    expect(response.headers.get("content-type")).toBe("video/mp4")
  })

  it("accepts a case-insensitive range unit", async () => {
    const { response, text } = await serve({ range: "Bytes=0-1" })
    expect(response.status).toBe(206)
    expect(text).toBe("01")
    expect(response.headers.get("content-range")).toBe("bytes 0-1/20")
  })

  it("serves open-ended ranges and clamps the end to the body size", async () => {
    const open = await serve({ range: "bytes=15-" })
    expect(open.response.status).toBe(206)
    expect(open.text).toBe("fghij")
    expect(open.response.headers.get("content-range")).toBe("bytes 15-19/20")
    const clamped = await serve({ range: "bytes=18-100" })
    expect(clamped.text).toBe("ij")
    expect(clamped.response.headers.get("content-range")).toBe("bytes 18-19/20")
  })

  it("serves suffix ranges", async () => {
    const { response, text } = await serve({ range: "bytes=-3" })
    expect(response.status).toBe(206)
    expect(text).toBe("hij")
    expect(response.headers.get("content-range")).toBe("bytes 17-19/20")
    const longer = await serve({ range: "bytes=-50" })
    expect(longer.text).toBe(content)
    expect(longer.response.headers.get("content-range")).toBe("bytes 0-19/20")
  })

  it("returns 416 when the range starts past the end", async () => {
    for (const range of ["bytes=20-", "bytes=25-30", "bytes=-0"]) {
      const { response, text } = await serve({ range })
      expect(response.status).toBe(416)
      expect(text).toBe("")
      expect(response.headers.get("content-range")).toBe("bytes */20")
      expect(response.headers.get("content-length")).toBe("0")
    }
  })

  it("sends the whole body for malformed or multiple ranges", async () => {
    for (const range of ["bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=-"]) {
      const { response, text } = await serve({ range })
      expect(response.status).toBe(200)
      expect(text).toBe(content)
      expect(response.headers.get("content-range")).toBeNull()
    }
  })

  it("honors If-Range only when it matches the current ETag", async () => {
    const { response } = await serve()
    const etag = response.headers.get("etag")!
    expect(etag).toBeTruthy()
    const matching = await serve({ range: "bytes=0-1", "if-range": etag })
    expect(matching.response.status).toBe(206)
    expect(matching.text).toBe("01")
    for (const ifRange of ['"stale"', "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      const stale = await serve({ range: "bytes=0-1", "if-range": ifRange })
      expect(stale.response.status).not.toBe(206)
      expect(stale.text).toBe(content)
      expect(stale.response.headers.get("content-range")).toBeNull()
    }
  })

  it.each(["bytes=0-9", "bytes=25-30"])("ignores Range %s for HEAD", async (range) => {
    const { response: whole } = await serve(undefined, "HEAD")
    const { response } = await serve({ range }, "HEAD")
    expect(response.status).toBe(whole.status)
    expect(response.headers.get("content-range")).toBeNull()
    expect(response.headers.get("content-length")).toBe("20")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
  })

  it("ignores Range for transformed responses", async () => {
    const transform = { key: "upper-v1", run: async (original: Blob) => new Blob([(await original.text()).toUpperCase()], { type: "text/plain" }) }
    const { response, text } = await serve({ range: "bytes=0-1" }, "GET", { transform })
    expect(response.status).toBe(200)
    expect(text).toBe(content.toUpperCase())
    expect(response.headers.get("accept-ranges")).toBeNull()
    expect(response.headers.get("content-range")).toBeNull()
  })
})

describe("Blob streams on an R2 binding", () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  type Range = { offset: number, length?: number } | { suffix: number }
  type Read = { onlyIf?: { etagMatches: string }, range?: Range }
  let calls: Array<["get", Read] | ["head"]>
  let object: { body: Uint8Array, etag: string }
  let changeAfterGet: (() => void) | undefined
  let contentType = "video/mp4"
  const describeObject = () => ({
    httpEtag: `"${object.etag}"`,
    httpMetadata: { contentType },
    key: "media/video.mp4",
    size: object.body.byteLength,
    uploaded: new Date(0),
  })
  const bucket = {
    async get(key: string, options: Read = {}) {
      if (key !== "media/video.mp4") return null
      calls.push(["get", options])
      const meta = describeObject()
      const size = object.body.byteLength
      // Like R2: a failed condition answers the metadata without a body.
      if (options.onlyIf && options.onlyIf.etagMatches !== object.etag) return meta
      const { range } = options
      const start = !range ? 0 : "suffix" in range ? size - range.suffix : range.offset
      const end = !range || "suffix" in range || range.length === undefined ? size : range.offset + range.length
      if (range && ("suffix" in range ? range.suffix <= 0 || size === 0 : range.offset >= size)) {
        changeAfterGet?.()
        changeAfterGet = undefined
        throw new Error("get: The requested range is not satisfiable (10039)")
      }
      const bytes = object.body.slice(Math.max(0, start), end)
      changeAfterGet?.()
      changeAfterGet = undefined
      return { ...meta, arrayBuffer: () => { throw new Error("read into memory") }, body: new Blob([bytes]).stream() }
    },
    async head(key: string) {
      if (key !== "media/video.mp4") return null
      calls.push(["head"])
      return describeObject()
    },
  }

  beforeEach(() => {
    calls = []
    contentType = "video/mp4"
    object = { body: encode("0123456789abcdefghij"), etag: "v1" }
    setActiveCloudflareEnv({ BLOB: bucket })
  })

  afterEach(() => {
    clearActiveCloudflareEnv()
  })

  async function serve(headers?: Record<string, string>) {
    const storage = createBlobStorage(createR2Driver({ binding: "BLOB", driver: "cloudflare-r2" }))
    const response = await storage.serve(new Request("https://example.test/video", { headers }), "media/video.mp4")
    return { response, text: await response.text() }
  }

  it("streams the whole object and its metadata from one read", async () => {
    const { response, text } = await serve()
    expect(response.status).not.toBe(206)
    expect(text).toBe("0123456789abcdefghij")
    expect(response.headers.get("content-length")).toBe("20")
    expect(response.headers.get("content-type")).toBe("video/mp4")
    expect(response.headers.get("etag")).toMatch(/^"[^"]+"$/)
    expect(calls).toEqual([["get", { onlyIf: undefined, range: undefined }]])
  })

  it("reads only the requested bytes in one read", async () => {
    const { response, text } = await serve({ range: "bytes=15-" })
    expect(response.status).toBe(206)
    expect(text).toBe("fghij")
    expect(response.headers.get("content-range")).toBe("bytes 15-19/20")
    expect(response.headers.get("content-length")).toBe("5")
    expect(response.headers.get("content-type")).toBe("video/mp4")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(calls).toEqual([["get", { onlyIf: undefined, range: { offset: 15 } }]])
  })

  it("reads bounded and suffix ranges in one read", async () => {
    const bounded = await serve({ range: "bytes=2-4" })
    expect(bounded.text).toBe("234")
    expect(bounded.response.headers.get("content-range")).toBe("bytes 2-4/20")
    const suffix = await serve({ range: "bytes=-3" })
    expect(suffix.text).toBe("hij")
    expect(suffix.response.headers.get("content-range")).toBe("bytes 17-19/20")
    expect(calls.map(call => call[1]?.range)).toEqual([{ offset: 2, length: 3 }, { suffix: 3 }])
  })

  it("answers a matching If-None-Match with 304 from one read", async () => {
    const etag = (await serve()).response.headers.get("etag")!
    calls = []
    const { response, text } = await serve({ "if-none-match": etag })
    expect(response.status).toBe(304)
    expect(text).toBe("")
    expect(calls).toHaveLength(1)
  })

  it("answers an unsatisfiable range with 416 and the size", async () => {
    const { response, text } = await serve({ range: "bytes=20-" })
    expect(response.status).toBe(416)
    expect(text).toBe("")
    expect(response.headers.get("content-range")).toBe("bytes */20")
    expect(calls).toEqual([["get", { onlyIf: undefined, range: { offset: 20 } }], ["head"]])
  })

  it("sends the whole body of the same version for a stale If-Range", async () => {
    const { response, text } = await serve({ "if-range": "\"old\"", range: "bytes=0-1" })
    expect(response.status).not.toBe(206)
    expect(text).toBe("0123456789abcdefghij")
    // R2 rejects a quoted ETag in onlyIf.
    expect(calls).toEqual([["get", { onlyIf: undefined, range: { offset: 0, length: 2 } }], ["get", { onlyIf: { etagMatches: "v1" }, range: undefined }]])
  })

  it("serves the new version when the object changes before a stale If-Range reads the whole body", async () => {
    changeAfterGet = () => {
      object = { body: encode("ABCDEFGHIJ"), etag: "v2" }
    }
    const { response, text } = await serve({ "if-range": "\"old\"", range: "bytes=0-1" })
    expect(text).toBe("ABCDEFGHIJ")
    expect(response.headers.get("content-length")).toBe("10")
  })

  it("reads again when the object grows to fit a range that R2 rejected", async () => {
    changeAfterGet = () => {
      object = { body: encode("0123456789abcdefghijKLMNO"), etag: "v2" }
    }
    const { response, text } = await serve({ range: "bytes=20-" })
    expect(response.status).toBe(206)
    expect(text).toBe("KLMNO")
    expect(response.headers.get("content-range")).toBe("bytes 20-24/25")
  })

  it("serves a streamed type that a browser opens as a page in a CSP sandbox", async () => {
    contentType = "image/svg+xml"
    const { response } = await serve()
    expect(response.headers.get("content-type")).toBe("image/svg+xml")
    expect(response.headers.get("content-security-policy")).toBe("sandbox")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")

    const etag = response.headers.get("etag")!
    const conditional = await serve({ "if-none-match": etag })
    expect(conditional.response.status).toBe(304)
    expect(conditional.response.headers.get("content-security-policy")).toBe("sandbox")
  })

  it("reads again when a stale If-Range whole read finds another content type", async () => {
    changeAfterGet = () => {
      contentType = "video/webm"
    }
    const { response, text } = await serve({ "if-range": "\"old\"", range: "bytes=0-1" })
    expect(text).toBe("0123456789abcdefghij")
    expect(response.headers.get("content-type")).toBe("video/webm")
    expect(calls).toHaveLength(4)
  })
})
