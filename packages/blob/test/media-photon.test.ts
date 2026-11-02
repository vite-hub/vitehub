import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as photon from "@cf-wasm/photon"
import { H3Event } from "h3"
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"
import { createPhotonImageTransformer } from "../src/media/photon.ts"
import { jpegOrientation, probeImage } from "../src/media/probe.ts"
import { setBlobPhotonLoader } from "../src/runtime/state.ts"
import { createBlobStorage } from "../src/storage.ts"
import type { BlobImageOperation } from "../src/media/types.ts"
import type { BlobResult } from "../src/types.ts"

const fixture = (name: string) => readFile(new URL(`./fixtures/photon/${name}`, import.meta.url))
const transformer = createPhotonImageTransformer()

function ok<TResult>(result: BlobResult<TResult>): TResult {
  expect(result[0]).toBeNull()
  return result[1] as TResult
}

async function transform(bytes: Uint8Array, operation: BlobImageOperation) {
  const output = await transformer.transform(new Blob([new Uint8Array(bytes)]), operation)
  return { output, bytes: new Uint8Array(await output.arrayBuffer()) }
}

/** RGBA at fractions of the width and height. The defaults are the centers of the quadrants. */
async function colors(bytes: Uint8Array, reference?: (image: ReturnType<typeof sharp>) => ReturnType<typeof sharp>, at = [0.25, 0.75]) {
  const { data, info } = await (reference ?? (image => image))(sharp(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return at.flatMap(y => at.map((x) => {
    const offset = (Math.floor(info.height * y) * info.width + Math.floor(info.width * x)) * 4
    return [...data.subarray(offset, offset + 4)]
  }))
}

const palette = { blue: [0, 0, 255], green: [0, 255, 0], red: [255, 0, 0], yellow: [255, 255, 0] }

/** Names the nearest fixture color of each sample, so a failure shows which quadrant moved. */
function names(samples: number[][]) {
  return samples.map(sample => Object.entries(palette)
    .map(([name, rgb]) => ({ distance: rgb.reduce((sum, channel, index) => sum + (channel - sample[index]!) ** 2, 0), name }))
    .sort((left, right) => left.distance - right.distance)[0]!.name)
}

function expectColors(actual: number[][], expected: number[][]) {
  expect(names(actual)).toEqual(names(expected))
}

describe("photon image transformer", () => {
  it.each([false, true])("turns a JPEG with EXIF orientation 6 upright and drops its metadata (later XMP: %s)", async (laterXmp) => {
    let source = await fixture("orientation-6.jpg")
    if (laterXmp) {
      const exifStart = source.indexOf(Buffer.from("Exif\0\0")) - 4
      const afterExif = exifStart + 2 + source.readUInt16BE(exifStart + 2)
      const xmp = Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"/>")
      const header = Buffer.from([0xFF, 0xE1, 0, 0])
      header.writeUInt16BE(xmp.length + 2, 2)
      source = Buffer.concat([source.subarray(0, afterExif), header, xmp, source.subarray(afterExif)])
    }
    expect(await sharp(source).metadata()).toMatchObject({ height: 32, orientation: 6, width: 48 })
    expect(jpegOrientation(source)).toBe(6)
    expect(probeImage(source)).toMatchObject({ format: "jpeg", height: 48, width: 32 })

    const { output, bytes } = await transform(source, { format: "jpeg", height: 48, quality: 90, width: 32 })
    expect(output.type).toBe("image/jpeg")
    const metadata = await sharp(bytes).metadata()
    expect(metadata).toMatchObject({ format: "jpeg", height: 48, width: 32 })
    expect(metadata.orientation).toBeUndefined()
    expect(metadata.exif).toBeUndefined()
    expect(Buffer.from(bytes).includes("vitehub-fixture")).toBe(false)
    expectColors(await colors(bytes), await colors(source, image => image.rotate()))
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("cuts a region of the displayed image with EXIF orientation %i", async (orientation) => {
    const source = await sharp(await fixture("quadrants.webp")).resize(96, 64).jpeg({ quality: 95 }).withMetadata({ orientation }).toBuffer()
    const display = orientation >= 5 ? { height: 96, width: 64 } : { height: 64, width: 96 }
    // The region is off center on both axes, so a mirrored or swapped mapping moves a color boundary across a sample.
    const extract = { height: display.height / 2, left: display.width * 3 / 16, top: display.height * 3 / 16, width: display.width / 2 }
    const size = { height: extract.height / 2, width: extract.width / 2 }
    const { bytes } = await transform(source, { extract, format: "png", ...size })
    expect(await sharp(bytes).metadata()).toMatchObject(size)
    const at = [0.2, 0.5, 0.8]
    expectColors(await colors(bytes, undefined, at), await colors(source, image => image.rotate().extract(extract).resize({ ...size, fit: "fill" }), at))
  })

  it("keeps PNG transparency and writes the exact size in every format", async () => {
    const source = await fixture("alpha.png")
    for (const format of ["png", "webp", "jpeg"] as const) {
      const { output, bytes } = await transform(source, { format, height: 15, width: 20 })
      expect(output.type).toBe(`image/${format}`)
      const metadata = await sharp(bytes).metadata()
      expect(metadata).toMatchObject({ format, height: 15, width: 20 })
      if (format !== "jpeg") expect((await colors(bytes))[0]![3]).toBeLessThan(200)
    }
  })

  it("reads WebP, drops its EXIF, and applies the JPEG quality", async () => {
    const source = await fixture("quadrants.webp")
    const low = await transform(source, { format: "jpeg", height: 30, quality: 10, width: 40 })
    const high = await transform(source, { format: "jpeg", height: 30, quality: 100, width: 40 })
    expect(low.bytes.byteLength).toBeLessThan(high.bytes.byteLength)
    expect(Buffer.from(high.bytes).includes("vitehub-fixture")).toBe(false)
    expectColors(await colors(high.bytes), [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]])
  })

  it("rejects AVIF output, unreadable files, and sources over the limits with BLOB_R0036", async () => {
    const jpeg = await fixture("orientation-6.jpg")
    const operation: BlobImageOperation = { format: "webp", height: 16, width: 16 }
    const rejects = (input: Blob, value: BlobImageOperation, message: string) =>
      expect(transformer.transform(input, value)).rejects.toMatchObject({ code: "BLOB_R0036", message: expect.stringContaining(message) })

    await rejects(new Blob([jpeg]), { ...operation, format: "avif" }, "cannot write AVIF")
    await rejects(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), operation, "up to 10485760 bytes")
    await rejects(new Blob([new Uint8Array(await sharp(jpeg).avif().toBuffer())]), operation, "not AVIF")
    await rejects(new Blob(["not an image"]), operation, "cannot read the image size")
    // Only the PNG header, which declares 2500 × 1601 pixels. The transformer rejects it before decoding.
    const header = await sharp({ create: { background: "#000", channels: 3, height: 1601, width: 2500 } }).png().toBuffer()
    await rejects(new Blob([new Uint8Array(header.subarray(0, 64))]), operation, "up to 4000000 pixels. This image is 2500 × 1601")
    await rejects(new Blob([new Uint8Array(jpeg.subarray(0, jpeg.length - 100))]), operation, "cannot decode the image")
  })

  it("frees WebAssembly memory after each variant and after a failed decode", async () => {
    const { memory } = await photon.initPhoton.ensure()
    const source = await sharp({ create: { background: "#4a7", channels: 3, height: 1000, width: 1500 } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const operation: BlobImageOperation = { extract: { height: 1200, left: 100, top: 100, width: 800 }, format: "webp", height: 384, width: 256 }
    const truncated = new Blob([new Uint8Array(source.subarray(0, 2000))])
    await transform(source, operation)
    await expect(transformer.transform(truncated, operation)).rejects.toMatchObject({ code: "BLOB_R0036" })
    const pages = memory.buffer.byteLength
    // Each leaked image would hold at least 6 MB, more than WebAssembly memory has free.
    for (let index = 0; index < 4; index++) {
      await transform(source, operation)
      await expect(transformer.transform(truncated, operation)).rejects.toMatchObject({ code: "BLOB_R0036" })
    }
    expect(memory.buffer.byteLength).toBe(pages)
  })
})

describe("registered Photon loader", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.blob.photon"))
  })

  it("loads Photon on the first variant and reports a load failure with its cause", async () => {
    const source = new Blob([new Uint8Array(await fixture("orientation-6.jpg"))])
    const operation: BlobImageOperation = { format: "jpeg", height: 24, width: 16 }
    let loads = 0
    setBlobPhotonLoader(async () => {
      loads++
      return photon
    })
    const lazy = createPhotonImageTransformer()
    expect(loads).toBe(0)
    expect((await lazy.transform(source, operation)).type).toBe("image/jpeg")
    expect(loads).toBe(1)

    // workerd throws this when code compiles WebAssembly at runtime, as in Cloudflare dev emulation.
    const compileError = new Error("WebAssembly.Module(): Wasm code generation disallowed by embedder")
    setBlobPhotonLoader(() => Promise.reject(compileError))
    await expect(lazy.transform(source, operation)).rejects.toMatchObject({
      cause: compileError,
      code: "BLOB_R0034",
      message: expect.stringContaining("cannot load @cf-wasm/photon: WebAssembly.Module(): Wasm code generation disallowed"),
    })
  })
})

describe("photon transformer in Blob storage", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-photon-"))
  })

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  it("serves upright variants and records their engine when blob.images.transformer is photon", async () => {
    const storage = createBlobStorage(createDriver({ base: directory, driver: "fs" }), "default", { images: { transformer: "photon" } })
    const record = ok(await storage.media.put("meals/lunch.jpg", await fixture("orientation-6.jpg")))
    expect(record).toMatchObject({ color: expect.stringMatching(/^#[0-9a-f]{6}$/), height: 48, width: 32 })

    const event = new H3Event(new Request("https://example.test/meals/lunch.jpg"))
    const [error, body] = await storage.serve(event, "meals/lunch.jpg", { variant: { format: "jpeg", width: 16 } })
    expect(error).toBeNull()
    expect(event.res.headers.get("content-type")).toBe("image/jpeg")
    expect(await sharp(new Uint8Array(await new Response(body).arrayBuffer())).metadata()).toMatchObject({ format: "jpeg", height: 24, width: 16 })
    expect(ok(await storage.media.variants("meals/lunch.jpg"))[0]!.key).toContain("engine=photon")
  })
})
