import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3Event } from "h3"
import sharp from "sharp"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { blob } from "../src/index.ts"
import { blobOperations } from "../src/operations.ts"
import { blobDevMaximumUploadBytes } from "../src/results.ts"
import { listBlobDevStores } from "../src/runtime/operations.ts"
import { setBlobRuntimeConfig, setBlobRuntimeStorage } from "../src/runtime/state.ts"

// The runtime handler imports the package entries, so the test runs the real Blob storage on the fs driver.
vi.mock("@vite-hub/blob", async () => await import("../src/index.ts"))
vi.mock("@vite-hub/blob/runtime/state", async () => await import("../src/runtime/state.ts"))

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-blob-ops-"))
  setBlobRuntimeConfig({
    store: { base: join(base, "default"), driver: "fs" },
    stores: {
      archive: { base: join(base, "archive"), driver: "fs" },
      default: { base: join(base, "default"), driver: "fs" },
      media: { base: join(base, "media"), driver: "fs" },
    },
  })
})

afterEach(async () => {
  setBlobRuntimeConfig(undefined)
  setBlobRuntimeStorage(undefined)
  await rm(base, { force: true, recursive: true })
})

const registry = createOperationRegistry([{ operations: blobOperations }])
const access = { mode: "local", sections: "all" } as const

/** Runs `blob.<operation>` as the RPC does, and maps a failure to the status and error that it reports. */
async function run(body: Record<string, unknown>): Promise<{ body: Record<string, unknown>, status: number }> {
  const { operation, ...input } = body
  const result = await runOperation(registry, `blob.${String(operation)}`, input, { access, surface: "cli", user: null })
  return result.ok
    ? { body: result.value as Record<string, unknown>, status: 200 }
    : { body: { error: { code: result.code, message: result.message } }, status: result.status }
}

const binary = Uint8Array.from([0, 255, 1, 128, 10, 13, 0xef, 0xbb, 0xbf, 0xc3, 0x28])

