import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const vercel = vi.hoisted(() => ({
  copy: vi.fn(),
  head: vi.fn(),
}))

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>()
  return { ...actual, copy: vercel.copy, head: vercel.head }
})

import { createDriver as createCloudflareDriver } from "../src/drivers/cloudflare-native.ts"
import { createFilesSdkDriver } from "../src/drivers/files-sdk.ts"
import { createDriver as createFsDriver } from "../src/drivers/fs.ts"
import { createDriver as createVercelDriver } from "../src/drivers/vercel-bundled.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { BlobDriverAdapter, BlobObject, BlobPutBody, BlobPutOptions } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function fsStorage() {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-copy-"))
  tempDirs.push(base)
  const driver = createFsDriver({ base, driver: "fs" })
  const put = vi.spyOn(driver, "put")
  return { put, storage: createBlobStorage(driver, "default", { images: false }) }
}

describe("blob.copy() on fs", () => {
  it("copies the file with its content type and custom metadata, without put()", async () => {
    const { put, storage } = await fsStorage()
    await storage.put("docs/a.txt", "hello", { contentType: "text/markdown", customMetadata: { owner: "ada" } })
    put.mockClear()

    const [error, object] = await storage.copy("docs/a.txt", "archive/a.txt")
    expect(error).toBeUndefined()
    expect(object).toMatchObject({ contentType: "text/markdown", customMetadata: { owner: "ada" }, pathname: "archive/a.txt", size: 5 })
    expect(put).not.toHaveBeenCalled()
    const [, body] = await storage.get("archive/a.txt")
    expect(await body!.text()).toBe("hello")
    // The source stays.
    expect((await storage.head("docs/a.txt"))[1]).toMatchObject({ customMetadata: { owner: "ada" } })
  })

  it("returns BLOB_CONFLICT for an existing destination unless overwrite is set", async () => {
    const { storage } = await fsStorage()
    await storage.put("a.txt", "new", { contentType: "text/plain" })
    await storage.put("b.txt", "old", { contentType: "text/csv" })

    const [conflict] = await storage.copy("a.txt", "b.txt")
    expect(conflict?.code).toBe("BLOB_CONFLICT")
    expect(await (await storage.get("b.txt"))[1]!.text()).toBe("old")

    const [error, object] = await storage.copy("a.txt", "b.txt", { overwrite: true })
    expect(error).toBeUndefined()
    expect(object).toMatchObject({ contentType: "text/plain", pathname: "b.txt" })
    expect(await (await storage.get("b.txt"))[1]!.text()).toBe("new")
  })

  it("returns BLOB_NOT_FOUND for a missing source", async () => {
    const { storage } = await fsStorage()
    const [error] = await storage.copy("missing.txt", "b.txt")
    expect(error).toMatchObject({ code: "BLOB_NOT_FOUND", statusCode: 404 })
    expect((await storage.head("b.txt"))[1]).toBeNull()
  })

  it("checks the destination with the rules of put()", async () => {
    const { storage } = await fsStorage()
    await storage.put("a.txt", "a")
    for (const target of ["_vitehub/media/a.txt", ".vitehub/a.txt", "../a.txt", "a/../../b.txt", "x%2541.txt"]) {
      await expect(storage.copy("a.txt", target)).rejects.toThrow()
      await expect(storage.put(target, "a")).rejects.toThrow()
    }
    await expect(storage.copy("../a.txt", "b.txt")).rejects.toThrow()
  })

  it("returns the object for a copy onto itself", async () => {
    const { storage } = await fsStorage()
    await storage.put("a.txt", "a", { contentType: "text/plain" })
    await expect(storage.copy("a.txt", "a.txt")).resolves.toEqual([undefined, expect.objectContaining({ pathname: "a.txt" })])
  })
})

describe("blob.copy() on a driver without copy", () => {
  it("reads the object and writes it with its content type and custom metadata", async () => {
    const objects = new Map<string, { body: Blob, object: BlobObject }>()
    const driver: BlobDriverAdapter<object> = {
      name: "netlify-blobs",
      options: {},
      async delete() {},
      get: async pathname => objects.get(pathname)?.body ?? null,
      getArrayBuffer: async pathname => await objects.get(pathname)?.body.arrayBuffer() ?? null,
      head: async pathname => objects.get(pathname)?.object ?? null,
      list: async () => ({ blobs: [], hasMore: false }),
      async put(pathname: string, body: BlobPutBody, options: BlobPutOptions = {}) {
        const blob = new Blob([await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer()], { type: options.contentType })
        const object: BlobObject = { contentType: options.contentType, customMetadata: options.customMetadata ?? {}, httpEtag: undefined, httpMetadata: {}, pathname, size: blob.size, uploadedAt: new Date() }
        objects.set(pathname, { body: blob, object })
        return object
      },
    }
    const storage = createBlobStorage(driver, "default", { images: false })
    await storage.put("a.json", "{}", { contentType: "application/json", customMetadata: { v: "1" } })

    const [error, object] = await storage.copy("a.json", "b.json")
    expect(error).toBeUndefined()
    expect(object).toMatchObject({ contentType: "application/json", customMetadata: { v: "1" }, pathname: "b.json", size: 2 })
  })
})

