import { afterEach, describe, expect, it, vi } from "vitest"

const runtimeConfigMock = vi.hoisted(() => ({
  blob: undefined as undefined | false | {
    store: {
      binding?: string
      bucketName?: string
      driver: "cloudflare-r2" | "fs" | "vercel-blob"
      token?: string
      access?: "private" | "public"
    }
  },
}))

interface NitroRequestMock {
  context?: {
    cloudflare?: {
      env?: Record<string, unknown>
    }
  }
  url: string
}

vi.mock("nitro", () => ({
  definePlugin: (plugin: unknown) => plugin,
}))

vi.mock("nitro/runtime-config", () => ({
  useRuntimeConfig: () => runtimeConfigMock,
}))

import { ensureBlob } from "../src/ensure.ts"
import { blob } from "../src/runtime/storage.ts"
import { createBlobCloudflareWorker } from "../src/runtime/cloudflare-vite.ts"
import {
  setActiveCloudflareEnv,
  setBlobRuntimeConfig,
  setBlobRuntimeStorage,
} from "../src/runtime/state.ts"

const vercelBlobMock = vi.hoisted(() => ({
  del: vi.fn(async () => {}),
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
    pathname,
    size: 5,
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    url: `https://blob.example/${pathname}`,
  })),
}))

vi.mock("@vercel/blob", () => ({
  del: vercelBlobMock.del,
  head: vercelBlobMock.head,
  list: vercelBlobMock.list,
  put: vercelBlobMock.put,
}))

