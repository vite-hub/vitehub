import { describe, expect, it } from "vitest"

import { createFilesSdkDriver } from "../src/drivers/files-sdk.ts"
import { createBlobStorage } from "../src/storage.ts"

interface ListCall { cursor?: string, delimiter?: string, limit: number, prefix?: string }

function filesSdkStorage(keys: string[], delimiter: "slash" | false) {
  const calls: ListCall[] = []
  const sorted = [...keys].sort()
  class Files {
    capabilities = { delimiter }
    async list(options: ListCall) {
      calls.push(options)
      if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("The provider requires a positive page size.")
      const start = options.cursor ? Number(options.cursor) : 0
      const prefix = options.prefix ?? ""
      const entries = [...new Set(sorted.filter(key => key.startsWith(prefix)).map((key) => {
        const slash = options.delimiter ? key.indexOf(options.delimiter, prefix.length) : -1
        return slash < 0 ? key : key.slice(0, slash + 1)
      }))]
      const page = entries.slice(start, start + options.limit)
      const next = start + page.length
      return {
        items: page.filter(key => !key.endsWith("/")).map(key => ({ etag: "etag", key, lastModified: "2026-01-01T00:00:00.000Z", metadata: {}, size: 1, contentType: "text/plain" })),
        ...(options.delimiter ? { prefixes: page.filter(key => key.endsWith("/")) } : {}),
        ...(next < entries.length ? { cursor: String(next) } : {}),
      }
    }
  }
  // SAFETY: The test class has the only files-sdk methods that list() calls.
  const driver = createFilesSdkDriver({ bucket: "assets", driver: "s3" } as never, () => ({}) as never, Files as never)
  return { calls, storage: createBlobStorage(driver, "default") }
}

describe("files-sdk blob.list({ limit: 0 })", () => {
  it.each(["slash", false] as const)("returns an empty page that keeps its place, as the fs driver does, with delimiter %j", async (delimiter) => {
    const { calls, storage } = filesSdkStorage(["a.txt", "b.txt"], delimiter)

    const [error, page] = await storage.list({ limit: 0 })
    expect(error).toBeUndefined()
    expect(page).toMatchObject({ blobs: [], hasMore: true })
    expect(page?.cursor).toBeTruthy()
    expect(calls.every(call => call.limit >= 1)).toBe(true)

    const [firstError, first] = await storage.list({ cursor: page?.cursor, limit: 1 })
    expect(firstError).toBeUndefined()
    expect(first?.blobs.map(blob => blob.pathname)).toEqual(["a.txt"])
    const [probeError, probe] = await storage.list({ cursor: first?.cursor, limit: 0 })
    expect(probeError).toBeUndefined()
    expect(probe).toMatchObject({ blobs: [], cursor: first?.cursor, hasMore: true })
    const [nextError, next] = await storage.list({ cursor: probe?.cursor, limit: 1 })
    expect(nextError).toBeUndefined()
    expect(next).toMatchObject({ blobs: [{ pathname: "b.txt" }], hasMore: false })
  })

  it.each(["slash", false] as const)("ends a zero-limit listing of an empty store with delimiter %j", async (delimiter) => {
    const { storage } = filesSdkStorage([], delimiter)
    const [error, page] = await storage.list({ limit: 0 })
    expect(error).toBeUndefined()
    expect(page).toEqual({ blobs: [], hasMore: false })
  })

  it.each(["slash", false] as const)("reports folders and holds the next blob of a folded listing with delimiter %j", async (delimiter) => {
    const { storage } = filesSdkStorage(["docs/a.txt", "x.txt"], delimiter)

    const [error, page] = await storage.list({ folded: true, limit: 0 })
    expect(error).toBeUndefined()
    expect(page).toMatchObject({ blobs: [], folders: ["docs/"], hasMore: true })

    const [nextError, next] = await storage.list({ cursor: page?.cursor, folded: true, limit: 1 })
    expect(nextError).toBeUndefined()
    expect(next?.blobs.map(blob => blob.pathname)).toEqual(["x.txt"])
  })

  it.each(["slash", false] as const)("ends a folded zero-limit listing that holds only folders with delimiter %j", async (delimiter) => {
    const { storage } = filesSdkStorage(["docs/reports/b.txt"], delimiter)
    const [error, page] = await storage.list({ folded: true, limit: 0, prefix: "docs/" })
    expect(error).toBeUndefined()
    expect(page).toEqual({ blobs: [], folders: ["docs/reports/"], hasMore: false })
  })
})
