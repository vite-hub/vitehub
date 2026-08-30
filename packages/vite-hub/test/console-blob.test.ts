import { afterEach, describe, expect, it, vi } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import {
  consoleBlobKey,
  consoleBlobRegistryKey,
  consoleBlobRootKey,
  installConsoleBlobScope,
  resolveConsoleBlob,
} from "../src/console/internal.ts"
import blobHandler from "../src/console/runtime/server/blob.get.ts"
import { installConsoleBlob } from "../src/console/runtime/server/blob.ts"

import type { BlobListOptions, BlobObject, BlobResult, BlobStorage } from "@vite-hub/blob"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

// SAFETY: ConsoleInvocationScope only adds optional symbol-keyed test state to the global object.
const scope = globalThis as ConsoleInvocationScope

function success<TResult>(value: TResult): BlobResult<TResult> {
  return [null, value]
}

function event(query = "", method = "GET"): ConsoleRequestEvent {
  return {
    method,
    node: { req: { method, url: `http://localhost/api/_vitehub/console/blob${query}` } },
    req: { method, url: `http://localhost/api/_vitehub/console/blob${query}` },
  }
}

function object(pathname: string, options: Partial<BlobObject> = {}): BlobObject {
  return {
    contentType: "text/plain",
    customMetadata: {},
    httpEtag: `etag-${pathname}`,
    httpMetadata: {},
    pathname,
    uploadedAt: new Date("2026-08-27T12:00:00.000Z"),
    ...options,
  }
}

function memoryBlob(stores: Record<string, BlobObject[]>): {
  list: ReturnType<typeof vi.fn>
  reads: ReturnType<typeof vi.fn>
  storage: BlobStorage
  writes: ReturnType<typeof vi.fn>
} {
  const list = vi.fn(async (name: string, options: BlobListOptions = {}) => {
    const matching = (stores[name] ?? []).filter(item => item.pathname.startsWith(options.prefix ?? ""))
    const start = options.cursor ? Number(options.cursor) : 0
    const limit = options.limit ?? matching.length
    const blobs = matching.slice(start, start + limit)
    const next = start + blobs.length
    const page: { blobs: BlobObject[]; cursor?: string; hasMore: boolean } = {
      blobs,
      hasMore: next < matching.length,
    }
    if (next < matching.length) page.cursor = String(next)
    return success(page)
  })
  const reads = vi.fn()
  const writes = vi.fn()
  function storage(name = "default"): BlobStorage {
    return {
      del: async () => { writes("del"); return success(undefined) },
      get: async () => { reads("get"); return success(null) },
      head: async pathname => { reads("head"); return success(object(pathname)) },
      list: async options => list(name, options),
      put: async pathname => { writes("put"); return success(object(pathname)) },
      serve: async () => { reads("serve"); return success(new ReadableStream()) },
      sign: async () => { reads("sign"); return success({ headers: {}, method: "GET", url: "https://secret.example" }) },
      store: storage,
    }
  }
  return { list, reads, storage: storage(), writes }
}

afterEach(() => {
  delete scope[consoleBlobKey]
  delete scope[consoleBlobRootKey]
  Reflect.deleteProperty(process, consoleBlobKey)
  Reflect.deleteProperty(process, consoleBlobRootKey)
  Reflect.deleteProperty(process, consoleBlobRegistryKey)
})

describe("Console Blob inspection", () => {
  it("isolates concurrent project stores across runtime realms", () => {
    const first = memoryBlob({ default: [object("first.txt")] }).storage
    const second = memoryBlob({ default: [object("second.txt")] }).storage
    const processRegistry = {}
    const firstScope: ConsoleInvocationScope = { process: processRegistry }
    const secondScope: ConsoleInvocationScope = { process: processRegistry }

    installConsoleBlobScope("/first", { storage: first, stores: ["default"] }, firstScope)
    installConsoleBlobScope("/second", { storage: second, stores: ["default"] }, secondScope)

    expect(resolveConsoleBlob(firstScope)?.storage).toBe(first)
    expect(resolveConsoleBlob(secondScope)?.storage).toBe(second)
    expect(resolveConsoleBlob({ process: processRegistry })).toBeUndefined()
  })

  it("lists bounded object metadata without exposing URLs or reading bodies", async () => {
    const { list, reads, storage, writes } = memoryBlob({
      archive: [object("old/report.pdf")],
      default: [
        object("logs/first.txt", {
          customMetadata: { tenant: "acme" },
          httpMetadata: { cacheControl: "max-age=60" },
          size: 42,
          url: "https://provider.example/private-token",
        }),
        object("logs/second.txt"),
        object("other.txt"),
      ],
    })
    installConsoleBlob("/project", storage, ["archive", "default", "archive"])

    const page = await blobHandler(event("?prefix=logs%2F&limit=1"))
    expect(page).toEqual({
      blobs: [{
        contentType: "text/plain",
        customMetadata: { tenant: "acme" },
        httpEtag: "etag-logs/first.txt",
        httpMetadata: { cacheControl: "max-age=60" },
        pathname: "logs/first.txt",
        size: 42,
        uploadedAt: "2026-08-27T12:00:00.000Z",
        urlAvailable: true,
      }],
      cursor: "1",
      hasMore: true,
      limit: 1,
      prefix: "logs/",
      store: "default",
      stores: ["default", "archive"],
    })
    expect(JSON.stringify(page)).not.toContain("private-token")
    await expect(blobHandler(event("?store=archive"))).resolves.toMatchObject({
      blobs: [expect.objectContaining({ pathname: "old/report.pdf" })],
      store: "archive",
    })
    expect(list).toHaveBeenCalledWith("default", { cursor: undefined, limit: 1, prefix: "logs/" })
    expect(reads).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
  })

  it("validates methods, stores, cursors, prefixes, and list limits", async () => {
    const { storage } = memoryBlob({ default: [] })
    installConsoleBlob("/project", storage)

    await expect(blobHandler(event("", "POST"))).rejects.toMatchObject({ statusCode: 405 })
    await expect(blobHandler(event("?store=unknown"))).rejects.toMatchObject({ statusCode: 404 })
    await expect(blobHandler(event("?limit=251"))).rejects.toMatchObject({ statusCode: 400 })
    await expect(blobHandler(event(`?prefix=${"x".repeat(8_193)}`))).rejects.toMatchObject({ statusCode: 400 })
    await expect(blobHandler(event(`?cursor=${"x".repeat(8_193)}`))).rejects.toMatchObject({ statusCode: 400 })
  })

  it("converts provider list failures into gateway errors", async () => {
    const { storage } = memoryBlob({ default: [] })
    storage.list = async () => [new ViteHubError("BLOB_OPERATION_FAILED", "Provider unavailable", {
      details: { operation: "list", store: "default" },
    }), undefined]
    installConsoleBlob("/project", storage)

    await expect(blobHandler(event())).rejects.toMatchObject({ message: "Provider unavailable", statusCode: 502 })
  })
})
