import { afterEach, describe, expect, it, vi } from "vitest"

import { ensureBlob } from "../src/ensure.ts"
import { blob } from "../src/runtime/storage.ts"
import { createBlobCloudflareWorker } from "../src/runtime/cloudflare-vite.ts"
import { createBlobStorage } from "../src/storage.ts"
import {
  setActiveCloudflareEnv,
  setBlobRuntimeConfig,
  setBlobRuntimeStorage,
} from "../src/runtime/state.ts"
import type { BlobResult } from "../src/types.ts"

function expectBlobSuccess<TResult>(result: BlobResult<TResult>): TResult {
  const [error, value] = result
  expect(error).toBeNull()
  return value as TResult
}

const vercelBlobMock = vi.hoisted(() => ({
  del: vi.fn(async () => {}),
  get: vi.fn(async (pathname: string) => ({
    blob: {
      cacheControl: "public, max-age=0, must-revalidate",
      contentDisposition: "inline",
      contentType: "text/plain",
      etag: "\"etag\"",
      pathname,
      size: 5,
      uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
      url: `https://blob.example/${pathname}`,
    },
    headers: new Headers(),
    statusCode: 200,
    stream: new Response("value").body,
  })),
  head: vi.fn(async (pathname: string) => ({
    pathname,
    size: 5,
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    url: `https://blob.example/${pathname}`,
  })),
  list: vi.fn(async () => ({
    blobs: [],
    hasMore: false,
  })),
  put: vi.fn(async (pathname: string) => ({
    contentType: "text/plain",
    key: pathname,
    pathname,
    size: 5,
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    url: `https://blob.example/${pathname}`,
  })),
}))

const filesSdkMock = vi.hoisted(() => ({
  list: vi.fn(async (_options?: unknown) => ({
    items: [
      {
        etag: "\"etag\"",
        key: "notes/hello.txt",
        lastModified: "2026-01-01T00:00:00.000Z",
        metadata: {},
        size: 5,
        type: "text/plain",
      },
    ],
  })),
  minio: vi.fn(() => ({ provider: "minio" })),
  r2: vi.fn((options: unknown) => ({ options, provider: "r2" })),
  s3: vi.fn(() => ({ provider: "s3" })),
  vercelBlob: vi.fn((options: unknown) => ({ options, provider: "vercel-blob" })),
}))

vi.mock("@vercel/blob", () => vercelBlobMock)

vi.mock("files-sdk", () => ({
  Files: class {
    adapter: { options?: { access?: "private" | "public", token?: string }, provider?: string }

    constructor(options: { adapter?: { options?: { access?: "private" | "public", token?: string }, provider?: string } } = {}) {
      this.adapter = options.adapter || {}
    }

    async delete(pathname: string) {
      if (this.adapter.provider === "vercel-blob") {
        await (vercelBlobMock.del as any)(pathname, { token: this.adapter.options?.token })
      }
    }

    async download(pathname: string) {
      const result = await (vercelBlobMock.get as any)(pathname, {
        access: this.adapter.options?.access,
        token: this.adapter.options?.token,
      })
      return new Response(result.stream, {
        headers: { "content-type": result.blob?.contentType || "text/plain" },
      })
    }

    async head(pathname: string) {
      const result = await (vercelBlobMock.head as any)(pathname, { token: this.adapter.options?.token })
      return {
        etag: "\"etag\"",
        key: result.pathname,
        lastModified: result.uploadedAt,
        size: result.size,
        type: "text/plain",
      }
    }

    async list(options?: unknown) {
      if (this.adapter.provider === "vercel-blob") {
        const result = await (vercelBlobMock.list as any)(options)
        return {
          cursor: result.cursor,
          items: result.blobs.map((blob: any) => ({
            etag: blob.etag,
            key: blob.pathname,
            lastModified: blob.uploadedAt,
            size: blob.size,
            type: blob.contentType,
          })),
        }
      }
      return await filesSdkMock.list(options)
    }

    async upload(pathname: string, body: Blob | Uint8Array | string, options: { contentType?: string } = {}) {
      const result = await (vercelBlobMock.put as any)(pathname, body, {
        access: this.adapter.options?.access,
        contentType: options.contentType,
        token: this.adapter.options?.token,
      })
      return {
        contentType: result.contentType,
        key: result.pathname,
        lastModified: result.uploadedAt,
        size: result.size,
      }
    }

    async url(pathname: string) {
      if (this.adapter.provider !== "vercel-blob") {
        throw new Error("URL not available")
      }
      return `https://blob.example/${pathname}`
    }
  },
}))

