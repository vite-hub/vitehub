import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getRouterParam, H3, H3Event } from "h3"
import { memory } from "files-sdk/memory"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver as createR2Driver } from "../src/drivers/cloudflare.ts"
import { createDriver as createR2NativeDriver } from "../src/drivers/cloudflare-native.ts"
import { createFilesSdkDriver } from "../src/drivers/files-sdk.ts"
import { createDriver as createFsDriver } from "../src/drivers/fs.ts"
import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "../src/runtime/state.ts"
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

function spyDriver(name = "spy"): BlobDriverAdapter<{ driver: "fs" }> {
  const object: BlobObject = { contentType: undefined, customMetadata: {}, httpEtag: undefined, httpMetadata: {}, pathname: "x", uploadedAt: new Date() }
  return {
    name,
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

  it.each([
    { name: "invalid", pathname: "..%2Fsecret", status: 400 },
    { name: "reserved", pathname: ".vitehub/blob-meta/x.json", status: 404 },
    { name: "missing", pathname: "missing.txt", status: 404 },
    { name: "over the R2 key limit", pathname: "a".repeat(1025), status: 400 },
  ])("returns a bodyless HEAD response for a pathname that is $name", async ({ pathname, status }) => {
    const storage = createBlobStorage(spyDriver("cloudflare-r2"), "default")
    const get = await storage.serve(new Request("https://example.test/x"), pathname)
    const head = await storage.serve(new Request("https://example.test/x", { method: "HEAD" }), pathname)

    expect(get.status).toBe(status)
    expect(await get.json()).toEqual({ error: expect.any(String) })
    expect(head.status).toBe(status)
    expect([...head.headers]).toEqual([...get.headers])
    expect(head.body).toBeNull()
    expect(await head.text()).toBe("")
  })

  it.each(unsafe)("rejects %j before any driver call", async (pathname) => {
    const driver = spyDriver()
    const storage = createBlobStorage(driver, "default")

    await expect(storage.get(pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.head(pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.delete(pathname)).rejects.toMatchObject(invalidPathname)
    await expect(storage.delete(["ok.txt", pathname])).rejects.toMatchObject(invalidPathname)
    await expect(storage.put(pathname, "x")).rejects.toMatchObject(invalidPathname)
    const served = await storage.serve(new Request("https://example.test/x"), pathname)
    expect(served.status).toBe(400)
    expect(await served.json()).toEqual({ error: expect.stringMatching(/^Invalid Blob pathname: it must /) })
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
    expect(error).toBeUndefined()
    expect(driver.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "uploads/" }))
  })

  it("accepts normal pathnames with dots, spaces, and percent signs", async () => {
    for (const pathname of ["notes/a.txt", ".env.example", "a/..b/c..", "a/.../b", "50%25 off.txt", "photo%201.png"]) {
      const [error] = await storage.put(pathname, "x")
      expect(error, pathname).toBeUndefined()
    }
    expect(await readdir(base)).toEqual(expect.arrayContaining([".env.example", "50% off.txt", "a", "notes", "photo 1.png"]))
  })

  it("rejects control characters with a 400-class error instead of a Node error", async () => {
    await expect(storage.put("a\u0000b.txt", "x")).rejects.toMatchObject(invalidPathname)
    await expect(storage.get("a%00b.txt")).rejects.toMatchObject(invalidPathname)
  })
})

