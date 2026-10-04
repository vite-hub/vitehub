import { afterEach, describe, expect, it, vi } from "vitest"

import { createDriver as createR2Driver, getOptionalBucket } from "../src/drivers/cloudflare-native.ts"
import { createDriver as createVercelDriver } from "../src/drivers/vercel-bundled.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { BlobResult } from "../src/types.ts"

const vercel = vi.hoisted(() => ({
  completeMultipartUpload: vi.fn(async (pathname: string) => ({ pathname, url: `https://store.public.blob.vercel-storage.com/${pathname}` })),
  createMultipartUpload: vi.fn(async () => ({ key: "object-key", uploadId: "vercel-upload" })),
  head: vi.fn(async (url: string) => ({
    contentType: "video/mp4",
    etag: "\"final\"",
    pathname: new URL(url).pathname.slice(1),
    size: 12,
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    url,
  })),
  uploadPart: vi.fn(async (_pathname: string, _body: unknown, options: { partNumber: number }) => ({ etag: `"part-${options.partNumber}"`, partNumber: options.partNumber })),
}))

vi.mock("@vercel/blob", () => ({ ...vercel, del: vi.fn(), get: vi.fn(), list: vi.fn(), put: vi.fn() }))

function ok<T>(result: BlobResult<T>): T {
  const [error, value] = result
  if (error) throw error
  return value
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "TEST_R2")
  vi.clearAllMocks()
})

describe("Cloudflare R2 multipart uploads", () => {
  it("does not treat inherited globals as R2 bindings", () => {
    expect(getOptionalBucket({ binding: "constructor", driver: "cloudflare-r2" })).toBeUndefined()
  })

  it("uses the binding's multipart API", async () => {
    const parts: Array<{ body: unknown, partNumber: number }> = []
    const upload = {
      abort: vi.fn(async () => {}),
      complete: vi.fn(async () => ({ httpEtag: "\"final\"", httpMetadata: { contentType: "text/plain" }, key: "notes/a.txt", size: 4 })),
      key: "notes/a.txt",
      uploadId: "r2-upload",
      uploadPart: vi.fn(async (partNumber: number, body: unknown) => {
        parts.push({ body, partNumber })
        return { etag: `"r2-${partNumber}"`, partNumber }
      }),
    }
    const bucket = {
      createMultipartUpload: vi.fn(async () => upload),
      resumeMultipartUpload: vi.fn(() => upload),
    }
    Reflect.set(globalThis, "TEST_R2", bucket)
    const storage = createBlobStorage(createR2Driver({ binding: "TEST_R2", driver: "cloudflare-r2" }), "default")

    const created = ok(await storage.createMultipartUpload("notes/a.txt", { customMetadata: { owner: "u1" } }))
    expect(bucket.createMultipartUpload).toHaveBeenCalledWith("notes/a.txt", { customMetadata: { owner: "u1" }, httpMetadata: { contentType: "text/plain; charset=utf-8" } })
    const resumed = ok(await storage.resumeMultipartUpload("notes/a.txt", created.uploadId))
    expect(bucket.resumeMultipartUpload).toHaveBeenCalledWith("notes/a.txt", "r2-upload")

    const part = ok(await resumed.uploadPart(1, "data"))
    expect(part).toEqual({ etag: "\"r2-1\"", partNumber: 1 })
    expect(ok(await resumed.complete([part]))).toMatchObject({ contentType: "text/plain", httpEtag: "\"final\"", pathname: "notes/a.txt", size: 4 })
    ok(await resumed.abort())
    expect(upload.abort).toHaveBeenCalled()
  })
})

describe("Vercel Blob multipart uploads", () => {
  const options = { access: "public", driver: "vercel-blob", token: "token" } as const

  it("carries the key and upload ID in an opaque upload ID", async () => {
    const storage = createBlobStorage(createVercelDriver(options), "default")

    const created = ok(await storage.createMultipartUpload("media/clip.mp4"))
    expect(vercel.createMultipartUpload).toHaveBeenCalledWith("media/clip.mp4", expect.objectContaining({ access: "public", addRandomSuffix: false, contentType: "application/octet-stream", token: "token" }))
    expect(created.uploadId).not.toContain("=")

    const resumed = ok(await storage.resumeMultipartUpload("media/clip.mp4", created.uploadId))
    const part = ok(await resumed.uploadPart(3, "chunk"))
    expect(vercel.uploadPart).toHaveBeenCalledWith("media/clip.mp4", "chunk", expect.objectContaining({ access: "public", key: "object-key", partNumber: 3, uploadId: "vercel-upload" }))

    expect(ok(await resumed.complete([part]))).toMatchObject({ contentType: "video/mp4", pathname: "media/clip.mp4", size: 12 })
    expect(vercel.completeMultipartUpload).toHaveBeenCalledWith("media/clip.mp4", [part], expect.objectContaining({ key: "object-key", uploadId: "vercel-upload" }))
  })

  it("takes access from the store config, not from the upload ID", async () => {
    const storage = createBlobStorage(createVercelDriver({ ...options, access: "private" }), "default")
    const forged = btoa(JSON.stringify({ access: "public", key: "object-key", uploadId: "vercel-upload" }))

    const resumed = ok(await storage.resumeMultipartUpload("media/clip.mp4", forged))
    ok(await resumed.uploadPart(1, "chunk"))

    expect(vercel.uploadPart).toHaveBeenCalledWith("media/clip.mp4", "chunk", expect.objectContaining({ access: "private" }))
    expect((await storage.resumeMultipartUpload("media/clip.mp4", "not-base64!"))[0]?.cause).toMatchObject({ message: "Unknown Vercel Blob multipart upload." })
  })
})
