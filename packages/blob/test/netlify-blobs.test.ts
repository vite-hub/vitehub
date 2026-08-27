import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  delete: vi.fn(),
  getMetadata: vi.fn(),
  getWithMetadata: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
}))

vi.mock("@vite-hub/internal/arrays", () => ({
  toArray: (value: unknown) => Array.isArray(value) ? value : [value],
}))
vi.mock("@vite-hub/netlify-blobs-runtime", () => ({
  getDeployStore: () => store,
  getStore: () => store,
}))

import { createDriver } from "../src/drivers/netlify-blobs.ts"

const options = { driver: "netlify-blobs", name: "vitehub-blob" } as const

beforeEach(() => vi.clearAllMocks())

describe("Netlify Blobs driver", () => {
  it("buffers streams and records their actual byte length", async () => {
    store.set.mockResolvedValue({ etag: "etag" })
    const body = new Blob(["streamed"]).stream()

    const result = await createDriver(options).put("stream.txt", body)

    const [, normalizedBody, setOptions] = store.set.mock.calls[0]!
    expect(normalizedBody).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(normalizedBody as ArrayBuffer)).toBe("streamed")
    expect(setOptions.metadata.__size).toBe(8)
    expect(result.size).toBe(8)
  })

  it("advances folder-only pages across folded cursors", async () => {
    store.list.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { blobs: [{ etag: "skip", key: "skip.txt" }], directories: ["skipped/"] }
        yield { blobs: [], directories: ["folder-only/"] }
        yield { blobs: [{ etag: "keep", key: "keep.txt" }], directories: ["selected/"] }
      },
    })
    store.getMetadata.mockResolvedValue({ metadata: {} })

    const driver = createDriver(options)
    const first = await driver.list({ folded: true, limit: 1 })
    const second = await driver.list({ cursor: first.cursor, folded: true, limit: 1 })

    expect(first.blobs.map(blob => blob.pathname)).toEqual(["skip.txt"])
    expect(first.folders).toEqual(["skipped/", "folder-only/"])
    expect(second.blobs.map(blob => blob.pathname)).toEqual(["keep.txt"])
    expect(second.folders).toEqual(["selected/"])
  })
})