describe("reserved serve pathnames", () => {
  const reserved = [".vitehub", ".vitehub/blob-meta/x.json", ".VITEHUB/blob-hashes/x.json", "%2Evitehub/multipart/x", "_vitehub", "_VITEHUB/", "_vitehub/derived/x", "_vitehub/media/records/x.jpg.json", "%5Fvitehub/derived/x"]

  it.each(reserved)("answers 404 to %j before any driver call", async (pathname) => {
    const driver = spyDriver()
    const response = await createBlobStorage(driver, "default").serve(new Request("https://example.test/x"), pathname)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Blob not found." })
    for (const method of ["get", "head", "getArrayBuffer"] as const) expect(driver[method], method).not.toHaveBeenCalled()
  })

  it("answers 404 to the fs driver's own metadata files", async () => {
    await storage.put("hello.txt", "hello")
    const [meta] = await readdir(join(base, ".vitehub/blob-meta"))
    for (const pathname of [`.vitehub/blob-meta/${meta}`, ".vitehub/blob-meta", "./.vitehub/blob-meta"]) {
      expect((await storage.serve(new Request("https://example.test/x"), pathname)).status, pathname).toBe(pathname.startsWith("./") ? 400 : 404)
    }
  })

  it("answers 404 on Files SDK and R2 stores too", async () => {
    const files = createBlobStorage(createFilesSdkDriver({ base: ".data/blob", driver: "fs" }, () => memory()), "default")
    setActiveCloudflareEnv({ BLOB: { get: vi.fn(async () => { throw new Error("driver called") }), head: vi.fn(async () => { throw new Error("driver called") }) } })
    try {
      const r2 = createBlobStorage(createR2Driver({ binding: "BLOB", driver: "cloudflare-r2" }), "default")
      for (const store of [files, r2]) {
        for (const pathname of [".vitehub/blob-meta/x.json", "_vitehub/derived/x"]) {
          expect((await store.serve(new Request("https://example.test/x"), pathname)).status, pathname).toBe(404)
        }
        expect((await store.serve(new Request("https://example.test/x"), "dir/..%2F..%2Fpackage.json")).status).toBe(400)
      }
    }
    finally {
      clearActiveCloudflareEnv()
    }
  })

  it("rejects writes to .vitehub on every driver", async () => {
    const driver = spyDriver()
    const storage = createBlobStorage(driver, "default")
    for (const pathname of [".vitehub/blob-meta/x.json", ".VITEHUB/x"]) {
      await expect(storage.put(pathname, "x")).rejects.toThrow("reserved ViteHub namespace")
      await expect(storage.createMultipartUpload(pathname)).rejects.toThrow("reserved ViteHub namespace")
      await expect(storage.sign(pathname, { expiresIn: 60, method: "PUT" })).rejects.toThrow("reserved ViteHub namespace")
    }
    expect(driver.put).not.toHaveBeenCalled()
  })

  it("answers 400 to a pathname above the R2 key limit", async () => {
    const driver = spyDriver("cloudflare-r2")
    const response = await createBlobStorage(driver, "default").serve(new Request("https://example.test/x"), "a".repeat(1025))
    expect(response.status).toBe(400)
    expect(driver.head).not.toHaveBeenCalled()
  })
})

describe("HTTP routes", () => {
  function app() {
    return new H3()
      .get("/blob/**:pathname", event => storage.serve(event.req, getRouterParam(event, "pathname", { decode: false }) || ""))
      .post("/upload", async (event) => {
        const [error, objects] = await storage.handleUpload(event, { put: { prefix: "uploads" } })
        if (error) throw error
        return objects
      })
  }

  it("answers 400 to a serve request that leaves the store", async () => {
    await writeFile(join(root, "secret.txt"), "secret")
    const [error] = await storage.put("public.txt", "public")
    expect(error).toBeUndefined()

    for (const path of ["..%2Fsecret.txt", "dir/..%2F..%2F..%2Fsecret.txt", "%2E%2E%2Fsecret.txt"]) {
      const response = await app().fetch(new Request(`http://localhost/blob/${path}`))
      expect(response.status, path).toBe(400)
      expect(response.headers.get("content-type")).toContain("application/json")
    }
    expect((await app().fetch(new Request("http://localhost/blob/public.txt"))).status).toBe(200)
    expect((await app().fetch(new Request("http://localhost/blob/.vitehub/blob-meta/x.json"))).status).toBe(404)
  })

  it("keeps an uploaded file inside the prefix", async () => {
    const form = new FormData()
    form.append("files", new File(["evil"], "..%2Fevil.txt"))
    const response = await app().fetch(new Request("http://localhost/upload", { body: form, method: "POST" }))

    expect(response.status).toBe(200)
    expect(await readdir(base)).not.toContain("evil.txt")
    expect(await readdir(join(base, "uploads"))).toEqual([".._2Fevil.txt"])
  })
})

