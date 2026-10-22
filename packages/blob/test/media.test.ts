import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3Event } from "h3"
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"
import { createSharpImageTransformer } from "../src/media/transformers.ts"
import { createBlobStorage } from "../src/storage.ts"
import type { BlobImageOperation, BlobImageTransformer } from "../src/media/types.ts"
import type { BlobResult, BlobStorage } from "../src/types.ts"

function ok<TResult>(result: BlobResult<TResult>): TResult {
  expect(result[0]).toBeNull()
  return result[1] as TResult
}

function photo(width: number, height: number, color = { b: 40, g: 120, r: 200 }) {
  return sharp({ create: { background: { ...color, alpha: 1 }, channels: 3, height, width } }).jpeg().toBuffer()
}

function request(url = "https://example.test/photo", headers?: Record<string, string>) {
  return new H3Event(new Request(url, { headers }))
}

/** Records every operation and returns a small WebP whose size matches the request. */
function recordingTransformer(): BlobImageTransformer & { operations: BlobImageOperation[] } {
  const operations: BlobImageOperation[] = []
  const sharpTransformer = createSharpImageTransformer(sharp as never)
  return {
    name: "recording",
    operations,
    transform(input, operation) {
      operations.push(operation)
      return sharpTransformer.transform(input, operation)
    },
  }
}

