import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { setBlobRequestBodyLimit } from "../src/internal/host-limits.ts"
import { createBlobStorage } from "../src/storage.ts"
import { hubBlob } from "../src/vite.ts"

import type { BlobDriverAdapter, BlobMultipartEvent, BlobObject } from "../src/types.ts"

function memoryDriver(name: string) {
  const objects = new Map<string, Blob>()
  const puts: string[] = []
  const object = (pathname: string, body: Blob): BlobObject => ({ contentType: body.type, customMetadata: {}, httpEtag: "\"1\"", httpMetadata: {}, pathname, size: body.size, uploadedAt: new Date(0) })
  const driver: BlobDriverAdapter<object> = {
    name,
    options: {},
    async delete(pathnames) { for (const pathname of [pathnames].flat()) objects.delete(pathname) },
    async get(pathname) { return objects.get(pathname) ?? null },
    async getArrayBuffer(pathname) { return await objects.get(pathname)?.arrayBuffer() ?? null },
    async head(pathname) { const body = objects.get(pathname); return body ? object(pathname, body) : null },
    async list() { return { blobs: [], hasMore: false } },
    async put(pathname, body) {
      puts.push(pathname)
      const blob = body instanceof Blob ? body : new Blob([typeof body === "string" ? body : new Uint8Array(0)])
      objects.set(pathname, blob)
      return object(pathname, blob)
    },
  }
  return { driver, puts }
}

const mb = 1_000_000

function formRequest(bytes: number) {
  const form = new FormData()
  form.append("files", new File([new Uint8Array(bytes)], "file.bin"))
  return { req: new Request("http://localhost/api/files", { body: form, method: "POST" }) }
}

describe("Cloudflare R2 object keys", () => {
  it("returns BLOB_PATHNAME_TOO_LONG above 1024 UTF-8 bytes, before the driver call", async () => {
    const { driver, puts } = memoryDriver("cloudflare-r2")
    const storage = createBlobStorage(driver, "default")

    const [error] = await storage.put("k".repeat(1025), "x")
    expect(error).toMatchObject({ code: "BLOB_PATHNAME_TOO_LONG", details: { operation: "put", store: "default" } })
    expect((error?.cause as Error).message).toBe("The pathname is 1025 bytes in UTF-8. Cloudflare R2 accepts object keys of at most 1024 bytes.")
    expect(puts).toEqual([])
    // Two bytes per character in UTF-8, so 513 characters are 1026 bytes.
    expect((await storage.put("é".repeat(513), "x"))[0]?.code).toBe("BLOB_PATHNAME_TOO_LONG")
    for (const [readError] of [await storage.get("k".repeat(1025)), await storage.head("k".repeat(1025)), await storage.del("k".repeat(1025))]) {
      expect(readError?.code).toBe("BLOB_PATHNAME_TOO_LONG")
    }

    expect((await storage.put("k".repeat(1024), "x"))[0]).toBeNull()
    expect(puts).toEqual(["k".repeat(1024)])
  })

  it("keeps other drivers unchanged", async () => {
    const { driver } = memoryDriver("s3")
    expect((await createBlobStorage(driver, "default").put("k".repeat(1025), "x"))[0]).toBeNull()
  })
})

describe("request body limit of a dev server for Vercel", () => {
  afterEach(() => setBlobRequestBodyLimit(undefined))

  it("answers 413 for an upload above 4.5 MB, as Vercel does", async () => {
    const { driver, puts } = memoryDriver("vercel-blob")
    const storage = createBlobStorage(driver, "default")
    setBlobRequestBodyLimit(4_500_000)

    await expect(storage.handleUpload(formRequest(5 * mb))).rejects.toMatchObject({
      message: expect.stringMatching(/^The request body is \d+ bytes\. A Vercel Function accepts at most 4500000 bytes/),
      statusCode: 413,
    })
    const part: BlobMultipartEvent = {
      context: { params: { action: "upload", pathname: "video.mp4" } },
      req: new Request("http://localhost/api/files/multipart/upload/video.mp4?uploadId=1&partNumber=1", { body: new Uint8Array(5 * mb), method: "PUT" }),
    }
    await expect(storage.handleMultipartUpload(part)).rejects.toMatchObject({ statusCode: 413 })
    expect(puts).toEqual([])

    const [error, objects] = await storage.handleUpload(formRequest(4 * mb))
    expect(error).toBeNull()
    expect(objects).toHaveLength(1)
  })

  it("reads any body size without a limit", async () => {
    const { driver } = memoryDriver("vercel-blob")
    const [error] = await createBlobStorage(driver, "default").handleUpload(formRequest(5 * mb))
    expect(error).toBeNull()
  })
})

describe("generated Nitro plugin", () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  async function nitroPlugin(config: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-host-limits-"))
    roots.push(root)
    const plugin = hubBlob({ driver: "fs" })
    // SAFETY: These are Vite hook handlers returned by hubBlob.
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ build: { outDir: "dist" }, plugins: [{ name: "nitro:main" }], root, ...config })
    return readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
  }

  it("sets the Vercel request body limit only in a dev server for Vercel", async () => {
    expect(await nitroPlugin({ command: "serve", vitehub: { preset: "vercel" } })).toContain("setBlobRequestBodyLimit(4500000)")
    expect(await nitroPlugin({ command: "serve", nitro: { preset: "vercel" } })).toContain("setBlobRequestBodyLimit(4500000)")
    expect(await nitroPlugin({ command: "serve", vitehub: { preset: "node" } })).not.toContain("setBlobRequestBodyLimit")
    expect(await nitroPlugin({ command: "build", vitehub: { preset: "vercel" } })).not.toContain("setBlobRequestBodyLimit")
  })
})
