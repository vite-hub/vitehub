import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getRouterParam, H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver as createR2NativeDriver } from "../src/drivers/cloudflare-native.ts"
import { createDriver as createFsDriver } from "../src/drivers/fs.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { BlobDriverAdapter, BlobObject, BlobStorage } from "../src/types.ts"

const invalidPathname = { code: "BLOB_R0034", statusCode: 400 }

let root: string
let base: string
let storage: BlobStorage

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-blob-pathname-"))
  base = join(root, "blob")
  storage = createBlobStorage(createFsDriver({ base, driver: "fs" }), "default")
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

function spyDriver(): BlobDriverAdapter<{ driver: "fs" }> {
  const object: BlobObject = { contentType: undefined, customMetadata: {}, httpEtag: undefined, httpMetadata: {}, pathname: "x", uploadedAt: new Date() }
  return {
    name: "spy",
    options: { driver: "fs" },
    createMultipartUpload: vi.fn(async () => { throw new Error("driver called") }),
    delete: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    getArrayBuffer: vi.fn(async () => null),
    head: vi.fn(async () => null),
    list: vi.fn(async () => ({ blobs: [], hasMore: false })),
    put: vi.fn(async () => object),
    resumeMultipartUpload: vi.fn(async () => { throw new Error("driver called") }),
    sign: vi.fn(async () => ({ headers: {}, method: "GET" as const, url: "https://signed.example" })),
  }
}

