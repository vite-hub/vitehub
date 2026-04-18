import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BlobDriver, BlobPutBody } from "../src/runtime/drivers/types.ts"
import type { BlobListOptions, BlobListResult, BlobObject, BlobPutOptions } from "../src/runtime/types.ts"

const h3Mocks = vi.hoisted(() => ({
  assertMethod: vi.fn(),
  readFormData: vi.fn(),
  setHeader: vi.fn(),
}))

vi.mock("h3", async () => {
  const actual = await vi.importActual<typeof import("h3")>("h3")
  return {
    ...actual,
    assertMethod: h3Mocks.assertMethod,
    readFormData: h3Mocks.readFormData,
    setHeader: h3Mocks.setHeader,
  }
})

import { createBlobStorage } from "../src/runtime/storage.ts"

function createMemoryDriver(): BlobDriver<{ name: "memory" }> {
  const store = new Map<string, { body: Blob, metadata: BlobObject }>()

  return {
    name: "memory",
    options: { name: "memory" },
    async list(options?: BlobListOptions): Promise<BlobListResult> {
      const prefix = options?.prefix || ""
      return {
        blobs: [...store.values()].map(item => item.metadata).filter(item => item.pathname.startsWith(prefix)),
        hasMore: false,
      }
    },
    async get(pathname: string): Promise<Blob | null> {
      return store.get(pathname)?.body ?? null
    },
    async getArrayBuffer(pathname: string): Promise<ArrayBuffer | null> {
      const body = store.get(pathname)?.body
      return body ? await body.arrayBuffer() : null
    },
    async put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobObject> {
      const blob = body instanceof Blob ? body : new Blob([body as string], { type: options?.contentType })
      const metadata: BlobObject = {
        contentType: options?.contentType,
        customMetadata: options?.customMetadata || {},
        httpEtag: `"${pathname}"`,
        httpMetadata: { contentType: options?.contentType || "" },
        pathname,
        size: blob.size,
        uploadedAt: new Date("2026-04-18T00:00:00.000Z"),
      }
      store.set(pathname, { body: blob, metadata })
      return metadata
    },
    async head(pathname: string): Promise<BlobObject | null> {
      return store.get(pathname)?.metadata ?? null
    },
    async delete(pathnames: string | string[]): Promise<void> {
      for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) store.delete(pathname)
    },
  }
}

describe("ensureBlob", () => {
  it("validates size and content type", async () => {
    const { ensureBlob } = await import("../src/runtime/ensure.ts")
    const file = new Blob(["hello"], { type: "text/plain" })

    expect(() => ensureBlob(file, { maxSize: "1KB", types: ["text"] })).not.toThrow()
    expect(() => ensureBlob(file, { maxSize: "1B" })).toThrow("File size must be less than 1B")
    expect(() => ensureBlob(file, { types: ["image"] })).toThrow("File type is invalid")
    expect(() => ensureBlob(file)).toThrow("ensureBlob() requires")
  })
})

describe("createBlobStorage", () => {
  beforeEach(() => {
    h3Mocks.readFormData.mockReset()
    h3Mocks.assertMethod.mockReset()
    h3Mocks.setHeader.mockReset()
  })

  it("writes, reads, lists, heads, serves, and deletes blobs", async () => {
    const storage = createBlobStorage(createMemoryDriver())

    await storage.put("notes/hello.txt", "hello world", {
      customMetadata: { source: "test" },
    })

    await expect(storage.get("notes/hello.txt").then(file => file?.text())).resolves.toBe("hello world")
    await expect(storage.head("notes/hello.txt")).resolves.toMatchObject({
      customMetadata: { source: "test" },
      pathname: "notes/hello.txt",
    })
    await expect(storage.list({ prefix: "notes/" })).resolves.toMatchObject({
      blobs: [
        expect.objectContaining({ pathname: "notes/hello.txt" }),
      ],
      hasMore: false,
    })

    const stream = await storage.serve({} as never, "notes/hello.txt")

    expect(await new Response(stream).text()).toBe("hello world")
    expect(h3Mocks.setHeader).toHaveBeenCalledWith({}, "Content-Type", "text/plain")
    expect(h3Mocks.setHeader).toHaveBeenCalledWith({}, "Content-Length", "11")
    expect(h3Mocks.setHeader).toHaveBeenCalledWith({}, "etag", "\"notes/hello.txt\"")

    await storage.del("notes/hello.txt")
    await expect(storage.get("notes/hello.txt")).resolves.toBeNull()
  })

  it("applies prefix, custom content type, and random suffix during put", async () => {
    const storage = createBlobStorage(createMemoryDriver())

    const uploaded = await storage.put("avatar.txt", "hello", {
      addRandomSuffix: true,
      contentType: "text/custom",
      prefix: "users/1",
    })

    expect(uploaded.pathname).toMatch(/^users\/1\/avatar-[a-f0-9]+\.txt$/)
    expect(uploaded.contentType).toBe("text/custom")
  })

  it("uploads form files through handleUpload", async () => {
    const storage = createBlobStorage(createMemoryDriver())
    const form = new FormData()
    form.append("files", new File(["hello"], "hello.txt", { type: "text/plain" }))
    h3Mocks.readFormData.mockResolvedValue(form)

    const uploaded = await storage.handleUpload({} as never, {
      ensure: {
        maxSize: "1KB",
        types: ["text/plain"],
      },
      put: {
        prefix: "uploads",
      },
    })

    expect(h3Mocks.assertMethod).toHaveBeenCalled()
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatchObject({
      pathname: "uploads/hello.txt",
    })
  })

  it("rejects multiple uploads when disabled", async () => {
    const storage = createBlobStorage(createMemoryDriver())
    const form = new FormData()
    form.append("files", new File(["one"], "one.txt", { type: "text/plain" }))
    form.append("files", new File(["two"], "two.txt", { type: "text/plain" }))
    h3Mocks.readFormData.mockResolvedValue(form)

    await expect(storage.handleUpload({} as never, { multiple: false })).rejects.toMatchObject({
      statusCode: 400,
      message: "Multiple files are not allowed",
    })
  })
})