describe("blob operations", () => {
  it("reports the pre-write metadata result even when it is stale", async () => {
    await run({ operation: "put", pathname: "recent.txt", data: Buffer.from("original").toString("base64") })
    const missing = await blob.head("absent.txt")
    const head = vi.spyOn(blob, "head").mockResolvedValue(missing)
    try {
      expect(await run({ operation: "put", pathname: "recent.txt", data: Buffer.from("replacement").toString("base64") })).toMatchObject({ status: 200, body: { created: true } })
    }
    finally { head.mockRestore() }
    const [error, file] = await blob.get("recent.txt")
    expect(error).toBeNull()
    expect(await file?.text()).toBe("replacement")
  })

  it("deletes even when metadata temporarily reports a missing blob", async () => {
    await run({ operation: "put", pathname: "recent.txt", data: Buffer.from("recent").toString("base64") })
    const missing = await blob.head("absent.txt")
    const head = vi.spyOn(blob, "head").mockResolvedValue(missing)
    const del = vi.spyOn(blob, "del")
    try {
      expect(await run({ operation: "del", pathname: "recent.txt" })).toMatchObject({ status: 200, body: { deleted: false } })
      expect(del).toHaveBeenCalledWith("recent.txt")
    }
    finally { head.mockRestore(); del.mockRestore() }
    expect(await blob.head("recent.txt")).toEqual([null, null])
  })

  it.each(["", "   "])("rejects store %j without changing the default store", async (store) => {
    await run({ data: Buffer.from("original").toString("base64"), operation: "put", pathname: "original.txt" })
    expect((await run({ operation: "del", pathname: "original.txt", store })).status).toBe(400)
    expect((await run({ data: "", operation: "put", pathname: "unexpected.txt", store })).status).toBe(400)
    expect((await run({ operation: "list" })).body).toMatchObject({ blobs: [{ pathname: "original.txt" }] })
  })

  it("lists stores in the Console order", async () => {
    await expect(listBlobDevStores()).resolves.toEqual([
      { driver: "fs", name: "default" },
      { driver: "fs", name: "archive" },
      { driver: "fs", name: "media" },
    ])
  })

  it("keeps binary data unchanged through put and get", async () => {
    const created = await run({ contentType: "application/x-test", data: Buffer.from(binary).toString("base64"), operation: "put", pathname: "files/raw.bin" })
    expect(created).toMatchObject({
      body: { created: true, object: { contentType: "application/x-test", pathname: "files/raw.bin", size: binary.byteLength }, store: "default" },
      status: 200,
    })

    const downloaded = await run({ operation: "get", pathname: "files/raw.bin" })
    expect(downloaded).toMatchObject({ body: { contentType: "application/x-test", pathname: "files/raw.bin", size: binary.byteLength, store: "default" }, status: 200 })
    expect(new Uint8Array(Buffer.from(String(downloaded.body.data), "base64"))).toEqual(binary)

    const replaced = await run({ data: "", operation: "put", pathname: "files/raw.bin" })
    expect(replaced.body).toMatchObject({ created: false, object: { pathname: "files/raw.bin", size: 0 } })
  })

  it("shows media records and cached variants", async () => {
    const png = await sharp({ create: { background: "#336699", channels: 3, height: 300, width: 600 } }).png().toBuffer()
    expect(await blob.media.put("images/hero.png", png, { alt: "Hero" })).toMatchObject([null, { width: 600 }])
    const media = await run({ operation: "media", pathname: "images/hero.png" })
    expect(media).toMatchObject({ body: { record: { alt: "Hero", contentType: "image/png", height: 300, pathname: "images/hero.png", width: 600 }, store: "default" }, status: 200 })
    expect(await run({ operation: "variants", pathname: "images/hero.png" })).toEqual({ body: { pathname: "images/hero.png", store: "default", variants: [] }, status: 200 })
    await blob.serve(new H3Event(new Request("https://example.test/")), "images/hero.png", { variant: { width: 128 } })
    const variants = await run({ operation: "variants", pathname: "images/hero.png" })
    expect(variants.body.variants).toEqual([expect.objectContaining({ contentType: "image/webp", key: "image:v1;src=original;out=128x64;fmt=webp;q=75;engine=sharp", source: "images/hero.png" })])
    expect(await run({ operation: "media", pathname: "images/missing.png" })).toMatchObject({ body: { error: { code: "BLOB_NOT_FOUND" } }, status: 404 })
    expect(await run({ operation: "variants", pathname: "images/missing.png" })).toMatchObject({ status: 404 })
  })

  it("lists, reads metadata, and deletes blobs of a named store", async () => {
    await run({ data: Buffer.from("a").toString("base64"), operation: "put", pathname: "docs/a.txt", store: "media" })
    await run({ data: Buffer.from("bb").toString("base64"), operation: "put", pathname: "docs/b.txt", store: "media" })
    await run({ data: Buffer.from("c").toString("base64"), operation: "put", pathname: "other.txt", store: "media" })

    const page = await run({ limit: 1, operation: "list", prefix: "docs/", store: "media" })
    expect(page.body).toMatchObject({ blobs: [{ pathname: "docs/a.txt", size: 1 }], hasMore: true, limit: 1, prefix: "docs/", store: "media", stores: ["default", "archive", "media"] })
    expect(page.body.blobs).toEqual([expect.not.objectContaining({ url: expect.anything() })])
    const next = await run({ cursor: page.body.cursor, limit: 1, operation: "list", prefix: "docs/", store: "media" })
    expect(next.body).toMatchObject({ blobs: [{ pathname: "docs/b.txt", size: 2 }], hasMore: false })

    const head = await run({ operation: "head", pathname: "docs/b.txt", store: "media" })
    expect(head.body).toMatchObject({ object: { contentType: "text/plain; charset=utf-8", pathname: "docs/b.txt", size: 2 }, store: "media" })

    await expect(run({ operation: "del", pathname: "docs/b.txt", store: "media" })).resolves.toEqual({
      body: { deleted: true, pathname: "docs/b.txt", store: "media" },
      status: 200,
    })
    await expect(run({ operation: "del", pathname: "docs/b.txt", store: "media" })).resolves.toEqual({
      body: { deleted: false, pathname: "docs/b.txt", store: "media" },
      status: 200,
    })
    await expect(run({ operation: "list", store: "default" })).resolves.toMatchObject({ body: { blobs: [], hasMore: false, store: "default" } })
  })

  it("reports missing blobs and unknown stores", async () => {
    await expect(run({ operation: "head", pathname: "missing.txt" })).resolves.toEqual({
      body: { error: { code: "BLOB_NOT_FOUND", message: "Blob missing.txt was not found in store default." } },
      status: 404,
    })
    await expect(run({ operation: "get", pathname: "missing.txt" })).resolves.toMatchObject({ body: { error: { code: "BLOB_NOT_FOUND" } }, status: 404 })
    await expect(run({ operation: "list", store: "nope" })).resolves.toEqual({
      body: { error: { code: "BLOB_STORE_NOT_FOUND", message: "Blob store \"nope\" was not found. Stores: default, archive, media." } },
      status: 404,
    })
  })

  it("rejects invalid input, invalid base64, and oversized uploads", async () => {
    // There is no sign operation.
    await expect(run({ operation: "sign", pathname: "a.txt" })).resolves.toMatchObject({ body: { error: { code: "INTERNAL_R0021" } } })
    await expect(run({ operation: "head" })).resolves.toMatchObject({ body: { error: { code: "INTERNAL_R0022" } }, status: 400 })
    await expect(run({ limit: 251, operation: "list" })).resolves.toMatchObject({ status: 400 })
    await expect(run({ operation: "put", pathname: "a.txt" })).resolves.toMatchObject({ status: 400 })
    await expect(run({ data: "not base64!", operation: "put", pathname: "a.txt" })).resolves.toMatchObject({
      body: { error: { code: "BLOB_INVALID_INPUT", message: "The file data is not valid base64." } },
      status: 400,
    })
    const oversized = "A".repeat(Math.ceil(blobDevMaximumUploadBytes / 3 + 1) * 4)
    await expect(run({ data: oversized, operation: "put", pathname: "a.txt" })).resolves.toMatchObject({
      body: { error: { code: "BLOB_UPLOAD_TOO_LARGE" } },
      status: 413,
    })
  })

  it("refuses to return a blob over the limit", async () => {
    await run({ data: Buffer.from("x").toString("base64"), operation: "put", pathname: "big.bin" })
    const head = vi.spyOn(blob, "head").mockResolvedValue([null, { contentType: "application/octet-stream", customMetadata: {}, httpEtag: "\"etag\"", httpMetadata: {}, pathname: "big.bin", size: blobDevMaximumUploadBytes + 1, uploadedAt: new Date() }])
    try {
      await expect(run({ operation: "get", pathname: "big.bin" })).resolves.toMatchObject({ body: { error: { code: "BLOB_DOWNLOAD_TOO_LARGE" } }, status: 413 })
    }
    finally { head.mockRestore() }
  })

  it("replaces a blob by default and refuses to when overwrite is false", async () => {
    const data = Buffer.from("one").toString("base64")
    await expect(run({ data, operation: "put", pathname: "twice.txt" })).resolves.toMatchObject({ body: { created: true } })
    await expect(run({ data, operation: "put", overwrite: false, pathname: "twice.txt" })).resolves.toMatchObject({ body: { error: { code: "BLOB_EXISTS" } }, status: 409 })
    await expect(run({ data, operation: "put", pathname: "twice.txt" })).resolves.toMatchObject({ body: { created: false } })
    await expect(run({ data, operation: "put", overwrite: false, pathname: "fresh.txt" })).resolves.toMatchObject({ body: { created: true } })
  })

  it("returns at most the limit even when the head reports a smaller size", async () => {
    await run({ data: Buffer.from("x").toString("base64"), operation: "put", pathname: "grown.bin" })
    const get = vi.spyOn(blob, "get").mockResolvedValue([null, new File([new Uint8Array(blobDevMaximumUploadBytes + 1)], "grown.bin")])
    try {
      await expect(run({ operation: "get", pathname: "grown.bin" })).resolves.toMatchObject({ body: { error: { code: "BLOB_DOWNLOAD_TOO_LARGE" } }, status: 413 })
    }
    finally { get.mockRestore() }
  })

  it("refuses to write or delete the paths that ViteHub owns, and still reads them", async () => {
    const [putError] = await blob.put("_vitehub/internal.json", "{}")
    expect(putError).toBeNull()
    for (const pathname of ["_vitehub/internal.json", "./_vitehub/x.json", "docs/../_vitehub/x.json", "_VITEHUB/x.json"]) {
      await expect(run({ data: Buffer.from("x").toString("base64"), operation: "put", pathname })).resolves.toMatchObject({ body: { error: { code: "BLOB_RESERVED_PATH" } }, status: 403 })
      await expect(run({ operation: "del", pathname })).resolves.toMatchObject({ body: { error: { code: "BLOB_RESERVED_PATH" } }, status: 403 })
    }
    await expect(run({ operation: "head", pathname: "_vitehub/internal.json" })).resolves.toMatchObject({ status: 200 })
    await expect(run({ operation: "get", pathname: "_vitehub/internal.json" })).resolves.toMatchObject({ status: 200 })
    expect((await blob.head("_vitehub/internal.json"))[0]).toBeNull()
  })

  it("hides the objects of ViteHub unless asked, and folds a listing into folders", async () => {
    await run({ data: Buffer.from("a").toString("base64"), operation: "put", pathname: "docs/a.txt" })
    await blob.put("_vitehub/internal.json", "b")
    expect((await run({ operation: "list" })).body.blobs).toEqual([expect.objectContaining({ pathname: "docs/a.txt" })])
    expect((await run({ operation: "list", showVitehub: true })).body.blobs).toHaveLength(2)
    const folded = await run({ folded: true, operation: "list" })
    expect(folded.body).toMatchObject({ blobs: [], folders: ["docs"] })
  })

  it("answers only to a call whose access includes the blob section", async () => {
    const call = (sections: "all" | readonly string[]) => runOperation(registry, "blob.put", { data: Buffer.from("x").toString("base64"), pathname: "guarded.txt" }, { access: { mode: "app", sections }, surface: "console", user: null })
    expect(await call(["kv"])).toMatchObject({ code: "INTERNAL_R0023", ok: false, status: 403 })
    expect(await blob.head("guarded.txt")).toEqual([null, null])
    expect(await call(["blob"])).toMatchObject({ ok: true, value: { created: true } })
  })

  it("marks the upload as a write and the delete as destructive", () => {
    expect(blobOperations.map(operation => [operation.name, operation.kind])).toEqual([
      ["blob.list", "read"], ["blob.head", "read"], ["blob.get", "read"], ["blob.put", "write"], ["blob.del", "destructive"], ["blob.media", "read"], ["blob.variants", "read"],
    ])
  })

  it("reports a disabled Blob runtime", async () => {
    setBlobRuntimeConfig(false)
    await expect(run({ operation: "list" })).resolves.toMatchObject({ body: { error: { code: "BLOB_DISABLED" } }, status: 409 })
  })
})
