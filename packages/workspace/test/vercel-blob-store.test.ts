import { afterEach, describe, expect, it, vi } from "vitest"

declare global {
  var __vitehubWorkspaceImportVercelBlobPeer: (() => Promise<unknown>) | undefined
}

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
        ? { blob: { contentType: "application/octet-stream", size: current.body.byteLength }, statusCode: 200, stream: new Response(current.body).body }
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

const vercelBlobModule = {
  del: blobMock.del,
  get: blobMock.get,
  head: blobMock.head,
  list: blobMock.list,
  put: blobMock.put,
}

globalThis.__vitehubWorkspaceImportVercelBlobPeer = async () => vercelBlobModule

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
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({
      prefix: "workspace/e2e",
      provider: "vercel-blob",
      token: "********",
    }, "docs")

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    expect(blobMock.put).toHaveBeenCalledWith("workspace/e2e/docs/files/docs/readme.md", expect.any(Blob), expect.objectContaining({
      access: "private",
      allowOverwrite: true,
      token: "token",
    }))
    expect(await store.readFile("docs/readme.md")).toMatchObject({ path: "docs/readme.md" })
    expect(blobMock.get).toHaveBeenCalledWith("workspace/e2e/docs/files/docs/readme.md", expect.objectContaining({
      access: "private",
      token: "token",
    }))
    blobMock.get.mockClear()
    expect(await store.glob("**/*.{md,mdx}")).toEqual([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
    ])
    expect(blobMock.get).not.toHaveBeenCalled()

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

  it("rejects traversal and reserved public paths", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({
      prefix: "workspace/e2e",
      provider: "vercel-blob",
      token: "********",
    }, "docs")

    await expect(store.writeFile("../x", { path: "../x", content: "x" })).rejects.toThrow("Workspace path escapes")
    await expect(store.readFile(".vitehub/snapshots/x.json")).rejects.toThrow("Workspace path escapes")
    await expect(store.stat(".git/config")).rejects.toThrow("Workspace path escapes")
  })

  it("synthesizes immediate directories below a listing prefix", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({
      prefix: "workspace/e2e",
      provider: "vercel-blob",
      token: "********",
    }, "docs")

    await store.writeFile("docs/guides/a.md", { path: "docs/guides/a.md", content: "guide" })

    await expect(store.list("docs")).resolves.toEqual([
      expect.objectContaining({ path: "docs/guides", type: "directory" }),
    ])
    await expect(store.list("docs/guides")).resolves.toEqual([
      expect.objectContaining({ path: "docs/guides/a.md", type: "file" }),
    ])
    await expect(store.list("docs", { exclude: ["docs/guides"] })).resolves.toEqual([])
  })
})