describe("runtime public blob", () => {
  beforeEach(async () => {
    vi.resetModules()
    const { resetBlobRuntimeState } = await import("../src/runtime/state.ts")
    resetBlobRuntimeState()
    Reflect.deleteProperty(globalThis as typeof globalThis & { __vitehubBlobConfig?: unknown }, "__vitehubBlobConfig")
    Reflect.deleteProperty(globalThis as typeof globalThis & { __env__?: unknown }, "__env__")
  })

  it("resolves Cloudflare R2 through global runtime bindings", async () => {
    const bucket = {
      objects: new Map<string, { body: Blob, metadata: BlobObject }>(),
      async list() {
        return { objects: [...this.objects.values()].map(item => ({
          arrayBuffer: () => item.body.arrayBuffer(),
          customMetadata: item.metadata.customMetadata,
          httpEtag: item.metadata.httpEtag,
          httpMetadata: item.metadata.httpMetadata,
          key: item.metadata.pathname,
          size: item.metadata.size,
          uploaded: item.metadata.uploadedAt,
        })), truncated: false }
      },
      async get(pathname: string) {
        const item = this.objects.get(pathname)
        if (!item) return null
        return {
          arrayBuffer: () => item.body.arrayBuffer(),
          customMetadata: item.metadata.customMetadata,
          httpEtag: item.metadata.httpEtag,
          httpMetadata: item.metadata.httpMetadata,
          key: pathname,
          size: item.metadata.size,
          uploaded: item.metadata.uploadedAt,
        }
      },
      async put(pathname: string, body: string, options: { customMetadata?: Record<string, string>, httpMetadata?: Record<string, string> }) {
        const blob = new Blob([body], { type: options.httpMetadata?.contentType })
        const object = {
          arrayBuffer: () => blob.arrayBuffer(),
          customMetadata: options.customMetadata,
          httpEtag: `"${pathname}"`,
          httpMetadata: options.httpMetadata,
          key: pathname,
          size: blob.size,
          uploaded: new Date("2026-04-18T00:00:00.000Z"),
        }
        this.objects.set(pathname, {
          body: blob,
          metadata: {
            contentType: options.httpMetadata?.contentType,
            customMetadata: options.customMetadata || {},
            httpEtag: `"${pathname}"`,
            httpMetadata: options.httpMetadata || {},
            pathname,
            size: blob.size,
            uploadedAt: object.uploaded,
          },
        })
        return object
      },
      async head(pathname: string) {
        return this.get(pathname)
      },
      async delete(pathname: string) {
        this.objects.delete(pathname)
      },
    }
    ;(globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ = { BLOB: bucket }
    ;(globalThis as typeof globalThis & { __vitehubBlobConfig?: unknown }).__vitehubBlobConfig = {
      provider: {
        binding: "BLOB",
        driver: "cloudflare-r2",
      },
    }

    const { blob } = await import("../src/runtime/public.ts")

    await blob.put("hello.txt", "hello", { contentType: "text/plain" })
    await expect(blob.get("hello.txt").then(file => file?.text())).resolves.toBe("hello")
    await expect(blob.list()).resolves.toMatchObject({
      blobs: [expect.objectContaining({ pathname: "hello.txt" })],
      hasMore: false,
    })
  })
})
