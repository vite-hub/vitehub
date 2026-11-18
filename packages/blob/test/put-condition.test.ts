import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const vercel = vi.hoisted(() => ({ put: vi.fn() }))
const netlify = vi.hoisted(() => ({ set: vi.fn() }))

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>()
  return { ...actual, put: vercel.put }
})
vi.mock("@vite-hub/netlify-blobs-runtime", () => ({
  getDeployStore: () => netlify,
  getStore: () => netlify,
}))

import { BlobError, BlobPreconditionFailedError } from "@vercel/blob"

import { blobDocument } from "../../realtime/src/blob-document.ts"
import { createDriver as createCloudflareDriver } from "../src/drivers/cloudflare-native.ts"
import { createFilesSdkDriver } from "../src/drivers/files-sdk.ts"
import { createDriver as createFsDriver } from "../src/drivers/fs.ts"
import { createDriver as createNetlifyDriver } from "../src/drivers/netlify-blobs.ts"
import { createDriver as createVercelDriver } from "../src/drivers/vercel-bundled.ts"
import { blob } from "../src/runtime/storage.ts"
import { clearActiveCloudflareEnv, setActiveCloudflareEnv, setBlobRuntimeConfig } from "../src/runtime/state.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { BlobDriverAdapter, BlobObject } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function fsStorage() {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-put-condition-"))
  tempDirs.push(base)
  return createBlobStorage(createFsDriver({ base, driver: "fs" }), "default", { images: false })
}

async function text(storage: Awaited<ReturnType<typeof fsStorage>>, pathname: string) {
  const [, file] = await storage.get(pathname)
  return await file?.text()
}

describe("put() with a condition on fs", () => {
  it("writes with the current ETag and returns BLOB_CONFLICT with an old one", async () => {
    const storage = await fsStorage()
    const [, first] = await storage.put("notes.md", "one")
    const [, second] = await storage.put("notes.md", "two", { ifMatch: first!.httpEtag })
    expect(second?.httpEtag).not.toBe(first?.httpEtag)

    const [conflict, object] = await storage.put("notes.md", "three", { ifMatch: first!.httpEtag })
    expect(object).toBeUndefined()
    expect(conflict).toMatchObject({ code: "BLOB_CONFLICT", why: expect.stringContaining("ifMatch") })
    expect(await text(storage, "notes.md")).toBe("two")

    const [missing] = await storage.put("gone.md", "x", { ifMatch: first!.httpEtag })
    expect(missing?.code).toBe("BLOB_CONFLICT")
    expect((await storage.head("gone.md"))[1]).toBeNull()
  })

  it("creates a file with overwrite: false only when none exists", async () => {
    const storage = await fsStorage()
    const [created] = await storage.put("a.txt", "first", { overwrite: false })
    expect(created).toBeUndefined()
    const [conflict] = await storage.put("a.txt", "second", { overwrite: false })
    expect(conflict?.code).toBe("BLOB_CONFLICT")
    expect(await text(storage, "a.txt")).toBe("first")
  })

  it("lets one of two writes with the same ETag win", async () => {
    const storage = await fsStorage()
    const [, object] = await storage.put("counter.txt", "0")
    const results = await Promise.all(["a", "b", "c"].map(body => storage.put("counter.txt", body, { ifMatch: object!.httpEtag })))
    expect(results.filter(([error]) => !error)).toHaveLength(1)
    expect(results.filter(([error]) => error?.code === "BLOB_CONFLICT")).toHaveLength(2)
  })

  it.each(["copy", "delete", "multipart"] as const)("serializes %s with a conditional write", async (mutation) => {
    const storage = await fsStorage()
    const [, original] = await storage.put("target.txt", "original")
    await storage.put("source.txt", "copied")
    const [, upload] = await storage.createMultipartUpload("target.txt")
    const [, part] = await upload!.uploadPart(1, "multipart")
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pulling = new Promise<void>((resolve) => { started = resolve })
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        started()
        await gate
        controller.enqueue(new TextEncoder().encode("conditional"))
        controller.close()
      },
    }, { highWaterMark: 0 })
    const writing = storage.put("target.txt", stream, { ifMatch: original!.httpEtag })
    await pulling
    let completed = false
    const changing = (mutation === "copy"
      ? storage.copy("source.txt", "target.txt", { overwrite: true })
      : mutation === "delete" ? storage.delete("target.txt") : upload!.complete([part!]))
      .then((result) => { completed = true; return result })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(completed).toBe(false)
    }
    finally {
      release()
      await Promise.all([writing, changing])
    }
    expect(await text(storage, "target.txt")).toBe(mutation === "copy" ? "copied" : mutation === "multipart" ? "multipart" : undefined)
  })

  it("keeps the other write when blobDocument() saves over it", async () => {
    const storage = await fsStorage()
    const adapter = blobDocument(storage)
    const context = { authority: "memory", definition: "drafts", documentId: "a.md" } as const
    const save = { editors: [], reason: "idle" as const }
    const { digest } = await adapter.save(context, { body: "# Draft" }, { ...save, ifDigest: null })
    const get = storage.get
    storage.get = async (pathname) => {
      const result = await get(pathname)
      await storage.put(pathname, "# Someone else")
      return result
    }

    await expect(adapter.save(context, { body: "# Room" }, { ...save, ifDigest: digest }))
      .rejects.toMatchObject({ code: "REALTIME_DOCUMENT_CONFLICT" })
    storage.get = get
    expect(await text(storage, "a.md")).toBe("# Someone else")
  })
})

