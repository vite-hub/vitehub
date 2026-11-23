import { afterEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/cloudflare-native.ts"
import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "../src/runtime/state.ts"
import { createBlobStorage } from "../src/storage.ts"

interface ListCall { cursor?: string, delimiter?: string, limit?: number, prefix?: string }

function r2Bucket(keys: string[]) {
  const calls: ListCall[] = []
  const sorted = [...keys].sort()
  const bucket = {
    calls,
    async list(options: ListCall = {}) {
      calls.push(options)
      const limit = options.limit ?? 1000
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("list: MaxKeys params must be positive integer <= 1000. (10022)")
      }
      const start = options.cursor ? Number(options.cursor) : 0
      const page = sorted.filter(key => key.startsWith(options.prefix ?? "")).slice(start, start + limit)
      const next = start + page.length
      const truncated = next < sorted.length
      return {
        objects: page.map(key => ({ httpEtag: "\"etag\"", key, size: 1, uploaded: new Date(0) })),
        truncated,
        ...(truncated ? { cursor: String(next) } : {}),
      }
    },
  }
  return bucket
}

function r2Storage(keys: string[]) {
  const bucket = r2Bucket(keys)
  setActiveCloudflareEnv({ BLOB: bucket })
  const storage = createBlobStorage(createDriver({ binding: "BLOB", bucketName: "assets", driver: "cloudflare" }), "default")
  return { bucket, storage }
}

afterEach(() => clearActiveCloudflareEnv())

describe("Cloudflare R2 blob.list({ limit })", () => {
  it("asks R2 for at most 1000 keys when the limit is larger", async () => {
    const keys = Array.from({ length: 1500 }, (_, index) => `file-${String(index).padStart(4, "0")}.txt`)
    const { bucket, storage } = r2Storage(keys)

    const [error, page] = await storage.list({ limit: 5000 })
    expect(error).toBeUndefined()
    expect(page!.blobs).toHaveLength(1000)
    expect(page!.hasMore).toBe(true)
    expect(bucket.calls.at(-1)?.limit).toBe(1000)

    const [nextError, next] = await storage.list({ cursor: page!.cursor, limit: 5000 })
    expect(nextError).toBeUndefined()
    expect(next).toMatchObject({ cursor: undefined, hasMore: false })
    expect([...page!.blobs, ...next!.blobs].map(object => object.pathname)).toEqual(keys)
  })

  it("returns an empty page for limit 0, as the fs driver does", async () => {
    const { storage } = r2Storage(["a.txt", "b.txt"])
    const [error, page] = await storage.list({ limit: 0 })
    expect(error).toBeUndefined()
    expect(page).toMatchObject({ blobs: [], hasMore: true })

    const { storage: empty } = r2Storage([])
    const [emptyError, emptyPage] = await empty.list({ limit: 0 })
    expect(emptyError).toBeUndefined()
    expect(emptyPage).toMatchObject({ blobs: [], hasMore: false })
  })
})