describe("handleUpload pathnames", () => {
  function formRequest(names: string[]) {
    const form = new FormData()
    for (const name of names) form.append("files", new File([name], name, { type: "text/plain" }))
    return new H3Event(new Request("http://localhost/api/files", { body: form, method: "POST" }))
  }

  it("keeps an encoded file name inside the prefix", async () => {
    const [error, objects] = await storage.handleUpload(formRequest(["..%2Fevil.txt"]), { put: { prefix: "uploads" } })

    expect(error).toBeUndefined()
    expect(objects?.map(object => object.pathname)).toEqual(["uploads/.._2Fevil.txt"])
    expect(await readdir(base)).not.toContain("evil.txt")
    expect(await readdir(join(base, "uploads"))).toEqual([".._2Fevil.txt"])
  })

  it("does not decode file names and replaces the \"%\" of a %XX sequence", async () => {
    const [error, objects] = await storage.handleUpload(formRequest(["a%2Fb.txt", "photo%201.png", "50% off.txt"]), { put: { prefix: "uploads" } })

    expect(error).toBeUndefined()
    expect(objects?.map(object => object.pathname)).toEqual(["uploads/a_2Fb.txt", "uploads/photo_201.png", "uploads/50% off.txt"])
  })

  it("returns pathnames that target the same object when passed back", async () => {
    const [error, objects] = await storage.handleUpload(formRequest(["Q3 100%25 final.pdf", "x%41.txt"]), { put: { prefix: "uploads" } })
    expect(error).toBeUndefined()

    const [, listed] = await storage.list({ prefix: "uploads/" })
    const pathnames = listed!.blobs.map(object => object.pathname).sort()
    expect(pathnames).toEqual(objects!.map(object => object.pathname).sort())
    for (const pathname of pathnames) {
      expect((await storage.head(pathname))[1]?.pathname, pathname).toBe(pathname)
      expect(await (await storage.get(pathname))[1]?.text(), pathname).toBeDefined()
      const [deleteError] = await storage.delete(pathname)
      expect(deleteError).toBeUndefined()
      expect((await storage.head(pathname))[1], pathname).toBeNull()
    }
    expect((await storage.list({ prefix: "uploads/" }))[1]!.blobs).toEqual([])
  })

  it("rejects a pathname that still has a percent-encoded sequence after decoding", async () => {
    for (const pathname of ["x%2541.txt", "a/b%25%32%30c"]) {
      await expect(storage.put(pathname, "x"), pathname).rejects.toMatchObject(invalidPathname)
      await expect(storage.get(pathname), pathname).rejects.toMatchObject(invalidPathname)
      await expect(storage.createMultipartUpload(pathname), pathname).rejects.toMatchObject(invalidPathname)
      await expect(storage.sign(pathname, { expiresIn: 60, method: "GET" }), pathname).rejects.toMatchObject(invalidPathname)
      expect((await storage.serve(new Request("https://example.test/x"), pathname)).status, pathname).toBe(400)
    }
    await expect(storage.put("x.txt", "x", { prefix: "a%41" })).rejects.toMatchObject(invalidPathname)
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
      await expect(driver.sign!(pathname, { expiresIn: 60, method: "GET" }, { store: "default" }), pathname).rejects.toMatchObject(invalidPathname)
      await expect(driver.sign!(pathname, { expiresIn: 60, method: "PUT" }, { store: "default" }), pathname).rejects.toMatchObject(invalidPathname)
    }
  })

  it("signs a path that stays under the bucket", async () => {
    const driver = createR2NativeDriver(options)
    const signed = await driver.sign!("a b/50% off/c?.txt", { expiresIn: 60, method: "GET" }, { store: "default" })

    expect(new URL(signed.url).pathname).toBe("/media/a%20b/50%25%20off/c%3F.txt")
  })
})
