import { afterEach, describe, expect, it, vi } from "vitest"
import { BlobNotFoundError, BlobServiceNotAvailable } from "@vercel/blob"
import { checkGlobCwd, seedGlobCwdStore } from "./glob-cwd-checks.ts"

declare global {
  var __vitehubWorkspaceImportVercelBlobPeer: (() => Promise<unknown>) | undefined
}

const blobMock = vi.hoisted(() => {
  const store = new Map<string, { body: Uint8Array, uploadedAt: Date }>()
  const cache = new Map<string, { body: Uint8Array, uploadedAt: Date }>()
  const pathnameFromUrl = (input: string) => (input.startsWith("https://blob.example/")
    ? input.slice("https://blob.example/".length)
    : input).split("?")[0]

  return {
    clear() {
      store.clear()
      cache.clear()
    },
    del: vi.fn(async (input: string | string[]) => {
      for (const item of Array.isArray(input) ? input : [input]) store.delete(pathnameFromUrl(item))
    }),
    get: vi.fn(async (input: string, options: { access?: "private" | "public", useCache?: boolean } = {}) => {
      const pathname = pathnameFromUrl(input)
      const hasPublicCacheBust = input.includes("?vitehubCacheBust=")
      const bypassCache = options.useCache === false && (options.access !== "public" || hasPublicCacheBust)
      const current = bypassCache ? store.get(pathname) : cache.get(pathname) || store.get(pathname)
      if (current && !bypassCache) cache.set(pathname, current)
      return current
        ? { blob: { contentType: "application/octet-stream", size: current.body.byteLength }, statusCode: 200, stream: new Response(current.body).body }
        : null
    }),
    head: vi.fn(async (pathname: string) => {
      const current = store.get(pathname)
      if (!current) throw new BlobNotFoundError()
      return { pathname, size: current.body.byteLength, uploadedAt: current.uploadedAt, url: `https://blob.example/${pathname}` }
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
      cursor: undefined as string | undefined,
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
  it("rejects repeated pagination cursors before looping", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    blobMock.list
      .mockImplementationOnce(async () => ({ blobs: [], cursor: "same", hasMore: true }))
      .mockImplementationOnce(async () => ({ blobs: [], cursor: "same", hasMore: true }))
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "token" }, "docs")
    await expect(store.list()).rejects.toThrow("pagination returned a repeated cursor")
    expect(blobMock.list).toHaveBeenCalledTimes(2)
  })
  it("stops when the provider marks a cursor as terminal", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    blobMock.list.mockResolvedValueOnce({ blobs: [], cursor: "terminal", hasMore: false })
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "token" }, "docs")
    await expect(store.list()).resolves.toEqual([])
    expect(blobMock.list).toHaveBeenCalledTimes(1)
  })
  it("detects equal-size content changes in snapshot diffs", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "token" }, "docs")
    await store.writeFile("readme.md", { path: "readme.md", content: "before" })
    const snapshot = await store.snapshot()

    await expect(store.diff({ from: snapshot })).resolves.toMatchObject({ entries: [] })
    await store.writeFile("readme.md", { path: "readme.md", content: "after!" })

    await expect(store.diff({ from: snapshot })).resolves.toMatchObject({
      entries: [{ path: "readme.md", type: "modified" }],
    })
  })

  it("requests uncached reads for public blobs", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ access: "public", provider: "vercel-blob", token: "token" }, "docs")

    await store.writeFile("readme.md", { path: "readme.md", content: "before" })
    await store.readFile("readme.md")

    expect(blobMock.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      access: "public",
      headers: { "cache-control": "no-cache, no-store" },
      useCache: false,
    }))
    expect(blobMock.get.mock.calls[0]?.[0]).toMatch(/\?vitehubCacheBust=/)
  })

  it("detects equal-size rewrites for public blobs despite CDN caching", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ access: "public", provider: "vercel-blob", token: "token" }, "docs")

    await store.writeFile("readme.md", { path: "readme.md", content: "before" })
    const snapshot = await store.snapshot()
    await store.writeFile("readme.md", { path: "readme.md", content: "after!" })

    await expect(store.diff({ from: snapshot })).resolves.toMatchObject({
      entries: [{ path: "readme.md", type: "modified" }],
    })
  })

  it("preserves unchanged legacy snapshots without file digests", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "token" }, "docs")
    await store.writeFile("readme.md", { path: "readme.md", content: "before" })
    const current = await store.snapshot()
    const legacy = {
      ...current,
      entries: Object.fromEntries(Object.entries(current.entries).map(([path, entry]) => [path, { ...entry, digest: undefined }])),
    }

    await expect(store.diff({ from: legacy })).resolves.toMatchObject({ entries: [] })
  })

  it("does not persist a partial snapshot when digest hydration fails", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "token" }, "docs")
    await store.writeFile("readme.md", { path: "readme.md", content: "before" })
    blobMock.get.mockRejectedValueOnce(new Error("temporary failure"))

    await expect(store.snapshot()).rejects.toThrow("temporary failure")
    await expect(store.snapshot()).resolves.toMatchObject({
      entries: { "readme.md": { digest: expect.any(String) } },
    })
  })
  it("preserves provider failures while reading files and metadata", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "********" }, "docs")
    const failure = new BlobServiceNotAvailable()
    for (const read of [() => store.readFile("readme.md"), () => store.stat("readme.md"), () => store.getMeta!("loader")]) {
      blobMock.get.mockRejectedValueOnce(failure)
      await expect(read()).rejects.toBe(failure)
    }
    expect(blobMock.list).not.toHaveBeenCalled()
  })

  it("does not treat failed removal probes as missing paths", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "********" }, "docs")
    const failure = new BlobServiceNotAvailable()
    blobMock.head.mockRejectedValueOnce(failure)
    await expect(store.rm("docs", { recursive: true, force: true })).rejects.toBe(failure)
    expect(blobMock.list).not.toHaveBeenCalled()
    expect(blobMock.del).not.toHaveBeenCalled()
  })

  it("returns missing results only for absent blobs", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "********" }, "docs")
    await expect(store.readFile("missing.md")).resolves.toBeUndefined()
    await expect(store.getMeta!("missing")).resolves.toBeUndefined()
    await expect(store.stat("missing.md")).resolves.toBeUndefined()
    await expect(store.rm("missing.md", { force: true })).resolves.toBeUndefined()
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.rm("docs", { recursive: true })
    await expect(store.readFile("docs/readme.md")).resolves.toBeUndefined()
  })

  it("recognizes not-found errors from a separately loaded Blob SDK", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "********" }, "docs")
    const peerNotFound = new Error("missing")
    peerNotFound.name = "BlobNotFoundError"
    blobMock.head.mockRejectedValueOnce(peerNotFound)
    await expect(store.rm("missing.md", { force: true })).resolves.toBeUndefined()
  })

  it("matches glob patterns relative to cwd", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "token"
    const { createVercelBlobWorkspaceStore } = await import("../src/providers/vercel/blob-store.ts")
    const store = createVercelBlobWorkspaceStore({ provider: "vercel-blob", token: "********" }, "docs")
    await seedGlobCwdStore(store)
    await checkGlobCwd(store)
  })

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
      useCache: false,
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