describe("media records on the fs driver", () => {
  let directory: string
  let storage: BlobStorage

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-media-"))
    storage = createBlobStorage(createDriver({ base: directory, driver: "fs" }), "default", {
      images: createSharpImageTransformer(sharp as never),
      url: pathname => `/api/_vitehub/blob/${pathname}`,
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(directory, { force: true, recursive: true })
  })

  it("stores a probed, hashed record as a JSON sidecar in the same store", async () => {
    const bytes = await photo(1200, 800)
    const record = ok(await storage.media.put("posts/cover.jpg", bytes, { alt: "A red field", focal: { x: 0.25, y: 0.5 } }))
    expect(record).toMatchObject({
      alt: "A red field",
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      contentType: "image/jpeg",
      focal: { x: 0.25, y: 0.5 },
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      height: 800,
      pathname: "posts/cover.jpg",
      size: bytes.byteLength,
      url: "/api/_vitehub/blob/posts/cover.jpg",
      width: 1200,
    })
    const sidecar = JSON.parse(await readFile(join(directory, "_vitehub/media/records/posts/cover.jpg.json"), "utf8"))
    expect(sidecar).toMatchObject({ alt: "A red field", hash: record.hash, pathname: "posts/cover.jpg", width: 1200 })
    expect(sidecar).not.toHaveProperty("url")
    expect(ok(await storage.media.get({ pathname: "posts/cover.jpg" }))).toEqual(record)
  })

  it("keeps ViteHub's media namespace out of public writes, serving, and reference pathnames", async () => {
    await storage.media.put("cover.jpg", await photo(10, 10))
    await expect(storage.put("_vitehub/media/records/cover.jpg.json", "{}")).rejects.toThrow("reserved ViteHub namespace")
    await expect(storage.media.put("_vitehub/media/x.jpg", "x")).rejects.toThrow("reserved ViteHub namespace")
    const [error] = await storage.serve(request(), "_vitehub/media/records/cover.jpg.json")
    expect(error?.code).toBe("BLOB_NOT_FOUND")
  })

  it("deduplicates uploads by content hash when asked", async () => {
    const bytes = await photo(64, 64)
    const first = ok(await storage.media.put("a/one.jpg", bytes))
    const duplicate = ok(await storage.media.put("b/two.jpg", bytes, { dedupe: true }))
    expect(duplicate.pathname).toBe("a/one.jpg")
    expect(ok(await storage.head("b/two.jpg"))).toBeNull()
    const copy = ok(await storage.media.put("b/two.jpg", bytes))
    expect(copy).toMatchObject({ hash: first.hash, pathname: "b/two.jpg" })
  })

  it("dedupes multipart uploads into a folder by default", async () => {
    const bytes = await photo(32, 32)
    const upload = async () => {
      const form = new FormData()
      form.append("files", new File([bytes], "../photo.jpg", { type: "image/jpeg" }))
      return ok(await storage.media.handleUpload({ req: new Request("https://example.test/upload", { body: form, method: "POST" }) }, { folder: "uploads/2026" }))
    }
    const [first] = await upload()
    const [second] = await upload()
    expect(first).toMatchObject({ height: 32, pathname: "uploads/2026/photo.jpg", width: 32 })
    expect(second!.pathname).toBe("uploads/2026/photo.jpg")
  })

  it("rebuilds a stale record after a plain write and keeps editorial fields", async () => {
    await storage.media.put("hero.jpg", await photo(400, 200), { alt: "Hero", caption: "Caption" })
    await storage.put("hero.jpg", await photo(100, 300))
    const [listed] = ok(await storage.media.list()).items
    expect(listed).toMatchObject({ alt: "Hero", pathname: "hero.jpg" })
    expect(listed).not.toHaveProperty("width")
    expect(ok(await storage.media.get("hero.jpg"))).toMatchObject({ alt: "Hero", caption: "Caption", height: 300, width: 100 })
  })

  it("builds records for objects written without media", async () => {
    await storage.put("plain/notes.txt", "hello")
    expect(ok(await storage.media.get("plain/notes.txt"))).toMatchObject({ contentType: "text/plain; charset=utf-8", hash: expect.any(String), pathname: "plain/notes.txt", size: 5 })
    expect(ok(await storage.media.get("plain/missing.txt"))).toBeNull()
  })

  it("updates alt text, focal point, and crops, and validates input", async () => {
    await storage.media.put("hero.jpg", await photo(400, 200))
    const updated = ok(await storage.media.update("hero.jpg", {
      alt: "Mountains",
      crops: { mobile: { aspect: "4:5", focal: { x: 0.8, y: 0.5 } }, square: { aspect: "1:1" } },
      focal: { x: 0.3, y: 0.3 },
    }))
    expect(updated).toMatchObject({ alt: "Mountains", crops: { mobile: { aspect: "4:5", focal: { x: 0.8, y: 0.5 } }, square: { aspect: "1:1" } }, focal: { x: 0.3, y: 0.3 } })
    const cleared = ok(await storage.media.update("hero.jpg", { alt: null, crops: { square: null }, focal: null }))
    expect(cleared).not.toHaveProperty("alt")
    expect(cleared).not.toHaveProperty("focal")
    expect(Object.keys(cleared.crops!)).toEqual(["mobile"])
    await expect(storage.media.update("hero.jpg", { focal: { x: 2, y: 0 } })).rejects.toThrow("from 0 to 1")
    await expect(storage.media.update("hero.jpg", { crops: { "bad name": { aspect: "1:1" } } })).rejects.toThrow("Crop name")
    await expect(storage.media.update("hero.jpg", { crops: { wide: { aspect: "wide" } } })).rejects.toThrow("aspect")
    const [error] = await storage.media.update("missing.jpg", { alt: "x" })
    expect(error?.code).toBe("BLOB_NOT_FOUND")
  })

  it("moves an object with its record and crop replacements, and invalidates variants", async () => {
    await storage.media.put("old/hero.jpg", await photo(400, 200), { alt: "Hero" })
    ok(await storage.media.replaceCrop("old/hero.jpg", "mobile", await photo(80, 100)))
    await storage.serve(request(), "old/hero.jpg", { variant: { width: 64 } })
    expect(ok(await storage.media.variants("old/hero.jpg"))).toHaveLength(1)
    const before = ok(await storage.media.get("old/hero.jpg"))!

    const moved = ok(await storage.media.move("old/hero.jpg", "new/hero.jpg"))
    expect(moved).toMatchObject({ alt: "Hero", hash: before.hash, pathname: "new/hero.jpg", url: "/api/_vitehub/blob/new/hero.jpg" })
    expect(moved.crops!.mobile!.replacement!.pathname).not.toBe(before.crops!.mobile!.replacement!.pathname)
    expect(ok(await storage.get(moved.crops!.mobile!.replacement!.pathname))).not.toBeNull()
    expect(ok(await storage.get(before.crops!.mobile!.replacement!.pathname))).toBeNull()
    expect(ok(await storage.head("old/hero.jpg"))).toBeNull()
    expect(ok(await storage.media.get("old/hero.jpg"))).toBeNull()
    const derived = ok(await storage.list({ prefix: "_vitehub/derived/" }))
    expect(derived.blobs).toHaveLength(0)
    expect(ok(await storage.list({ prefix: "_vitehub/media/records/" })).blobs.map(object => object.pathname)).toEqual(["_vitehub/media/records/new/hero.jpg.json"])

    await storage.media.put("other.jpg", await photo(10, 10))
    const [conflict] = await storage.media.move("other.jpg", "new/hero.jpg")
    expect(conflict?.code).toBe("BLOB_CONFLICT")
    expect(ok(await storage.media.move("other.jpg", "new/hero.jpg", { overwrite: true })).pathname).toBe("new/hero.jpg")
  })

  it("removes an object with its record, crops, hash entry, and variants", async () => {
    const record = ok(await storage.media.put("gone.jpg", await photo(100, 100)))
    ok(await storage.media.replaceCrop("gone.jpg", "wide", await photo(160, 90)))
    await storage.serve(request(), "gone.jpg", { variant: { crop: "wide", width: 64 } })
    ok(await storage.media.remove("gone.jpg"))
    expect(ok(await storage.list({ prefix: "_vitehub/" })).blobs).toEqual([])
    expect(ok(await storage.media.put("again.jpg", await photo(100, 100), { dedupe: true })).pathname).toBe("again.jpg")
    expect(record.hash).toBeDefined()
  })

  it("creates, lists, moves, and removes folders", async () => {
    ok(await storage.media.createFolder("albums/empty/"))
    await storage.media.put("albums/summer/a.jpg", await photo(10, 10))
    await storage.media.put("albums/summer/nested/b.jpg", await photo(10, 10))
    await storage.media.put("albums/cover.jpg", await photo(10, 10))

    const root = ok(await storage.media.list())
    expect(root.folders).toEqual(["albums/"])
    const albums = ok(await storage.media.list({ prefix: "albums/" }))
    expect(albums.folders).toEqual(["albums/empty/", "albums/summer/"])
    expect(albums.items.map(item => item.pathname)).toEqual(["albums/cover.jpg"])
    expect(ok(await storage.media.list({ prefix: "albums/empty/" })).items).toEqual([])

    const [notEmpty] = await storage.media.removeFolder("albums/summer")
    expect(notEmpty?.code).toBe("BLOB_CONFLICT")
    const [into] = await storage.media.moveFolder("albums", "albums/summer/x").catch(error => [error] as const)
    expect(String(into)).toContain("into itself")
    const [occupied] = await storage.media.moveFolder("albums/summer", "albums")
    expect(occupied?.code).toBe("BLOB_CONFLICT")

    expect(ok(await storage.media.moveFolder("albums/summer", "archive/2026"))).toEqual({ moved: 2 })
    expect(ok(await storage.media.get("archive/2026/nested/b.jpg"))).toMatchObject({ width: 10 })
    expect(ok(await storage.media.list({ prefix: "albums/" })).folders).toEqual(["albums/empty/"])

    expect(ok(await storage.media.removeFolder("albums/empty"))).toEqual({ removed: 0 })
    expect(ok(await storage.media.removeFolder("archive", { force: true }))).toEqual({ removed: 2 })
    expect(ok(await storage.list({ prefix: "archive/" })).blobs).toEqual([])
    expect(ok(await storage.list({ prefix: "_vitehub/media/records/archive/" })).blobs).toEqual([])
  })
})