describe("put() condition checks", () => {
  it("throws BLOB_PUT_CONDITION_UNSUPPORTED for a driver without putIf", async () => {
    const driver: BlobDriverAdapter<object> = {
      name: "custom",
      options: {},
      async delete() {},
      get: async () => null,
      getArrayBuffer: async () => null,
      head: async () => null,
      list: async () => ({ blobs: [], hasMore: false }),
      put: vi.fn(),
    }
    const custom = createBlobStorage(driver, "default", { images: false })
    await expect(custom.put("a.txt", "a", { overwrite: false })).rejects.toMatchObject({ code: "BLOB_PUT_CONDITION_UNSUPPORTED", message: expect.stringContaining("\"custom\"") })
    expect(driver.put).not.toHaveBeenCalled()
  })

  it("does not type ifMatch together with overwrite: false", async () => {
    const storage = await fsStorage()
    // @ts-expect-error `ifMatch` and `overwrite: false` exclude each other.
    await storage.put("a.txt", "a", { ifMatch: "\"x\"", overwrite: false })
  })
})

describe("put() with a condition on Cloudflare R2", () => {
  it("sends onlyIf to the binding and returns BLOB_CONFLICT when R2 writes nothing", async () => {
    const put = vi.fn(async (key: string, _value: unknown, options: { onlyIf?: unknown }) => options.onlyIf && JSON.stringify(options.onlyIf).includes("old")
      ? null
      : { httpEtag: "\"new\"", key, size: 1 })
    vi.stubGlobal("BUCKET", { put })
    const storage = createBlobStorage(createCloudflareDriver({ binding: "BUCKET", driver: "cloudflare" }), "default", { images: false })

    expect((await storage.put("a.txt", "a", { ifMatch: "\"current\"" }))[1]).toMatchObject({ httpEtag: "\"new\"" })
    expect(put).toHaveBeenLastCalledWith("a.txt", "a", expect.objectContaining({ onlyIf: { etagMatches: "current" } }))

    const [conflict] = await storage.put("a.txt", "a", { ifMatch: "\"old\"" })
    expect(conflict?.code).toBe("BLOB_CONFLICT")

    await storage.put("b.txt", "b", { overwrite: false })
    expect(put).toHaveBeenLastCalledWith("b.txt", "b", expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }))

    await storage.put("c.txt", "c")
    expect(put.mock.lastCall?.[2]).not.toHaveProperty("onlyIf")
  })
})

describe("put() with a condition through the runtime blob export on Cloudflare", () => {
  it("reaches the R2 binding, with the key length check", async () => {
    const put = vi.fn(async (key: string) => key === "taken.txt" ? null : { httpEtag: "\"new\"", key, size: 1 })
    setBlobRuntimeConfig({ store: { binding: "BLOB", bucketName: "assets", driver: "cloudflare" } })
    setActiveCloudflareEnv({ BLOB: { put } })
    try {
      expect((await blob.put("new.txt", "a", { overwrite: false }))[0]).toBeUndefined()
      expect(put).toHaveBeenLastCalledWith("new.txt", "a", expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }))
      expect((await blob.put("taken.txt", "a", { overwrite: false }))[0]?.code).toBe("BLOB_CONFLICT")
      expect((await blob.put("a".repeat(1025), "a", { overwrite: false }))[0]?.code).toBe("BLOB_PATHNAME_TOO_LONG")
    }
    finally {
      clearActiveCloudflareEnv()
      setBlobRuntimeConfig(undefined)
    }
  })
})