describe("blob.copy() on Cloudflare R2", () => {
  it("streams the object body into the new key with its metadata", async () => {
    const body = new Blob(["image"]).stream()
    const bucket = {
      get: vi.fn(async (key: string) => key === "a.png"
        ? { body, customMetadata: { alt: "cat" }, httpMetadata: { cacheControl: "max-age=60", contentType: "image/png" }, key, size: 5 }
        : null),
      head: vi.fn(async () => null),
      put: vi.fn(async (key: string, _value: unknown, options: { customMetadata?: Record<string, string>, httpMetadata?: { contentType?: string } }) => ({ ...options, key, size: 5 })),
    }
    vi.stubGlobal("BUCKET", bucket)
    const storage = createBlobStorage(createCloudflareDriver({ binding: "BUCKET", driver: "cloudflare-r2" }), "default", { images: false })

    const [error, object] = await storage.copy("a.png", "b.png")
    expect(error).toBeUndefined()
    expect(object).toMatchObject({ contentType: "image/png", customMetadata: { alt: "cat" }, pathname: "b.png" })
    expect(bucket.put).toHaveBeenCalledWith("b.png", body, { customMetadata: { alt: "cat" }, httpMetadata: { cacheControl: "max-age=60", contentType: "image/png" } })

    const [missing] = await storage.copy("missing.png", "c.png")
    expect(missing?.code).toBe("BLOB_NOT_FOUND")
  })

  it("returns BLOB_PATHNAME_TOO_LONG for a destination above 1024 bytes", async () => {
    vi.stubGlobal("BUCKET", { get: vi.fn(), head: vi.fn(async () => null), put: vi.fn() })
    const storage = createBlobStorage(createCloudflareDriver({ binding: "BUCKET", driver: "cloudflare-r2" }), "default", { images: false })
    const [error] = await storage.copy("a.png", "b".repeat(1025))
    expect(error?.code).toBe("BLOB_PATHNAME_TOO_LONG")
  })
})

describe("blob.copy() on S3 through files-sdk", () => {
  it("copies on the provider without a download or upload", async () => {
    const keys = new Set(["src.txt"])
    const copy = vi.fn(async (_from: string, to: string) => { keys.add(to) })
    const download = vi.fn()
    const upload = vi.fn()
    class FakeFiles {
      copy = copy
      download = download
      upload = upload
      async head(key: string) {
        if (!keys.has(key)) throw Object.assign(new Error("Object not found"), { code: "NotFound" })
        return { contentType: "text/plain", key, metadata: { owner: "ada" }, size: 1 }
      }
    }
    const storage = createBlobStorage(createFilesSdkDriver({ bucket: "bucket", driver: "s3" }, async () => ({} as never), FakeFiles as never), "default", { images: false })

    const [error, object] = await storage.copy("src.txt", "a.txt")
    expect(error).toBeUndefined()
    expect(copy).toHaveBeenCalledWith("src.txt", "a.txt")
    expect(download).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(object).toMatchObject({ contentType: "text/plain", customMetadata: { owner: "ada" }, pathname: "a.txt" })

    copy.mockRejectedValueOnce(Object.assign(new Error("Object not found"), { code: "NotFound" }))
    const [missing] = await storage.copy("gone.txt", "c.txt")
    expect(missing?.code).toBe("BLOB_NOT_FOUND")

    // Azure reports a missing source as a copy conflict, with the 404 nested inside.
    copy.mockRejectedValueOnce(Object.assign(new Error("CannotVerifyCopySource"), { code: "Conflict" }))
    const [wrapped] = await storage.copy("gone.txt", "c.txt")
    expect(wrapped?.code).toBe("BLOB_NOT_FOUND")

    const failure = Object.assign(new Error("Service unavailable"), { code: "Provider" })
    copy.mockRejectedValueOnce(failure)
    const [failed] = await storage.copy("src.txt", "c.txt")
    expect(failed).toMatchObject({ cause: failure, code: "BLOB_OPERATION_FAILED" })
  })
})

describe("blob.copy() on Vercel Blob", () => {
  it("copies on the server and keeps the content type", async () => {
    const uploadedAt = new Date("2026-01-01T00:00:00.000Z")
    vercel.head.mockImplementation(async (pathname: string) => {
      if (pathname === "b.txt") throw new (await import("@vercel/blob")).BlobNotFoundError()
      const key = pathname.startsWith("https://") ? "b.txt" : pathname
      return { contentType: "text/plain", pathname: key, size: 3, uploadedAt, url: `https://store.private.blob.vercel-storage.com/${key}` }
    })
    vercel.copy.mockResolvedValue({ contentType: "text/plain", pathname: "b.txt", url: "https://store.private.blob.vercel-storage.com/b.txt" })
    const storage = createBlobStorage(createVercelDriver({ access: "private", driver: "vercel-blob", token: "token" }), "default", { images: false })

    const [error, object] = await storage.copy("a.txt", "b.txt")
    expect(error).toBeUndefined()
    expect(vercel.copy).toHaveBeenCalledWith("https://store.private.blob.vercel-storage.com/a.txt", "b.txt", expect.objectContaining({ addRandomSuffix: false, contentType: "text/plain", token: "token" }))
    expect(object).toMatchObject({ contentType: "text/plain", pathname: "b.txt", size: 3 })
  })
})
