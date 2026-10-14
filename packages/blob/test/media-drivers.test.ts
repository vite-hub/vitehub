import { H3Event } from "h3"
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver as createR2Driver } from "../src/drivers/cloudflare-native.ts"
import { createBundledVercelBlobDriver } from "../src/drivers/vercel-bundled.ts"
import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "../src/runtime/state.ts"
import { createBlobStorage } from "../src/storage.ts"
import type { BlobResult } from "../src/types.ts"

// An in-memory Vercel Blob that, like the service, has no custom metadata and can forbid overwrites.
const vercel = vi.hoisted(() => {
  const objects = new Map<string, { body: Uint8Array, contentType?: string, etag: string, uploadedAt: Date }>()
  let version = 0
  const toPathname = (value: string) => value.startsWith("https://") ? decodeURIComponent(new URL(value).pathname.slice(1)) : value
  const describe = (pathname: string) => {
    const object = objects.get(pathname)!
    return { contentType: object.contentType, etag: object.etag, pathname, size: object.body.byteLength, uploadedAt: object.uploadedAt, url: `https://store.public.blob.vercel-storage.com/${encodeURI(pathname)}` }
  }
  const missing = () => Object.assign(new Error("Vercel Blob: The requested blob does not exist"), { name: "BlobNotFoundError" })
  return {
    calls: [] as Array<Record<string, unknown>>,
    objects,
    module: {
      async del(pathnames: string | string[]) {
        for (const pathname of [pathnames].flat()) objects.delete(toPathname(pathname))
      },
      async get(url: string) {
        const pathname = toPathname(url)
        const object = objects.get(pathname)
        if (!object) throw missing()
        return { blob: describe(pathname), stream: new Blob([object.body as Uint8Array<ArrayBuffer>]).stream() }
      },
      async head(value: string) {
        const pathname = toPathname(value)
        if (!objects.has(pathname)) throw missing()
        return describe(pathname)
      },
      async list(options: { cursor?: string, limit?: number, mode?: string, prefix?: string }) {
        const prefix = options.prefix ?? ""
        const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort()
        if (options.mode !== "folded") return { blobs: keys.map(describe), hasMore: false }
        const folders = new Set<string>()
        const blobs = []
        for (const key of keys) {
          const slash = key.indexOf("/", prefix.length)
          if (slash >= 0) folders.add(key.slice(0, slash + 1))
          else blobs.push(describe(key))
        }
        return { blobs, folders: [...folders], hasMore: false }
      },
      async put(pathname: string, body: unknown, options: Record<string, unknown>) {
        vercel.calls.push({ pathname, ...options })
        if (options.allowOverwrite === false && objects.has(pathname)) throw new Error("Vercel Blob: This blob already exists")
        const bytes = new Uint8Array(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer())
        objects.set(pathname, { body: bytes, contentType: options.contentType as string | undefined, etag: `"v${++version}"`, uploadedAt: new Date() })
        return describe(pathname)
      },
    },
  }
})

vi.mock("@vercel/blob", () => vercel.module)

function ok<TResult>(result: BlobResult<TResult>): TResult {
  expect(result[0]).toBeNull()
  return result[1] as TResult
}

function photo(width: number, height: number) {
  return sharp({ create: { background: { alpha: 1, b: 40, g: 120, r: 200 }, channels: 3, height, width } }).jpeg().toBuffer()
}

function request() {
  return new H3Event(new Request("https://example.test/photo"))
}

describe("media on Vercel Blob", () => {
  beforeEach(() => {
    vercel.objects.clear()
    vercel.calls.length = 0
  })

  it("keeps records in sidecars, never in custom metadata, even when overwrites are forbidden", async () => {
    const driver = createBundledVercelBlobDriver({ access: "public", allowOverwrite: false, driver: "vercel-blob", token: "token" })
    const storage = createBlobStorage(driver, "default", { images: { transformer: "passthrough" } })
    const record = ok(await storage.media.put("posts/cover.jpg", await photo(320, 200), { alt: "Cover" }))
    expect(record).toMatchObject({ alt: "Cover", etag: "\"v1\"", height: 200, width: 320 })
    expect(vercel.objects.has("_vitehub/media/records/posts/cover.jpg.json")).toBe(true)
    expect(vercel.calls.every(call => !("customMetadata" in call))).toBe(true)

    // Record rewrites remove and re-create the sidecar when the provider refuses an overwrite.
    expect(ok(await storage.media.update("posts/cover.jpg", { alt: "New" }))).toMatchObject({ alt: "New" })
    expect(ok(await storage.media.get("posts/cover.jpg"))).toMatchObject({ alt: "New" })

    const [rejected] = await storage.put("x.txt", "x", { customMetadata: { a: "b" } })
    expect(rejected?.cause).toMatchObject({ code: "BLOB_R0011" })
  })

  it("lists folded folders and moves media with copy and delete", async () => {
    const storage = createBlobStorage(createBundledVercelBlobDriver({ access: "public", driver: "vercel-blob", token: "token" }), "default", { images: { transformer: "passthrough" } })
    ok(await storage.media.put("a/one.jpg", await photo(20, 20)))
    ok(await storage.media.createFolder("a/empty"))
    const listed = ok(await storage.media.list({ prefix: "a/" }))
    expect(listed.folders).toEqual(["a/empty/"])
    expect(listed.items.map(item => item.pathname)).toEqual(["a/one.jpg"])
    const moved = ok(await storage.media.move("a/one.jpg", "b/one.jpg"))
    expect(moved).toMatchObject({ etag: expect.any(String), pathname: "b/one.jpg", width: 20 })
    expect([...vercel.objects.keys()].sort()).toEqual(["_vitehub/media/hashes/" + moved.hash + ".json", "_vitehub/media/records/b/one.jpg.json", "a/empty/.keep", "b/one.jpg"])
  })
})