vi.mock("files-sdk/s3", () => ({
  s3: filesSdkMock.s3,
}))

vi.mock("files-sdk/minio", () => ({
  minio: filesSdkMock.minio,
}))

vi.mock("files-sdk/r2", () => ({
  r2: filesSdkMock.r2,
}))

vi.mock("files-sdk/vercel-blob", () => ({
  vercelBlob: filesSdkMock.vercelBlob,
}))

afterEach(() => {
  setActiveCloudflareEnv(undefined)
  setBlobRuntimeConfig(undefined)
  setBlobRuntimeStorage(undefined)
  vercelBlobMock.del.mockClear()
  vercelBlobMock.get.mockClear()
  vercelBlobMock.head.mockClear()
  vercelBlobMock.list.mockClear()
  vercelBlobMock.put.mockClear()
  filesSdkMock.list.mockClear()
  filesSdkMock.minio.mockClear()
  filesSdkMock.r2.mockClear()
  filesSdkMock.s3.mockClear()
  filesSdkMock.vercelBlob.mockClear()
  delete process.env.BLOB_READ_WRITE_TOKEN
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.CLOUDFLARE_R2_ACCOUNT_ID
  delete process.env.CLOUDFLARE_R2_ACCESS_KEY_ID
  delete process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY
  delete process.env.MINIO_ACCESS_KEY_ID
  delete process.env.MINIO_ROOT_PASSWORD
  delete process.env.MINIO_ROOT_USER
  delete process.env.MINIO_SECRET_ACCESS_KEY
  delete process.env.R2_ACCOUNT_ID
  delete process.env.R2_ACCESS_KEY_ID
  delete process.env.R2_BUCKET_NAME
  delete process.env.R2_SECRET_ACCESS_KEY
  vi.restoreAllMocks()
})

function createMemoryBucket() {
  const store = new Map<string, {
    body: Uint8Array
    contentType?: string
    customMetadata?: Record<string, string>
    uploaded: Date
  }>()

  return {
    async delete(pathname: string) {
      store.delete(pathname)
    },
    async get(pathname: string) {
      const current = store.get(pathname)
      if (!current) {
        return null
      }

      return {
        arrayBuffer: async () => current.body.buffer.slice(current.body.byteOffset, current.body.byteOffset + current.body.byteLength),
        customMetadata: current.customMetadata,
        httpEtag: "\"etag\"",
        httpMetadata: { contentType: current.contentType },
        key: pathname,
        size: current.body.byteLength,
        uploaded: current.uploaded,
      }
    },
    async head(pathname: string) {
      const current = store.get(pathname)
      if (!current) {
        return null
      }

      return {
        customMetadata: current.customMetadata,
        httpEtag: "\"etag\"",
        httpMetadata: { contentType: current.contentType },
        key: pathname,
        size: current.body.byteLength,
        uploaded: current.uploaded,
      }
    },
    async list(options: { cursor?: string, delimiter?: string, include?: string[], limit?: number, prefix?: string } = {}) {
      const objects = [...store.entries()]
        .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
        .map(([key, value]) => ({
          customMetadata: value.customMetadata,
          httpEtag: "\"etag\"",
          httpMetadata: { contentType: value.contentType },
          key,
          size: value.body.byteLength,
          uploaded: value.uploaded,
        }))
      const delimitedPrefixes = options.delimiter
        ? [...new Set(objects.flatMap((object) => {
            const remainder = object.key.slice(options.prefix?.length || 0)
            const index = remainder.indexOf(options.delimiter!)
            return index >= 0 ? [`${options.prefix || ""}${remainder.slice(0, index + 1)}`] : []
          }))]
        : undefined
      return {
        delimitedPrefixes,
        objects: options.delimiter ? objects.filter((object) => !delimitedPrefixes?.some(prefix => object.key.startsWith(prefix))) : objects,
        truncated: false,
      }
    },
    async put(pathname: string, body: Blob | Uint8Array | string, options: { customMetadata?: Record<string, string>, httpMetadata?: { contentType?: string } }) {
      const arrayBuffer = await new Response(body as any).arrayBuffer()
      const value = {
        body: new Uint8Array(arrayBuffer),
        contentType: options.httpMetadata?.contentType,
        customMetadata: options.customMetadata,
        uploaded: new Date("2026-01-01T00:00:00.000Z"),
      }
      store.set(pathname, value)
      return {
        customMetadata: value.customMetadata,
        httpEtag: "\"etag\"",
        httpMetadata: { contentType: value.contentType },
        key: pathname,
        size: value.body.byteLength,
        uploaded: value.uploaded,
      }
    },
  }
}

