import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  client: { makeRequest: vi.fn() },
  delete: vi.fn(),
  getMetadata: vi.fn(),
  getWithMetadata: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
  name: "vitehub-blob",
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

function mockListPages(pages: Record<string, { blobs: Array<{ etag: string, key: string }>, directories: string[], next_cursor?: string }>) {
  store.client.makeRequest.mockImplementation(({ parameters }: { parameters: { cursor?: string } }) => {
    const page = pages[parameters.cursor ?? "first"]
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }))
  })
}

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
    mockListPages({
      first: { blobs: [{ etag: "skip", key: "skip.txt" }], directories: ["skipped/"], next_cursor: "page-2" },
      "page-2": { blobs: [], directories: ["folder-only/"], next_cursor: "page-3" },
      "page-3": { blobs: [{ etag: "keep", key: "keep.txt" }], directories: ["selected/"] },
    })
    store.getMetadata.mockResolvedValue({ metadata: {} })

    const driver = createDriver(options)
    const first = await driver.list({ folded: true, limit: 1 })
    const second = await driver.list({ cursor: first.cursor, folded: true, limit: 1 })

    expect(first.blobs.map(blob => blob.pathname)).toEqual(["skip.txt"])
    expect(first.folders).toEqual(["skipped/", "folder-only/"])
    expect(second.blobs.map(blob => blob.pathname)).toEqual(["keep.txt"])
    expect(second.folders).toEqual(["selected/"])
    expect(store.client.makeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({ cursor: "page-3" }),
    }))
  })

  it("does not repeat folded directories across repeated page resumes", async () => {
    mockListPages({
      first: {
        blobs: [
          { etag: "one", key: "one.txt" },
          { etag: "two", key: "two.txt" },
          { etag: "three", key: "three.txt" },
        ],
        directories: ["nested/"],
      },
    })
    store.getMetadata.mockResolvedValue({ metadata: {} })

    const driver = createDriver(options)
    const first = await driver.list({ folded: true, limit: 1 })
    const second = await driver.list({ cursor: first.cursor, folded: true, limit: 1 })
    const third = await driver.list({ cursor: second.cursor, folded: true, limit: 1 })

    expect(first.folders).toEqual(["nested/"])
    expect(second.folders).toEqual([])
    expect(third.folders).toEqual([])
    expect(third.blobs.map(blob => blob.pathname)).toEqual(["three.txt"])
  })

  it("bounds concurrent metadata lookups and preserves listing order", async () => {
    const blobs = Array.from({ length: 40 }, (_, index) => ({ etag: `etag-${index}`, key: `${index}.txt` }))
    mockListPages({ first: { blobs, directories: [] } })
    let active = 0
    let maximumActive = 0
    store.getMetadata.mockImplementation(async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active--
      return { metadata: {} }
    })

    const result = await createDriver(options).list()

    expect(maximumActive).toBe(16)
    expect(result.blobs.map(blob => blob.pathname)).toEqual(blobs.map(blob => blob.key))
  })
})