function createMemoryBucket() {
  const objects = new Map<string, { body: Uint8Array, contentType?: string, etag: string, uploaded: Date }>()
  let version = 0
  const describe = (key: string) => {
    const object = objects.get(key)!
    return { httpEtag: object.etag, httpMetadata: { contentType: object.contentType }, key, size: object.body.byteLength, uploaded: object.uploaded }
  }
  return {
    objects,
    async delete(key: string) {
      objects.delete(key)
    },
    async get(key: string) {
      const object = objects.get(key)
      return object ? { ...describe(key), arrayBuffer: async () => object.body.slice().buffer } : null
    },
    async head(key: string) {
      return objects.has(key) ? describe(key) : null
    },
    async list(options: { delimiter?: string, prefix?: string } = {}) {
      const prefix = options.prefix ?? ""
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort()
      const delimitedPrefixes = new Set<string>()
      const listed = []
      for (const key of keys) {
        const slash = options.delimiter ? key.indexOf("/", prefix.length) : -1
        if (slash >= 0) delimitedPrefixes.add(key.slice(0, slash + 1))
        else listed.push(describe(key))
      }
      return { delimitedPrefixes: [...delimitedPrefixes], objects: listed, truncated: false }
    },
    async put(key: string, value: unknown, options: { httpMetadata?: { contentType?: string } } = {}) {
      objects.set(key, { body: new Uint8Array(await new Response(value as ConstructorParameters<typeof Response>[0]).arrayBuffer()), contentType: options.httpMetadata?.contentType, etag: `"r${++version}"`, uploaded: new Date() })
      return describe(key)
    },
  }
}

/** A Cloudflare Images binding backed by sharp, recording what ViteHub asks for. */
function createImagesBinding() {
  const requests: Array<{ output: Record<string, unknown>, transform: Record<string, unknown> }> = []
  return {
    requests,
    input(stream: ReadableStream<Uint8Array>) {
      let transform: Record<string, unknown> = {}
      const chain = {
        transform(options: Record<string, unknown>) {
          transform = options
          return chain
        },
        async output(output: { format: string, quality?: number }) {
          requests.push({ output, transform })
          let pipeline = sharp(new Uint8Array(await new Response(stream).arrayBuffer())).rotate()
          const trim = transform.trim as { height: number, left: number, top: number, width: number } | undefined
          if (trim) pipeline = pipeline.extract(trim)
          const bytes = await pipeline.resize(transform.width as number, transform.height as number, { fit: "cover" })
            .toFormat(output.format.replace("image/", "") as "webp", { quality: output.quality })
            .toBuffer()
          return { contentType: () => output.format, response: () => new Response(new Uint8Array(bytes)) }
        },
      }
      return chain
    },
  }
}

describe("media on a Cloudflare R2 binding", () => {
  afterEach(() => {
    clearActiveCloudflareEnv()
  })

  it("uses the Images binding for variants and color, with the crop as a trim", async () => {
    const bucket = createMemoryBucket()
    const images = createImagesBinding()
    setActiveCloudflareEnv({ BLOB: bucket, IMAGES: images })
    const storage = createBlobStorage(createR2Driver({ binding: "BLOB", driver: "cloudflare-r2" }), "default")
    const record = ok(await storage.media.put("photos/wide.jpg", await photo(1600, 800), { crops: { mobile: { aspect: "4:5", focal: { x: 0, y: 0.5 } } } }))
    expect(record).toMatchObject({ color: expect.stringMatching(/^#[0-9a-f]{6}$/), height: 800, width: 1600 })
    expect(images.requests[0]).toEqual({ output: { format: "image/png" }, transform: { fit: "cover", height: 1, width: 1 } })

    const event = request()
    const [, body] = await storage.serve(event, "photos/wide.jpg", { variant: { crop: "mobile", format: "avif", quality: 50, width: 384 } })
    expect(images.requests[1]).toEqual({
      output: { format: "image/avif", quality: 50 },
      transform: { fit: "cover", height: 480, trim: { height: 800, left: 0, top: 0, width: 640 }, width: 384 },
    })
    expect(event.res.headers.get("content-type")).toBe("image/avif")
    expect(await sharp(new Uint8Array(await new Response(body).arrayBuffer())).metadata()).toMatchObject({ height: 480, width: 384 })
    expect([...bucket.objects.keys()].some(key => key.startsWith("_vitehub/derived/"))).toBe(true)
  })

  it("falls back to sharp or the original when the Worker has no Images binding", async () => {
    setActiveCloudflareEnv({ BLOB: createMemoryBucket() })
    const passthrough = createBlobStorage(createR2Driver({ binding: "BLOB", driver: "cloudflare-r2" }), "default", { images: { transformer: "passthrough" } })
    ok(await passthrough.media.put("a.jpg", await photo(100, 50)))
    const event = request()
    await passthrough.serve(event, "a.jpg", { variant: { width: 64 } })
    expect(event.res.headers.get("content-type")).toBe("image/jpeg")

    const explicit = createBlobStorage(createR2Driver({ binding: "BLOB", driver: "cloudflare-r2" }), "default", { images: { transformer: "cloudflare-images" } })
    const [error] = await explicit.serve(request(), "a.jpg", { variant: { width: 64 } })
    expect(error?.cause).toMatchObject({ code: "BLOB_R0034" })
  })
})