describe("blob runtime", () => {
  it("returns provider failures as Blob results", async () => {
    const cause = new Error("provider unavailable")
    const storage = createBlobStorage({
      name: "failure",
      options: {},
      async delete() {},
      async get() { return null },
      async getArrayBuffer() { return null },
      async head() { return null },
      async list() { return { blobs: [], hasMore: false } },
      async put() { throw cause },
    }, "archive")

    const [error, value] = await storage.put("proof.txt", "value")

    expect(value).toBeUndefined()
    expect(error).toMatchObject({
      cause,
      code: "BLOB_OPERATION_FAILED",
      details: { operation: "put", store: "archive" },
      name: "ViteHubError",
    })
  })

  it("returns provider initialization failures as Blob results", async () => {
    setBlobRuntimeConfig({
      store: {
        driver: "unavailable",
      } as never,
    })

    const [error, value] = await blob.get("proof.txt")

    expect(value).toBeUndefined()
    expect(error).toMatchObject({
      code: "BLOB_OPERATION_FAILED",
      details: { operation: "get", store: "default" },
      name: "ViteHubError",
    })
  })

  it("keeps invalid Blob calls throwing", async () => {
    const get = vi.fn(async () => null)
    const storage = createBlobStorage({
      name: "validation",
      options: {},
      async delete() {},
      get,
      async getArrayBuffer() { return null },
      async head() { return null },
      async list() { return { blobs: [], hasMore: false } },
      async put() { throw new Error("not reached") },
    })

    await expect(storage.get(Symbol("invalid") as never)).rejects.toBeInstanceOf(TypeError)
    expect(get).not.toHaveBeenCalled()
  })

  it("rehydrates the masked Vercel token", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "secret-token"
    setBlobRuntimeConfig({
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "********",
      },
    })

    const result = expectBlobSuccess(await blob.put("notes/hello.txt", "hello"))

    expect(result.pathname).toBe("notes/hello.txt")
    expect(result.url).toBe("https://blob.example/notes/hello.txt")
    expect(vercelBlobMock.put).toHaveBeenCalledWith("notes/hello.txt", "hello", expect.objectContaining({
      access: "public",
      token: "secret-token",
    }))
  })

  it("preserves provider cursors for folded Vercel listings", async () => {
    setBlobRuntimeConfig({
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "default-token",
      },
    })
    ;(vercelBlobMock.list as any).mockImplementation(async (options: { cursor?: string } = {}) => {
      if (options.cursor === "page-2") {
        return {
          blobs: [
            {
              contentType: "text/plain",
              pathname: "a/z-last.txt",
              size: 4,
              uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
          folders: [],
          hasMore: false,
        }
      }
      return {
        blobs: [
          {
            contentType: "text/plain",
            pathname: "a/root.txt",
            size: 4,
            uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
        cursor: "page-2",
        folders: ["a/nested/"],
        hasMore: true,
      }
    })

    const firstPage = expectBlobSuccess(await blob.list({ folded: true, limit: 1, prefix: "a/" }))

    expect(firstPage).toMatchObject({
      blobs: [{ pathname: "a/root.txt" }],
      folders: ["a/nested/"],
      hasMore: true,
    })
    expect(firstPage.cursor).toBeDefined()

    const secondPage = expectBlobSuccess(await blob.list({ cursor: firstPage.cursor, folded: true, limit: 1, prefix: "a/" }))

    expect(vercelBlobMock.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2", mode: "folded" }))
    expect(secondPage).toMatchObject({
      blobs: [{ pathname: "a/z-last.txt" }],
      folders: [],
      hasMore: false,
    })
  })

  it("selects named stores from runtime config", async () => {
    setBlobRuntimeConfig({
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "default-token",
      },
      stores: {
        assets: {
          access: "public",
          driver: "vercel-blob",
          token: "assets-token",
        },
        default: {
          access: "public",
          driver: "vercel-blob",
          token: "default-token",
        },
      },
    })

    expectBlobSuccess(await blob.store("assets").put("notes/assets.txt", "value"))

    expect(vercelBlobMock.put).toHaveBeenCalledWith("notes/assets.txt", "value", expect.objectContaining({
      access: "public",
      token: "assets-token",
    }))
  })

  it("decorates objects from the served store with public URLs", async () => {
    setBlobRuntimeConfig({
      serve: {
        publicBaseUrl: "https://assets.example/",
        route: "/api/_vitehub/blob/",
        store: "assets",
      },
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "default-token",
      },
      stores: {
        assets: {
          access: "public",
          driver: "vercel-blob",
          token: "assets-token",
        },
        default: {
          access: "public",
          driver: "vercel-blob",
          token: "default-token",
        },
      },
    })
    ;(vercelBlobMock.list as any).mockResolvedValue({
      blobs: [{
        contentType: "text/plain",
        pathname: "notes/served.txt",
        size: 5,
        uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
      }],
      hasMore: false,
    })

    const put = expectBlobSuccess(await blob.store("assets").put("notes/served.txt", "value"))
    const head = expectBlobSuccess(await blob.store("assets").head("notes/served.txt"))
    const list = expectBlobSuccess(await blob.store("assets").list())
    const otherStore = expectBlobSuccess(await blob.put("notes/private.txt", "value"))

    expect(put.url).toBe("https://assets.example/api/_vitehub/blob/notes/served.txt")
    expect(head.url).toBe("https://assets.example/api/_vitehub/blob/notes/served.txt")
    expect(list.blobs[0]?.url).toBe("https://assets.example/api/_vitehub/blob/notes/served.txt")
    expect(otherStore.url).toBe("https://blob.example/notes/private.txt")
  })

  it.each([
    ["assets", "/assets/notes/served.txt"],
    ["/", "/notes/served.txt"],
  ])("returns route-relative URLs for the %s Blob serving route", async (route, expectedUrl) => {
    setBlobRuntimeConfig({
      serve: {
        route,
        store: "assets",
      },
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "default-token",
      },
      stores: {
        assets: {
          access: "public",
          driver: "vercel-blob",
          token: "assets-token",
        },
        default: {
          access: "public",
          driver: "vercel-blob",
          token: "default-token",
        },
      },
    })

    const put = expectBlobSuccess(await blob.store("assets").put("notes/served.txt", "value"))

    expect(put.url).toBe(expectedUrl)
  })

  it("rejects missing named stores at runtime", async () => {
    setBlobRuntimeConfig({
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "default-token",
      },
      stores: {
        default: {
          access: "public",
          driver: "vercel-blob",
          token: "default-token",
        },
      },
    })

    await expect(blob.store("missing").get("notes/missing.txt")).rejects.toThrow("Unknown Blob store \"missing\".")
  })

  it("uses the active Cloudflare binding", async () => {
    setBlobRuntimeConfig({
      store: {
        binding: "BLOB",
        bucketName: "assets",
        driver: "cloudflare-r2",
      },
    })
    setActiveCloudflareEnv({ BLOB: createMemoryBucket() })

    expectBlobSuccess(await blob.put("notes/hello.txt", "hello", {
      contentType: "text/plain",
      customMetadata: { test: "true" },
    }))

    const list = expectBlobSuccess(await blob.list())
    const head = expectBlobSuccess(await blob.head("notes/hello.txt"))
    const body = expectBlobSuccess(await blob.get("notes/hello.txt"))

    expect(list.blobs).toHaveLength(1)
    expect(head.customMetadata).toEqual({ test: "true" })
    expect(body?.type).toBe("text/plain")
    expect(await body?.text()).toBe("hello")
    expect(filesSdkMock.r2).not.toHaveBeenCalled()

    expectBlobSuccess(await blob.del("notes/hello.txt"))
    const [missingError] = await blob.head("notes/hello.txt")
    expect(missingError).toMatchObject({ code: "BLOB_NOT_FOUND", details: { operation: "head", store: "default" } })
  })

  it("falls back to Files SDK R2 when no Cloudflare binding exists", async () => {
    process.env.CLOUDFLARE_R2_ACCOUNT_ID = "account"
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "access-key"
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "secret-key"
    process.env.R2_BUCKET_NAME = "runtime-assets"
    setBlobRuntimeConfig({
      store: {
        accountId: "********",
        accessKeyId: "********",
        binding: "BLOB",
        bucketName: "********",
        defaultUrlExpiresIn: 900,
        driver: "cloudflare-r2",
        publicBaseUrl: "https://assets.example.com",
        secretAccessKey: "********",
      },
    })

    const list = expectBlobSuccess(await blob.list())

    expect(filesSdkMock.r2).toHaveBeenCalledWith({
      accountId: "account",
      accessKeyId: "access-key",
      bucket: "runtime-assets",
      defaultUrlExpiresIn: 900,
      publicBaseUrl: "https://assets.example.com",
      secretAccessKey: "secret-key",
    })
    expect(list.blobs).toEqual([
      expect.objectContaining({ pathname: "notes/hello.txt" }),
    ])
  })

  it("rechecks the active Cloudflare binding after runtime storage is cached", async () => {
    process.env.CLOUDFLARE_R2_ACCOUNT_ID = "account"
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "access-key"
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "secret-key"
    process.env.R2_BUCKET_NAME = "runtime-assets"
    setBlobRuntimeConfig({
      store: {
        accountId: "********",
        accessKeyId: "********",
        binding: "BLOB",
        bucketName: "********",
        driver: "cloudflare-r2",
        secretAccessKey: "********",
      },
    })
    setActiveCloudflareEnv({ BLOB: createMemoryBucket() })
    expectBlobSuccess(await blob.list())

    setActiveCloudflareEnv(undefined)
    expectBlobSuccess(await blob.list())

    expect(filesSdkMock.r2).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account",
      bucket: "runtime-assets",
    }))
  })

  it("keeps Cloudflare binding mode when the binding appears after driver creation", async () => {
    const { createDriver } = await import("../src/drivers/cloudflare.ts")
    const storage = createBlobStorage(createDriver({
      binding: "BLOB",
      bucketName: "assets",
      driver: "cloudflare-r2",
    }))

    setActiveCloudflareEnv({ BLOB: createMemoryBucket() })
    expectBlobSuccess(await storage.put("notes/late-binding.txt", "hello"))

    expect(filesSdkMock.r2).not.toHaveBeenCalled()
    expect(await expectBlobSuccess(await storage.get("notes/late-binding.txt"))?.text()).toBe("hello")
  })

  it("returns folded folders from the active Cloudflare binding", async () => {
    setBlobRuntimeConfig({
      store: {
        binding: "BLOB",
        bucketName: "assets",
        driver: "cloudflare-r2",
      },
    })
    setActiveCloudflareEnv({ BLOB: createMemoryBucket() })

    expectBlobSuccess(await blob.put("notes/hello.txt", "hello"))
    expectBlobSuccess(await blob.put("images/logo.png", "logo"))

    const list = expectBlobSuccess(await blob.list({ folded: true }))

    expect(list.blobs).toEqual([])
    expect(list.folders).toEqual(["images/", "notes/"])
  })

  it("loads non-core drivers through provider-specific driver imports", async () => {
    setBlobRuntimeConfig({
      store: {
        bucket: "assets",
        driver: "s3",
      },
    })

    const list = expectBlobSuccess(await blob.list())

    expect(filesSdkMock.s3).toHaveBeenCalledWith(expect.objectContaining({ driver: "s3" }))
    expect(list.blobs).toEqual([
      expect.objectContaining({
        pathname: "notes/hello.txt",
      }),
    ])
  })

  it("loads MinIO through its provider-specific driver import", async () => {
    process.env.MINIO_ROOT_PASSWORD = "password"
    process.env.MINIO_ROOT_USER = "minio"
    setBlobRuntimeConfig({
      store: {
        accessKeyId: "********",
        bucket: "assets",
        driver: "minio",
        endpoint: "http://minio:9000",
        forcePathStyle: true,
        region: "us-east-1",
        secretAccessKey: "********",
      },
    })

    const list = expectBlobSuccess(await blob.list())

    expect(filesSdkMock.minio).toHaveBeenCalledWith(expect.objectContaining({
      accessKeyId: "minio",
      bucket: "assets",
      driver: "minio",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      secretAccessKey: "password",
    }))
    expect(list.blobs).toEqual([
      expect.objectContaining({
        pathname: "notes/hello.txt",
      }),
    ])
  })

  it("decodes percent-encoded pathnames once before reaching drivers", async () => {
    const bucket = createMemoryBucket()
    setBlobRuntimeConfig({
      store: { binding: "BLOB", bucketName: "assets", driver: "cloudflare-r2" },
    })
    setActiveCloudflareEnv({ BLOB: bucket })

    // Users pass URL-encoded pathnames; storage decodes exactly once.
    // Before the fix, the Cloudflare driver decoded again and "%25" → "%" → URIError on the next op.
    expectBlobSuccess(await blob.put("notes/100%25.txt", "value"))
    expectBlobSuccess(await blob.put("notes/h%C3%A9llo.txt", "unicode"))
    expectBlobSuccess(await blob.put("notes/space%20file.txt", "raw"))

    const list = expectBlobSuccess(await blob.list())
    const keys = list.blobs.map((b: { pathname: string }) => b.pathname).sort()
    expect(keys).toEqual([
      "notes/100%.txt",
      "notes/héllo.txt",
      "notes/space file.txt",
    ])

    expect(await expectBlobSuccess(await blob.get("notes/100%25.txt"))?.text()).toBe("value")
    expectBlobSuccess(await blob.del("notes/h%C3%A9llo.txt"))
    const [missingError] = await blob.head("notes/h%C3%A9llo.txt")
    expect(missingError?.code).toBe("BLOB_NOT_FOUND")
  })

  it("passes decoded pathnames to the Vercel driver", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "secret-token"
    setBlobRuntimeConfig({
      store: { access: "public", driver: "vercel-blob", token: "********" },
    })

    expectBlobSuccess(await blob.put("notes/100%25.txt", "value"))
    expectBlobSuccess(await blob.del("notes/h%C3%A9llo.txt"))

    expect(vercelBlobMock.put).toHaveBeenCalledWith(
      "notes/100%.txt",
      "value",
      expect.anything(),
    )
    expect(vercelBlobMock.del).toHaveBeenCalledWith(
      ["notes/héllo.txt"],
      expect.anything(),
    )
  })

  it("accepts literal percent characters in blob pathnames", async () => {
    const bucket = createMemoryBucket()
    setBlobRuntimeConfig({
      store: { binding: "BLOB", bucketName: "assets", driver: "cloudflare-r2" },
    })
    setActiveCloudflareEnv({ BLOB: bucket })

    expectBlobSuccess(await blob.put("notes/100%.txt", "value"))

    expect(await expectBlobSuccess(await blob.get("notes/100%.txt"))?.text()).toBe("value")
    expect(expectBlobSuccess(await blob.list()).blobs).toEqual([
      expect.objectContaining({
        pathname: "notes/100%.txt",
      }),
    ])
  })

  it("binds Blob access inside the Cloudflare worker wrapper", async () => {
    const worker = createBlobCloudflareWorker({
      app: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/put") {
          expectBlobSuccess(await blob.put("notes/worker.txt", "hello"))
          return Response.json({ ok: true })
        }

        return Response.json(expectBlobSuccess(await blob.list()))
      },
      blob: {
        store: {
          binding: "BLOB",
          bucketName: "assets",
          driver: "cloudflare-r2",
        },
      },
    })

    const env = { BLOB: createMemoryBucket() }
    const put = await worker.fetch(new Request("https://example.com/put"), env, {})
    const list = await worker.fetch(new Request("https://example.com/list"), env, {})

    expect(await put.json()).toEqual({ ok: true })
    expect(await list.json()).toMatchObject({
      blobs: [{
        pathname: "notes/worker.txt",
      }],
    })
  })

  it("rehydrates R2 HTTP fallback secrets from the Cloudflare worker env", async () => {
    const worker = createBlobCloudflareWorker({
      app: async () => Response.json(expectBlobSuccess(await blob.list())),
      blob: {
        store: {
          accountId: "********",
          accessKeyId: "********",
          binding: "BLOB",
          bucketName: "********",
          driver: "cloudflare-r2",
          secretAccessKey: "********",
        },
      },
    })

    await worker.fetch(new Request("https://example.com/list"), {
      CLOUDFLARE_R2_ACCESS_KEY_ID: "worker-access-key",
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: "worker-secret-key",
      R2_ACCOUNT_ID: "worker-account",
      R2_BUCKET_NAME: "worker-assets",
    }, {})

    expect(filesSdkMock.r2).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "worker-account",
      accessKeyId: "worker-access-key",
      bucket: "worker-assets",
      secretAccessKey: "worker-secret-key",
    }))
  })

  it("keeps R2 HTTP fallback credentials isolated across worker envs", async () => {
    const worker = createBlobCloudflareWorker({
      app: async () => Response.json(expectBlobSuccess(await blob.list())),
      blob: {
        store: {
          accountId: "********",
          accessKeyId: "********",
          binding: "BLOB",
          bucketName: "********",
          driver: "cloudflare-r2",
          secretAccessKey: "********",
        },
      },
    })

    await worker.fetch(new Request("https://example.com/list"), {
      CLOUDFLARE_R2_ACCESS_KEY_ID: "first-access-key",
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: "first-secret-key",
      R2_ACCOUNT_ID: "first-account",
      R2_BUCKET_NAME: "first-assets",
    }, {})
    await worker.fetch(new Request("https://example.com/list"), {
      CLOUDFLARE_R2_ACCESS_KEY_ID: "second-access-key",
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: "second-secret-key",
      R2_ACCOUNT_ID: "second-account",
      R2_BUCKET_NAME: "second-assets",
    }, {})

    expect(filesSdkMock.r2).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accountId: "first-account",
      accessKeyId: "first-access-key",
      bucket: "first-assets",
      secretAccessKey: "first-secret-key",
    }))
    expect(filesSdkMock.r2).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountId: "second-account",
      accessKeyId: "second-access-key",
      bucket: "second-assets",
      secretAccessKey: "second-secret-key",
    }))
  })

  it("keeps the Cloudflare binding available for waitUntil Blob tasks", async () => {
    const waitUntilPromises: Promise<unknown>[] = []
    const worker = createBlobCloudflareWorker({
      app: async (request, context) => {
        const workerContext = context as { waitUntil?: (promise: Promise<unknown>) => void } | undefined
        const url = new URL(request.url)
        if (url.pathname === "/defer") {
          workerContext?.waitUntil?.((async () => {
            await Promise.resolve()
            expectBlobSuccess(await blob.put("notes/deferred.txt", "hello"))
          })())
          return Response.json({ ok: true })
        }

        return Response.json(expectBlobSuccess(await blob.list()))
      },
      blob: {
        store: {
          binding: "BLOB",
          bucketName: "assets",
          driver: "cloudflare-r2",
        },
      },
    })

    const env = { BLOB: createMemoryBucket() }
    const deferred = await worker.fetch(new Request("https://example.com/defer"), env, {
      waitUntil(promise) {
        waitUntilPromises.push(promise)
      },
    })

    await Promise.all(waitUntilPromises)
    const list = await worker.fetch(new Request("https://example.com/list"), env, {})

    expect(await deferred.json()).toEqual({ ok: true })
    expect(await list.json()).toMatchObject({
      blobs: [{
        pathname: "notes/deferred.txt",
      }],
    })
  })

  it("keeps Cloudflare bindings isolated across overlapping requests", async () => {
    const worker = createBlobCloudflareWorker({
      app: async (request) => {
        const url = new URL(request.url)
        const delay = Number(url.searchParams.get("delay") || "0")
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay))
        }
        expectBlobSuccess(await blob.put(`notes/${url.pathname.slice(1)}.txt`, url.pathname))
        return Response.json({ ok: true })
      },
      blob: {
        store: {
          binding: "BLOB",
          bucketName: "assets",
          driver: "cloudflare-r2",
        },
      },
    })

    const envA = { BLOB: createMemoryBucket() }
    const envB = { BLOB: createMemoryBucket() }

    await Promise.all([
      worker.fetch(new Request("https://example.com/slow?delay=25"), envA, {}),
      worker.fetch(new Request("https://example.com/fast"), envB, {}),
    ])

    setActiveCloudflareEnv(envA)
    expect(await expectBlobSuccess(await blob.get("notes/slow.txt"))?.text()).toBe("/slow")
    expect(expectBlobSuccess(await blob.get("notes/fast.txt"))).toBeNull()

    setActiveCloudflareEnv(envB)
    expect(await expectBlobSuccess(await blob.get("notes/fast.txt"))?.text()).toBe("/fast")
    expect(expectBlobSuccess(await blob.get("notes/slow.txt"))).toBeNull()
  })

})

describe("ensureBlob", () => {
  it("accepts valid content", () => {
    expect(() => ensureBlob(new Blob(["hello"], { type: "text/plain" }), {
      maxSize: "1KB",
      types: ["text"],
    })).not.toThrow()
  })

  it("rejects invalid types", () => {
    expect(() => ensureBlob(new Blob(["hello"], { type: "text/plain" }), {
      types: ["image"],
    })).toThrow("File type is invalid")
  })
})
