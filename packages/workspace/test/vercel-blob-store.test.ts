import { afterEach, describe, expect, it, vi } from "vitest"

const blobMock = vi.hoisted(() => {
  const store = new Map<string, { body: Uint8Array, uploadedAt: Date }>()
  const pathnameFromUrl = (input: string) => input.startsWith("https://blob.example/")
    ? input.slice("https://blob.example/".length)
    : input

  return {
    clear() {
      store.clear()
    },
    del: vi.fn(async (input: string | string[]) => {
      for (const item of Array.isArray(input) ? input : [input]) store.delete(pathnameFromUrl(item))
    }),
    get: vi.fn(async (input: string) => {
      const current = store.get(pathnameFromUrl(input))
      return current
        ? { statusCode: 200, stream: new Response(current.body).body }
        : { statusCode: 404, stream: null }
    }),
    head: vi.fn(async (pathname: string) => {
      const current = store.get(pathname)
      return current
        ? { pathname, size: current.body.byteLength, uploadedAt: current.uploadedAt, url: `https://blob.example/${pathname}` }
        : null
    }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string }) => ({
      blobs: [...store.entries()]
        .filter(([pathname]) => pathname.startsWith(prefix))
        .map(([pathname, value]) => ({
          pathname,
          size: value.body.byteLength,
          uploadedAt: value.uploadedAt,
          url: `https://blob.example/${pathname}`,
        })),
      hasMore: false,
    })),
    put: vi.fn(async (pathname: string, body: Blob | Uint8Array | string) => {
      const bytes = typeof body === "string"
        ? new TextEncoder().encode(body)
        : body instanceof Blob
          ? new Uint8Array(await body.arrayBuffer())
          : body
      store.set(pathname, { body: bytes, uploadedAt: new Date("2026-01-01T00:00:00.000Z") })
      return { pathname, size: bytes.byteLength, url: `https://blob.example/${pathname}` }
    }),
  }
})

vi.mock("@vercel/blob", () => ({
  del: blobMock.del,
  get: blobMock.get,
  head: blobMock.head,
  list: blobMock.list,
  put: blobMock.put,
}))

afterEach(() => {
  blobMock.clear()
  blobMock.del.mockClear()
  blobMock.get.mockClear()
  blobMock.head.mockClear()
  blobMock.list.mockClear()
  blobMock.put.mockClear()
  delete process.env.BLOB_READ_WRITE_TOKEN
})

describe("Vercel Blob workspace store", () => {
  it("stores files, metadata, snapshots, and diffs in Blob", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/stores/vercel-blob.ts")
    const store = createVercelBlobWorkspaceStore({
      prefix: "workspace/e2e",
      provider: "vercel-blob",
      token: "********",
    }, "docs")

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    expect(await store.readFile("docs/readme.md")).toMatchObject({ path: "docs/readme.md" })
    expect(await store.glob("**/*.md")).toEqual([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
    ])

    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "changed" })
    await store.setMeta!("loader", { digest: "abc" })

    const diff = await store.diff({ from: snapshot })
    expect(diff.entries).toEqual([
      expect.objectContaining({ path: "docs/readme.md", type: "modified" }),
    ])
    expect(await store.getMeta!("loader")).toEqual({ digest: "abc" })

    await store.rm("docs/readme.md")
    expect(await store.stat("docs/readme.md")).toBeUndefined()
  })
})