describe("blob pathname validation", () => {
  const unsafe = ["", "/", "..", ".", "a/../b", "a/./b", "..%2Fsecret", "%2e%2e/secret", "a\\..\\b", "a%5C..%5Cb", "a\u0000b", "a%00b", "a\nb", "a%7Fb", "a\uD800b", "a\uDC00b"]

  it.each(unsafe)("rejects %j before any driver call", async (pathname) => {
    const driver = spyDriver()
    const storage = createBlobStorage(driver, "default")
    const event = { req: new Request("https://example.test/x"), res: { headers: new Headers(), status: 200 } }

    await expect(storage.get(pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.head(pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.del(pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.del(["ok.txt", pathname])).rejects.toMatchObject(invalidPathname)
    await expect(storage.put(pathname, "x")).rejects.toMatchObject(invalidPathname)
    await expect(storage.serve(event, pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.sign(pathname, { expiresIn: 60, method: "GET" })).rejects.toMatchObject(invalidPathname)
    await expect(storage.sign(pathname, { expiresIn: 60, method: "PUT" })).rejects.toMatchObject(invalidPathname)
    await expect(storage.createMultipartUpload(pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.resumeMultipartUpload(pathname, "upload")).rejects.toMatchObject(invalidPathname)

    for (const method of ["get", "head", "delete", "put", "sign", "createMultipartUpload", "resumeMultipartUpload", "getArrayBuffer"] as const) {
      expect(driver[method], method).not.toHaveBeenCalled()
    }
  })

  it("checks the final pathname after prefix and suffix", async () => {
    const driver = spyDriver()
    const storage = createBlobStorage(driver, "default")

    await expect(storage.put("a.txt", "x", { prefix: "../outside" })).rejects.toMatchObject(invalidPathname)
    await expect(storage.put("a.txt", "x", { prefix: "uploads/./x", addRandomSuffix: true })).rejects.toMatchObject(invalidPathname)
    await expect(storage.createMultipartUpload("a.txt", { prefix: "..\\outside" })).rejects.toMatchObject(invalidPathname)
    expect(driver.put).not.toHaveBeenCalled()
    expect(driver.createMultipartUpload).not.toHaveBeenCalled()
  })

  it("checks list prefixes and allows a trailing slash", async () => {
    const driver = spyDriver()
    const storage = createBlobStorage(driver, "default")

    for (const prefix of ["..", "../", "a/../", "a\u0000", "%2e%2e/"]) {
      await expect(storage.list({ prefix }), prefix).rejects.toMatchObject(invalidPathname)
    }
    expect(driver.list).not.toHaveBeenCalled()

    const [error] = await storage.list({ prefix: "uploads/" })
    expect(error).toBeNull()
    expect(driver.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "uploads/" }))
  })

  it("accepts normal pathnames with dots, spaces, and percent signs", async () => {
    for (const pathname of ["notes/a.txt", ".env.example", "a/..b/c..", "a/.../b", "50%25 off.txt", "photo%201.png"]) {
      const [error] = await storage.put(pathname, "x")
      expect(error, pathname).toBeNull()
    }
    expect(await readdir(base)).toEqual(expect.arrayContaining([".env.example", "50% off.txt", "a", "notes", "photo 1.png"]))
  })

  it("rejects control characters with a 400-class error instead of a Node error", async () => {
    await expect(storage.put("a\u0000b.txt", "x")).rejects.toMatchObject(invalidPathname)
    await expect(storage.get("a%00b.txt")).rejects.toMatchObject(invalidPathname)
  })
})

describe("HTTP routes", () => {
  function app() {
    return new H3()
      .get("/blob/**:pathname", async (event) => {
        const [error, stream] = await storage.serve(event, getRouterParam(event, "pathname", { decode: false }) || "")
        if (error) throw error
        return stream
      })
      .post("/upload", async (event) => {
        const [error, objects] = await storage.handleUpload(event, { put: { prefix: "uploads" } })
        if (error) throw error
        return objects
      })
  }

  it("answers 400 to a serve request that leaves the store", async () => {
    await writeFile(join(root, "secret.txt"), "secret")
    const [error] = await storage.put("public.txt", "public")
    expect(error).toBeNull()

    const response = await app().fetch(new Request("http://localhost/blob/..%2Fsecret.txt"))
    expect(response.status).toBe(400)
    expect((await app().fetch(new Request("http://localhost/blob/public.txt"))).status).toBe(200)
  })

  it("keeps an uploaded file inside the prefix", async () => {
    const form = new FormData()
    form.append("files", new File(["evil"], "..%2Fevil.txt"))
    const response = await app().fetch(new Request("http://localhost/upload", { body: form, method: "POST" }))

    expect(response.status).toBe(200)
    expect(await readdir(base)).not.toContain("evil.txt")
    expect(await readdir(join(base, "uploads"))).toEqual(["..%2Fevil.txt"])
  })
})

describe("handleUpload pathnames", () => {
  function formRequest(names: string[]) {
    const form = new FormData()
    for (const name of names) form.append("files", new File([name], name, { type: "text/plain" }))
    return { req: new Request("http://localhost/api/files", { body: form, method: "POST" }) }
  }

  it("keeps an encoded file name inside the prefix", async () => {
    const [error, objects] = await storage.handleUpload(formRequest(["..%2Fevil.txt"]), { put: { prefix: "uploads" } })

    expect(error).toBeNull()
    expect(objects?.map(object => object.pathname)).toEqual(["uploads/..%2Fevil.txt"])
    expect(await readdir(base)).not.toContain("evil.txt")
    expect(await readdir(join(base, "uploads"))).toEqual(["..%2Fevil.txt"])
  })

  it("stores file names literally instead of decoding them", async () => {
    const [error, objects] = await storage.handleUpload(formRequest(["a%2Fb.txt", "photo%201.png"]), { put: { prefix: "uploads" } })

    expect(error).toBeNull()
    expect(objects?.map(object => object.pathname)).toEqual(["uploads/a%2Fb.txt", "uploads/photo%201.png"])
  })

  it("rejects dot file names with a 400 error", async () => {
    await expect(storage.handleUpload(formRequest([".."]), { put: { prefix: "uploads" } })).rejects.toMatchObject(invalidPathname)
  })
})

describe("Cloudflare R2 native signed requests", () => {
  const options = {
    accessKeyId: "access-key",
    accountId: "account",
    binding: "BLOB",
    bucketName: "media",
    driver: "cloudflare-r2" as const,
    secretAccessKey: "secret-key",
  }

  it("does not let dot segments change the signed request target", async () => {
    const driver = createR2NativeDriver(options)

    for (const pathname of ["x/..", "../other/key", "a/./b", ""]) {
      await expect(driver.sign!(pathname, { expiresIn: 60, method: "GET" }), pathname).rejects.toMatchObject(invalidPathname)
      await expect(driver.sign!(pathname, { expiresIn: 60, method: "PUT" }), pathname).rejects.toMatchObject(invalidPathname)
    }
  })

  it("signs a path that stays under the bucket", async () => {
    const driver = createR2NativeDriver(options)
    const signed = await driver.sign!("a b/%2e%2e/c?.txt", { expiresIn: 60, method: "GET" })

    expect(new URL(signed.url).pathname).toBe("/media/a%20b/%252e%252e/c%3F.txt")
  })
})