afterEach(() => {
  runtimeConfigMock.blob = undefined
  setActiveCloudflareEnv(undefined)
  setBlobRuntimeConfig(undefined)
  setBlobRuntimeStorage(undefined)
  vercelBlobMock.del.mockClear()
  vercelBlobMock.head.mockClear()
  vercelBlobMock.list.mockClear()
  vercelBlobMock.put.mockClear()
  delete process.env.BLOB_READ_WRITE_TOKEN
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
    async list() {
      return {
        objects: [...store.entries()].map(([key, value]) => ({
          customMetadata: value.customMetadata,
          httpEtag: "\"etag\"",
          httpMetadata: { contentType: value.contentType },
          key,
          size: value.body.byteLength,
          uploaded: value.uploaded,
        })),
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
  it("rehydrates the masked Vercel token", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "secret-token"
    setBlobRuntimeConfig({
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "********",
      },
    })

    const result = await blob.put("notes/hello.txt", "hello")

    expect(result.pathname).toBe("notes/hello.txt")
    expect(vercelBlobMock.put).toHaveBeenCalledWith("notes/hello.txt", "hello", expect.objectContaining({
      access: "public",
      token: "secret-token",
    }))
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

    await blob.put("notes/hello.txt", "hello", {
      contentType: "text/plain",
      customMetadata: { test: "true" },
    })

    const list = await blob.list()
    const head = await blob.head("notes/hello.txt")
    const body = await blob.get("notes/hello.txt")

    expect(list.blobs).toHaveLength(1)
    expect(head.customMetadata).toEqual({ test: "true" })
    expect(await body?.text()).toBe("hello")

    await blob.del("notes/hello.txt")
    await expect(blob.head("notes/hello.txt")).rejects.toThrow("Blob not found")
  })

  it("decodes percent-encoded pathnames once before reaching drivers", async () => {
    const bucket = createMemoryBucket()
    setBlobRuntimeConfig({
      store: { binding: "BLOB", bucketName: "assets", driver: "cloudflare-r2" },
    })
    setActiveCloudflareEnv({ BLOB: bucket })

    // Users pass URL-encoded pathnames; storage decodes exactly once.
    // Before the fix, the Cloudflare driver decoded again and "%25" → "%" → URIError on the next op.
    await blob.put("notes/100%25.txt", "value")
    await blob.put("notes/h%C3%A9llo.txt", "unicode")
    await blob.put("notes/space%20file.txt", "raw")

    const list = await blob.list()
    const keys = list.blobs.map(b => b.pathname).sort()
    expect(keys).toEqual([
      "notes/100%.txt",
      "notes/héllo.txt",
      "notes/space file.txt",
    ])

    expect(await (await blob.get("notes/100%25.txt"))?.text()).toBe("value")
    await blob.del("notes/h%C3%A9llo.txt")
    await expect(blob.head("notes/h%C3%A9llo.txt")).rejects.toThrow("Blob not found")
  })

  it("passes decoded pathnames to the Vercel driver", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "secret-token"
    setBlobRuntimeConfig({
      store: { access: "public", driver: "vercel-blob", token: "********" },
    })

    await blob.put("notes/100%25.txt", "value")
    await blob.del("notes/h%C3%A9llo.txt")

    expect(vercelBlobMock.put).toHaveBeenCalledWith(
      "notes/100%.txt",
      "value",
      expect.anything(),
    )
    expect(vercelBlobMock.head).toHaveBeenCalledWith(
      "notes/héllo.txt",
      expect.anything(),
    )
  })

  it("accepts literal percent characters in blob pathnames", async () => {
    const bucket = createMemoryBucket()
    setBlobRuntimeConfig({
      store: { binding: "BLOB", bucketName: "assets", driver: "cloudflare-r2" },
    })
    setActiveCloudflareEnv({ BLOB: bucket })

    await blob.put("notes/100%.txt", "value")

    expect(await (await blob.get("notes/100%.txt"))?.text()).toBe("value")
    expect((await blob.list()).blobs).toEqual([
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
          await blob.put("notes/worker.txt", "hello")
          return Response.json({ ok: true })
        }

        return Response.json(await blob.list())
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

  it("keeps the Cloudflare binding available for waitUntil Blob tasks", async () => {
    const waitUntilPromises: Promise<unknown>[] = []
    const worker = createBlobCloudflareWorker({
      app: async (request, context) => {
        const workerContext = context as { waitUntil?: (promise: Promise<unknown>) => void } | undefined
        const url = new URL(request.url)
        if (url.pathname === "/defer") {
          workerContext?.waitUntil?.((async () => {
            await Promise.resolve()
            await blob.put("notes/deferred.txt", "hello")
          })())
          return Response.json({ ok: true })
        }

        return Response.json(await blob.list())
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
        await blob.put(`notes/${url.pathname.slice(1)}.txt`, url.pathname)
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
    expect(await (await blob.get("notes/slow.txt"))?.text()).toBe("/slow")
    expect(await blob.get("notes/fast.txt")).toBeNull()

    setActiveCloudflareEnv(envB)
    expect(await (await blob.get("notes/fast.txt"))?.text()).toBe("/fast")
    expect(await blob.get("notes/slow.txt")).toBeNull()
  })

  it("hydrates Blob runtime state from the Nitro plugin", async () => {
    runtimeConfigMock.blob = {
      store: {
        binding: "BLOB",
        bucketName: "assets",
        driver: "cloudflare-r2",
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as unknown as (nitroApp: {
      fetch: (request: NitroRequestMock) => Promise<Response>
      hooks: { hook: (name: string, cb: (event?: unknown) => void) => void }
    }) => void

    const hooks = new Map<string, (event?: unknown) => void>()
    const nitroApp: {
      fetch: (request: NitroRequestMock) => Promise<Response>
      hooks: { hook: (name: string, cb: (event?: unknown) => void) => void }
    } = {
      async fetch() {
        await blob.put("notes/nitro.txt", "hello nitro")
        return Response.json({ ok: true })
      },
      hooks: {
        hook(name: string, cb: (event?: unknown) => void) {
          hooks.set(name, cb)
        },
      },
    }

    plugin(nitroApp)

    hooks.get("request")?.({
      context: {
        cloudflare: {
          env: {
            BLOB: createMemoryBucket(),
          },
        },
      },
    })

    const env = {
      BLOB: createMemoryBucket(),
    }

    await nitroApp.fetch({
      url: "https://example.com/nitro",
      context: {
        cloudflare: {
          env,
        },
      },
    })

    setActiveCloudflareEnv(env)
    expect(await (await blob.get("notes/nitro.txt"))?.text()).toBe("hello nitro")
  })

  it("keeps Cloudflare bindings isolated across overlapping Nitro requests", async () => {
    runtimeConfigMock.blob = {
      store: {
        binding: "BLOB",
        bucketName: "assets",
        driver: "cloudflare-r2",
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as unknown as (nitroApp: {
      fetch: (request: NitroRequestMock) => Promise<Response>
      hooks: { hook: (name: string, cb: (event?: unknown) => void) => void }
    }) => void

    const hooks = new Map<string, (event?: unknown) => void>()
    const nitroApp = {
      async fetch(request: NitroRequestMock) {
        const url = new URL(request.url)
        const delay = Number(url.searchParams.get("delay") || "0")
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay))
        }
        await blob.put(`notes/${url.pathname.slice(1)}.txt`, url.pathname)
        return Response.json({ ok: true })
      },
      hooks: {
        hook(name: string, cb: (event?: unknown) => void) {
          hooks.set(name, cb)
        },
      },
    }

    plugin(nitroApp)

    const envA = { BLOB: createMemoryBucket() }
    const envB = { BLOB: createMemoryBucket() }

    await Promise.all([
      nitroApp.fetch({
        url: "https://example.com/slow?delay=25",
        context: {
          cloudflare: { env: envA },
        },
      }),
      nitroApp.fetch({
        url: "https://example.com/fast",
        context: {
          cloudflare: { env: envB },
        },
      }),
    ])

    setActiveCloudflareEnv(envA)
    expect(await (await blob.get("notes/slow.txt"))?.text()).toBe("/slow")
    expect(await blob.get("notes/fast.txt")).toBeNull()

    setActiveCloudflareEnv(envB)
    expect(await (await blob.get("notes/fast.txt"))?.text()).toBe("/fast")
    expect(await blob.get("notes/slow.txt")).toBeNull()
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