describe("image variants on the fs driver", () => {
  let directory: string
  let storage: BlobStorage
  let transformer: ReturnType<typeof recordingTransformer>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-variants-"))
    transformer = recordingTransformer()
    storage = createBlobStorage(createDriver({ base: directory, driver: "fs" }), "default", { images: transformer })
    await storage.media.put("photo.jpg", await photo(2000, 1000), { focal: { x: 0.9, y: 0.5 } })
    transformer.operations.length = 0
  })

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  it("serves a resized WebP, caches it, and answers revalidation without transforming", async () => {
    const first = request()
    const [error, body] = await storage.serve(first, "photo.jpg", { variant: { width: 640 } })
    expect(error).toBeNull()
    const bytes = new Uint8Array(await new Response(body).arrayBuffer())
    expect(first.res.headers.get("content-type")).toBe("image/webp")
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "webp", height: 320, width: 640 })
    await storage.serve(request(), "photo.jpg", { variant: { width: 640 } })
    expect(transformer.operations).toHaveLength(1)
    const conditional = request(undefined, { "if-none-match": first.res.headers.get("etag")! })
    expect(await storage.serve(conditional, "photo.jpg", { variant: { width: 640 } })).toEqual([null, null])
    const [variant] = ok(await storage.media.variants("photo.jpg"))
    expect(variant).toMatchObject({ contentType: "image/webp", key: "image:v1;src=original;out=640x320;fmt=webp;q=75;engine=recording", size: bytes.byteLength, source: "photo.jpg" })
  })

  it("snaps and caps sizes, so arbitrary widths share one cache entry", async () => {
    await storage.serve(request(), "photo.jpg", { variant: { width: 641 } })
    await storage.serve(request(), "photo.jpg", { variant: { width: 700 } })
    await storage.serve(request(), "photo.jpg", { variant: { width: 9000 } })
    await storage.serve(request(), "photo.jpg", { variant: { width: 3000 } })
    expect(transformer.operations.map(operation => [operation.width, operation.height])).toEqual([[750, 375], [2000, 1000]])
    expect(ok(await storage.media.variants("photo.jpg"))).toHaveLength(2)
  })

  it("crops cover variants around the focal point and changes the ETag when the focal point moves", async () => {
    const first = request()
    await storage.serve(first, "photo.jpg", { variant: { height: 256, width: 256 } })
    expect(transformer.operations[0]).toEqual({ extract: { height: 1000, left: 1000, top: 0, width: 1000 }, format: "webp", height: 256, quality: 75, width: 256 })
    await storage.media.update("photo.jpg", { focal: { x: 0, y: 0.5 } })
    expect(ok(await storage.media.variants("photo.jpg"))).toEqual([])
    const second = request()
    await storage.serve(second, "photo.jpg", { variant: { height: 256, width: 256 } })
    expect(transformer.operations[1]!.extract).toEqual({ height: 1000, left: 0, top: 0, width: 1000 })
    expect(second.res.headers.get("etag")).not.toBe(first.res.headers.get("etag"))
  })

  it("serves named crops from the focal point, then from an uploaded replacement", async () => {
    await storage.media.update("photo.jpg", { crops: { mobile: { aspect: "4:5" } } })
    await storage.serve(request(), "photo.jpg", { variant: { crop: "mobile", width: 640 } })
    expect(transformer.operations.at(-1)).toMatchObject({ extract: { height: 1000, left: 1200, top: 0, width: 800 }, height: 800, width: 640 })

    const record = ok(await storage.media.replaceCrop("photo.jpg", "mobile", await photo(400, 500, { b: 200, g: 0, r: 0 })))
    expect(record.crops!.mobile).toMatchObject({ aspect: "4:5", replacement: { contentType: "image/jpeg", height: 500, width: 400 } })
    const served = request()
    const [, body] = await storage.serve(served, "photo.jpg", { variant: { crop: "mobile", width: 640 } })
    expect(transformer.operations.at(-1)).toEqual({ format: "webp", height: 500, quality: 75, width: 400 })
    const { data } = await sharp(new Uint8Array(await new Response(body).arrayBuffer())).raw().toBuffer({ resolveWithObject: true })
    expect(data[2]).toBeGreaterThan(150)

    const created = ok(await storage.media.replaceCrop("photo.jpg", "story", await photo(90, 160)))
    expect(created.crops!.story!.aspect).toBe("9:16")
    await expect(storage.media.replaceCrop("photo.jpg", "story", "not an image")).rejects.toThrow("JPEG, PNG, WebP, or AVIF")
    const reverted = ok(await storage.media.replaceCrop("photo.jpg", "mobile", null))
    expect(reverted.crops!.mobile).toEqual({ aspect: "4:5" })
    expect(ok(await storage.get(record.crops!.mobile!.replacement!.pathname))).toBeNull()
  })

  it("serves the uncropped image for an unknown crop name", async () => {
    await storage.serve(request(), "photo.jpg", { variant: { crop: "missing", width: 640 } })
    expect(transformer.operations.at(-1)).toEqual({ format: "webp", height: 320, quality: 75, width: 640 })
  })

  it("serves originals for SVG, GIF, and non-image objects", async () => {
    await storage.put("icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"></svg>")
    await storage.put("notes.txt", "hello")
    for (const pathname of ["icon.svg", "notes.txt"]) {
      const event = request()
      const [error, body] = await storage.serve(event, pathname, { variant: { width: 64 } })
      expect(error).toBeNull()
      expect(event.res.headers.get("content-type")).not.toBe("image/webp")
      await new Response(body).arrayBuffer()
    }
    expect(transformer.operations).toEqual([])
  })
})