describe("put() with a condition through files-sdk", () => {
  function filesStorage(conditional: { create: boolean, replace: boolean }) {
    const upload = vi.fn(async (key: string, _body: unknown, options: { condition?: { type: string, etag?: string } }) => {
      if (options.condition?.type === "replace" && options.condition.etag !== "current") {
        throw Object.assign(new Error("PreconditionFailed"), { code: "Conflict" })
      }
      return { etag: "next", key, size: 1 }
    })
    class FakeFiles {
      capabilities = { conditional }
      upload = upload
      async url() { return undefined }
    }
    const storage = createBlobStorage(createFilesSdkDriver({ bucket: "bucket", driver: "s3" }, async () => ({} as never), FakeFiles as never), "default", { images: false })
    return { storage, upload }
  }

  it("passes the condition with a bare ETag and maps Conflict to BLOB_CONFLICT", async () => {
    const { storage, upload } = filesStorage({ create: true, replace: true })
    const [, object] = await storage.put("a.txt", new Blob(["a"]).stream(), { ifMatch: "\"current\"" })
    expect(object).toMatchObject({ httpEtag: "next" })
    // A conditional upload refuses a stream, so the driver reads it first.
    expect(upload).toHaveBeenLastCalledWith("a.txt", expect.any(ArrayBuffer), expect.objectContaining({ condition: { etag: "current", type: "replace" } }))

    const [conflict] = await storage.put("a.txt", "a", { ifMatch: "old" })
    expect(conflict?.code).toBe("BLOB_CONFLICT")
  })

  it("maps a deleted replace target to conflict but preserves create failures", async () => {
    const { storage, upload } = filesStorage({ create: true, replace: true })
    upload.mockRejectedValue(Object.assign(new Error("The specified key does not exist."), { code: "NotFound" }))
    expect((await storage.put("deleted.txt", "a", { ifMatch: "current" }))[0]?.code).toBe("BLOB_CONFLICT")
    expect((await storage.put("new.txt", "a", { overwrite: false }))[0]?.code).toBe("BLOB_OPERATION_FAILED")
    upload.mockRejectedValue(Object.assign(new Error("The specified bucket does not exist."), { code: "NotFound", cause: { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } } }))
    expect((await storage.put("a.txt", "a", { ifMatch: "current" }))[0]?.code).toBe("BLOB_OPERATION_FAILED")
  })

  it("throws BLOB_PUT_CONDITION_UNSUPPORTED when the adapter cannot check the condition", async () => {
    const { storage, upload } = filesStorage({ create: false, replace: false })
    await expect(storage.put("a.txt", "a", { overwrite: false })).rejects.toMatchObject({ code: "BLOB_PUT_CONDITION_UNSUPPORTED" })
    expect(upload).not.toHaveBeenCalled()
  })
})

describe("put() with a condition on Netlify Blobs", () => {
  it("sends onlyIfMatch and onlyIfNew, and returns BLOB_CONFLICT for an unmodified entry", async () => {
    const storage = createBlobStorage(createNetlifyDriver({ driver: "netlify-blobs", name: "store", siteID: "site", token: "token" }), "default", { images: false })
    netlify.set.mockResolvedValueOnce({ etag: "\"next\"", modified: true })
    expect((await storage.put("a.txt", "a", { ifMatch: "\"current\"" }))[1]).toMatchObject({ httpEtag: "\"next\"" })
    expect(netlify.set).toHaveBeenLastCalledWith("a.txt", "a", expect.objectContaining({ onlyIfMatch: "\"current\"" }))

    netlify.set.mockResolvedValueOnce({ modified: false })
    const [conflict] = await storage.put("b.txt", "b", { overwrite: false })
    expect(conflict?.code).toBe("BLOB_CONFLICT")
    expect(netlify.set).toHaveBeenLastCalledWith("b.txt", "b", expect.objectContaining({ onlyIfNew: true }))
  })
})

describe("put() with a condition on Vercel Blob", () => {
  const object = { contentType: "text/plain", etag: "\"next\"", pathname: "a.txt", url: "https://store.private.blob.vercel-storage.com/a.txt" }

  it("sends ifMatch and maps a failed precondition to BLOB_CONFLICT", async () => {
    const storage = createBlobStorage(createVercelDriver({ access: "private", allowOverwrite: false, driver: "vercel", token: "token" }), "default", { images: false })
    vercel.put.mockResolvedValueOnce(object)
    const [, written] = await storage.put("a.txt", "a", { ifMatch: "\"current\"" })
    expect(written satisfies BlobObject | undefined).toMatchObject({ httpEtag: "\"next\"" })
    expect(vercel.put).toHaveBeenLastCalledWith("a.txt", "a", expect.objectContaining({ allowOverwrite: true, ifMatch: "\"current\"" }))

    vercel.put.mockRejectedValueOnce(new BlobPreconditionFailedError())
    expect((await storage.put("a.txt", "a", { ifMatch: "\"old\"" }))[0]?.code).toBe("BLOB_CONFLICT")
  })

  it("creates with allowOverwrite: false and maps an existing blob to BLOB_CONFLICT", async () => {
    const storage = createBlobStorage(createVercelDriver({ access: "private", driver: "vercel", token: "token" }), "default", { images: false })
    vercel.put.mockRejectedValueOnce(new BlobError("This blob already exists, use `allowOverwrite: true` if you want to overwrite it."))
    expect((await storage.put("a.txt", "a", { overwrite: false }))[0]?.code).toBe("BLOB_CONFLICT")
    expect(vercel.put).toHaveBeenLastCalledWith("a.txt", "a", expect.objectContaining({ allowOverwrite: false }))
    expect(vercel.put.mock.lastCall?.[2]).not.toHaveProperty("ifMatch")
  })
})
