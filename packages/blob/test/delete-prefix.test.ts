import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDriver as createCloudflareDriver } from "../src/drivers/cloudflare-native.ts"
import { createDriver as createFsDriver } from "../src/drivers/fs.ts"
import { createBlobStorage } from "../src/storage.ts"

const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function fsStorage() {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-delete-prefix-"))
  tempDirs.push(base)
  return createBlobStorage(createFsDriver({ base, driver: "fs" }), "default")
}

async function pathnames(storage: Awaited<ReturnType<typeof fsStorage>>) {
  const [, page] = await storage.list()
  return page!.blobs.map(object => object.pathname).sort()
}

describe("blob.delete({ prefix }) on fs", () => {
  it("deletes every object under the prefix and returns the count", async () => {
    const storage = await fsStorage()
    for (const pathname of ["runs/1/a.json", "runs/1/b.json", "runs/1/deep/c.json", "runs/10/a.json", "keep.txt"]) {
      await storage.put(pathname, "x")
    }

    const [error, result] = await storage.delete({ prefix: "runs/1/" })
    expect(error).toBeUndefined()
    expect(result).toEqual({ deleted: 3 })
    expect(await pathnames(storage)).toEqual(["keep.txt", "runs/10/a.json"])
  })

  it("matches a prefix that is not a whole folder, as list() does", async () => {
    const storage = await fsStorage()
    for (const pathname of ["runs/1/a.json", "runs/10/a.json", "rundown.txt"]) await storage.put(pathname, "x")

    const [, result] = await storage.delete({ prefix: "runs/1" })
    expect(result).toEqual({ deleted: 2 })
    expect(await pathnames(storage)).toEqual(["rundown.txt"])
  })

  it("returns zero for a prefix without objects", async () => {
    const storage = await fsStorage()
    await storage.put("a.txt", "x")
    expect(await storage.delete({ prefix: "missing/" })).toEqual([undefined, { deleted: 0 }])
  })

  it("clears the cached image variants of each deleted object", async () => {
    const storage = await fsStorage()
    await storage.put("photos/a.txt", "x")
    const driver = createFsDriver({ base: tempDirs[0]!, driver: "fs" })
    // The derived cache keys a variant by the hash of its source pathname.
    await driver.put(`_vitehub/derived/${await sha256(JSON.stringify("photos/a.txt"))}/variant`, "cached")

    const [, result] = await storage.delete({ prefix: "photos/" })
    expect(result).toEqual({ deleted: 1 })
    const [, after] = await storage.list({ prefix: "_vitehub/derived/" })
    expect(after!.blobs).toEqual([])
  })

  it("keeps reserved ViteHub objects unless the prefix names them", async () => {
    const storage = await fsStorage()
    const driver = createFsDriver({ base: tempDirs[0]!, driver: "fs" })
    await storage.put("_vitehub-notes.txt", "x")
    await driver.put("_vitehub/media/records/a.json", "{}")

    const [, result] = await storage.delete({ prefix: "_vitehub" })
    expect(result).toEqual({ deleted: 1 })
    expect(await pathnames(storage)).toEqual(["_vitehub/media/records/a.json"])

    expect(await storage.delete({ prefix: "_vitehub/media/" })).toEqual([undefined, { deleted: 1 }])
    expect(await pathnames(storage)).toEqual([])
  })

  it("rejects an empty or unsafe prefix before it lists anything", async () => {
    const storage = await fsStorage()
    await storage.put("a.txt", "x")
    await expect(storage.delete({ prefix: "" })).rejects.toMatchObject({ code: "BLOB_R0034", status: 400 })
    await expect(storage.delete({} as { prefix: string })).rejects.toMatchObject({ code: "BLOB_R0034" })
    await expect(storage.delete({ prefix: "../a" })).rejects.toMatchObject({ code: "BLOB_R0034" })
    expect(await pathnames(storage)).toEqual(["a.txt"])
  })
})

describe("blob.delete({ prefix }) on Cloudflare R2", () => {
  it("reads every list page before it deletes, in batches of at most 100 keys", async () => {
    const keys = new Set(Array.from({ length: 250 }, (_, index) => `logs/${String(index).padStart(3, "0")}.txt`))
    keys.add("other.txt")
    const deletedWhileListing: string[] = []
    let listing = false
    const bucket = {
      delete: vi.fn(async (key: string) => {
        if (listing) deletedWhileListing.push(key)
        keys.delete(key)
      }),
      list: vi.fn(async ({ cursor, limit = 1000, prefix = "" }: { cursor?: string, limit?: number, prefix?: string }) => {
        listing = true
        const matching = [...keys].filter(key => key.startsWith(prefix)).sort()
        const start = cursor ? Number(cursor) : 0
        const page = matching.slice(start, start + Math.min(limit, 100))
        const truncated = start + page.length < matching.length
        if (!truncated) listing = false
        return {
          cursor: truncated ? String(start + page.length) : undefined,
          objects: page.map(key => ({ customMetadata: {}, httpMetadata: {}, key, size: 1, uploaded: new Date(0) })),
          truncated,
        }
      }),
    }
    vi.stubGlobal("BUCKET", bucket)
    const driver = createCloudflareDriver({ binding: "BUCKET", driver: "cloudflare-r2" })
    const deleteBatch = vi.spyOn(driver, "delete")
    const storage = createBlobStorage(driver, "default", { images: false })

    const [error, result] = await storage.delete({ prefix: "logs/" })
    expect(error).toBeUndefined()
    expect(result).toEqual({ deleted: 250 })
    expect([...keys]).toEqual(["other.txt"])
    expect(deletedWhileListing).toEqual([])
    const userBatches = deleteBatch.mock.calls.map(([batch]) => batch).filter(batch => Array.isArray(batch) && batch[0]?.startsWith("logs/"))
    expect(userBatches.map(batch => batch.length)).toEqual([100, 100, 50])
  })

  it("returns BLOB_OPERATION_FAILED when the provider fails", async () => {
    vi.stubGlobal("BUCKET", { list: vi.fn(async () => { throw new Error("R2 down") }) })
    const storage = createBlobStorage(createCloudflareDriver({ binding: "BUCKET", driver: "cloudflare-r2" }), "default", { images: false })
    const [error, result] = await storage.delete({ prefix: "logs/" })
    expect(result).toBeUndefined()
    expect(error?.code).toBe("BLOB_OPERATION_FAILED")
  })
})

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}
