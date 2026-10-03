import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { blob } from "../src/index.ts"
import { blobDevFileHeader, blobDevHeader, blobDevHeaderValue, blobDevMaximumUploadBytes } from "../src/dev.ts"
import { handleBlobDevRequest, listBlobDevStores } from "../src/runtime/dev.ts"
import { setBlobRuntimeConfig, setBlobRuntimeStorage } from "../src/runtime/state.ts"

// The runtime handler imports the package entries, so the test runs the real Blob storage on the fs driver.
vi.mock("@vite-hub/blob", async () => await import("../src/index.ts"))
vi.mock("@vite-hub/blob/runtime/state", async () => await import("../src/runtime/state.ts"))

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-blob-dev-"))
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

function devRequest(body: unknown, init: { headers?: Record<string, string>, method?: string } = {}): Request {
  const method = init.method ?? "POST"
  return new Request("http://localhost/_vitehub/blob/dev", {
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", [blobDevHeader]: blobDevHeaderValue, ...init.headers },
    method,
  })
}

async function run(body: unknown): Promise<{ body: Record<string, unknown>, status: number }> {
  const response = await handleBlobDevRequest(devRequest(body))
  expect(response.headers.get("cache-control")).toBe("no-store")
  return { body: await response.json() as Record<string, unknown>, status: response.status }
}

const binary = Uint8Array.from([0, 255, 1, 128, 10, 13, 0xef, 0xbb, 0xbf, 0xc3, 0x28])

describe("Blob dev runtime handler", () => {
  it("streams downloads without reading the whole file into memory", async () => {
    await run({ operation: "put", pathname: "stream.txt", data: Buffer.from("streamed").toString("base64") })
    const file = (await blob.get("stream.txt"))[1]!
    const buffered = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("must stream"))
    const get = vi.spyOn(blob, "get").mockResolvedValue([null, file])
    try {
      const response = await handleBlobDevRequest(devRequest({ operation: "get", pathname: "stream.txt" }))
      expect(await response.text()).toBe("streamed")
      expect(buffered).not.toHaveBeenCalled()
    }
    finally { get.mockRestore(); buffered.mockRestore() }
  })
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
    expect((await blob.head("recent.txt"))[0]?.code).toBe("BLOB_NOT_FOUND")
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

    const response = await handleBlobDevRequest(devRequest({ operation: "get", pathname: "files/raw.bin" }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(JSON.parse(decodeURIComponent(response.headers.get(blobDevFileHeader)!))).toEqual({
      contentType: "application/x-test",
      pathname: "files/raw.bin",
      size: binary.byteLength,
      store: "default",
    })
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary)

    const replaced = await run({ data: "", operation: "put", pathname: "files/raw.bin" })
    expect(replaced.body).toMatchObject({ created: false, object: { pathname: "files/raw.bin", size: 0 } })
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

  it("rejects invalid bodies, invalid base64, and oversized uploads", async () => {
    await expect(run("not json")).resolves.toMatchObject({ status: 400 })
    await expect(run({ operation: "sign", pathname: "a.txt" })).resolves.toMatchObject({ status: 400 })
    await expect(run({ operation: "head" })).resolves.toEqual({ body: { error: { message: "The head operation requires a pathname." } }, status: 400 })
    await expect(run({ limit: 251, operation: "list" })).resolves.toMatchObject({ status: 400 })
    await expect(run({ operation: "put", pathname: "a.txt" })).resolves.toMatchObject({ status: 400 })
    await expect(run({ data: "not base64!", operation: "put", pathname: "a.txt" })).resolves.toEqual({
      body: { error: { message: "The file data is not valid base64." } },
      status: 400,
    })
    const oversized = "A".repeat(Math.ceil(blobDevMaximumUploadBytes / 3 + 1) * 4)
    await expect(run({ data: oversized, operation: "put", pathname: "a.txt" })).resolves.toMatchObject({
      body: { error: { code: "BLOB_DEV_UPLOAD_TOO_LARGE" } },
      status: 413,
    })
  })

  it("reports a disabled Blob runtime", async () => {
    setBlobRuntimeConfig(false)
    await expect(run({ operation: "list" })).resolves.toMatchObject({ body: { error: { code: "BLOB_DISABLED" } }, status: 409 })
  })

  it("rejects requests without the dev header or from another origin", async () => {
    const withoutHeader = await handleBlobDevRequest(new Request("http://localhost/_vitehub/blob/dev", {
      body: JSON.stringify({ operation: "list" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    expect(withoutHeader.status).toBe(403)

    const crossOrigin = await handleBlobDevRequest(devRequest({ operation: "list" }, { headers: { origin: "https://evil.example" } }))
    expect(crossOrigin.status).toBe(403)

    const get = await handleBlobDevRequest(devRequest(undefined, { method: "GET" }))
    expect(get.status).toBe(405)
  })
})
