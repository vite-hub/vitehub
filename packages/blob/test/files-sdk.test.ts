import { afterEach, describe, expect, it, vi } from "vitest"

import { createFilesSdkDriver } from "../src/drivers/files-sdk.ts"

afterEach(() => vi.unstubAllGlobals())

describe("files-sdk driver", () => {
  it("encodes folded cursors without Node globals", async () => {
    class FakeFiles {
      capabilities = { delimiter: false }

      async list() {
        return {
          cursor: "next",
          items: [
            { etag: "a", key: "a.txt", lastModified: new Date(), metadata: {}, size: 1, type: "text/plain" },
            { etag: "b", key: "folder/b.txt", lastModified: new Date(), metadata: {}, size: 1, type: "text/plain" },
          ],
        }
      }
    }

    const driver = createFilesSdkDriver(
      { bucket: "bucket", driver: "s3" },
      async () => ({} as never),
      FakeFiles as never,
    )
    vi.stubGlobal("Buffer", undefined)

    await expect(driver.list({ folded: true, limit: 1 })).resolves.toMatchObject({
      blobs: [{ pathname: "a.txt" }],
      hasMore: true,
    })
  })

  it("creates the client again on the next call after a failed creation", async () => {
    class FakeFiles {
      async head(pathname: string) {
        return { etag: "a", key: pathname, lastModified: new Date(), metadata: {}, size: 1, type: "text/plain" }
      }
    }
    const createAdapter = vi.fn()
      .mockRejectedValueOnce(new Error("transient adapter failure"))
      .mockResolvedValue({})
    const driver = createFilesSdkDriver({ bucket: "bucket", driver: "s3" }, createAdapter, FakeFiles as never)

    await expect(driver.head("a.txt")).rejects.toThrow("transient adapter failure")
    await expect(driver.head("a.txt")).resolves.toMatchObject({ pathname: "a.txt" })
    expect(createAdapter).toHaveBeenCalledTimes(2)
  })
})