describe("image transformer selection", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-transformer-"))
  })

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  it("serves the original with passthrough and when images are off", async () => {
    for (const images of [{ transformer: "passthrough" as const }, false as const]) {
      const storage = createBlobStorage(createDriver({ base: directory, driver: "fs" }), "default", { images })
      const bytes = await photo(300, 200)
      const record = ok(await storage.media.put("p.jpg", bytes))
      expect(record).toMatchObject({ height: 200, width: 300 })
      expect(record).not.toHaveProperty("color")
      const event = request()
      const [, body] = await storage.serve(event, "p.jpg", { variant: { format: "webp", width: 64 } })
      expect(event.res.headers.get("content-type")).toBe("image/jpeg")
      expect((await new Response(body).arrayBuffer()).byteLength).toBe(bytes.byteLength)
    }
  })

  it("auto-selects installed sharp on Node and produces a resized WebP", async () => {
    const storage = createBlobStorage(createDriver({ base: directory, driver: "fs" }), "default")
    ok(await storage.media.put("auto.jpg", await photo(1600, 900)))
    const event = request()
    const [, body] = await storage.serve(event, "auto.jpg", { variant: { quality: 60, width: 828 } })
    expect(await sharp(new Uint8Array(await new Response(body).arrayBuffer())).metadata()).toMatchObject({ format: "webp", height: 466, width: 828 })
    expect(ok(await storage.media.variants("auto.jpg"))[0]!.key).toContain("engine=sharp")
  })
})
