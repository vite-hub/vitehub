import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDriver as createFsDriver } from "../src/drivers/fs.ts"
import { createBlobStorage } from "../src/storage.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function fsStorage() {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-list-limit-"))
  tempDirs.push(base)
  const storage = createBlobStorage(createFsDriver({ base, driver: "fs" }), "default")
  for (const pathname of ["a.txt", "b.txt", "c.txt"]) await storage.put(pathname, "x")
  return storage
}

describe("blob.list({ limit })", () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])("rejects limit %s with a 400 before it lists", async (limit) => {
    const storage = await fsStorage()
    await expect(storage.list({ limit })).rejects.toMatchObject({
      code: "BLOB_R0034",
      fix: expect.stringContaining("safe integer of 0 or more, or omit `limit`"),
      message: `Blob list() limit must be a safe integer of 0 or more, or omitted. Got ${String(limit)}.`,
      status: 400,
    })
  })

  it("pages through every blob with a safe-integer limit", async () => {
    const storage = await fsStorage()
    const pathnames: string[] = []
    let cursor: string | undefined
    do {
      const [error, page] = await storage.list({ cursor, limit: 2 })
      expect(error).toBeUndefined()
      expect(page!.blobs.length).toBeLessThanOrEqual(2)
      pathnames.push(...page!.blobs.map(object => object.pathname))
      cursor = page!.cursor
    } while (cursor)
    expect(pathnames).toEqual(["a.txt", "b.txt", "c.txt"])
  })

  it("keeps limit 0 as an empty page", async () => {
    const storage = await fsStorage()
    const [error, page] = await storage.list({ limit: 0 })
    expect(error).toBeUndefined()
    expect(page).toMatchObject({ blobs: [], hasMore: true })
  })
})
