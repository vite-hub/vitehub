import sharp from "sharp"
import { describe, expect, it } from "vitest"

import { readFirstPngPixel } from "../src/media/color.ts"
import { probeImage } from "../src/media/probe.ts"
import { focalCropRegion, imageVariantUrl, parseAspectRatio, parseImageVariant, resolveImageGeometry, snapImageSize } from "../src/media/variant.ts"

function raster(width: number, height: number) {
  return sharp({ create: { background: { alpha: 1, b: 40, g: 120, r: 200 }, channels: 4, height, width } })
}

describe("probeImage", () => {
  it.each([
    ["png", () => raster(31, 17).png().toBuffer()],
    ["jpeg", () => raster(31, 17).jpeg().toBuffer()],
    ["gif", () => raster(31, 17).gif().toBuffer()],
    ["webp", () => raster(31, 17).webp().toBuffer()],
    ["webp", () => raster(31, 17).webp({ lossless: true }).toBuffer()],
    ["avif", () => raster(31, 17).avif().toBuffer()],
  ] as const)("reads %s dimensions from the header", async (format, encode) => {
    const probe = probeImage(new Uint8Array(await encode()))
    expect(probe).toMatchObject({ format, height: 17, width: 31 })
  })

  it("reads the canvas of an extended WebP with alpha", async () => {
    const bytes = await sharp({ create: { background: { alpha: 0.5, b: 0, g: 0, r: 0 }, channels: 4, height: 300, width: 500 } }).webp({ alphaQuality: 50 }).toBuffer()
    expect(probeImage(bytes)).toMatchObject({ format: "webp", height: 300, width: 500 })
  })

  it("swaps JPEG dimensions for rotated EXIF orientations", async () => {
    const bytes = await raster(40, 10).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    expect(probeImage(bytes)).toMatchObject({ format: "jpeg", height: 40, width: 10 })
    const upright = await raster(40, 10).jpeg().withMetadata({ orientation: 3 }).toBuffer()
    expect(probeImage(upright)).toMatchObject({ height: 10, width: 40 })
  })

  it.each([
    ["<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"80px\"></svg>", { height: 80, width: 120 }],
    ["<?xml version=\"1.0\"?>\n<svg viewBox=\"0 0 300 150\"></svg>", { height: 150, width: 300 }],
    ["<svg width='600' viewBox='0, 0, 300, 150'></svg>", { height: 300, width: 600 }],
  ])("reads SVG size from attributes or the viewBox: %s", (source, size) => {
    expect(probeImage(new TextEncoder().encode(source))).toMatchObject({ contentType: "image/svg+xml", format: "svg", ...size })
  })

  it("returns undefined for other files and truncated headers", async () => {
    expect(probeImage(new TextEncoder().encode("%PDF-1.7"))).toBeUndefined()
    expect(probeImage(new TextEncoder().encode("<svg>"))).toBeUndefined()
    expect(probeImage((await raster(4, 4).png().toBuffer()).subarray(0, 20))).toBeUndefined()
    expect(probeImage(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00]))).toBeUndefined()
  })
})

describe("readFirstPngPixel", () => {
  it.each([
    ["rgb", () => raster(1, 1).removeAlpha().png().toBuffer()],
    ["rgba", () => raster(1, 1).png().toBuffer()],
    ["palette", () => raster(1, 1).png({ palette: true }).toBuffer()],
  ])("reads an %s pixel", async (_name, encode) => {
    expect(await readFirstPngPixel(new Uint8Array(await encode()))).toBe("#c87828")
  })
})

describe("image variants", () => {
  it("parses serve route queries and ignores other parameters", () => {
    expect(parseImageVariant(new URLSearchParams("v=3"))).toBeUndefined()
    expect(parseImageVariant(new URLSearchParams("w=640&h=480&fit=cover&fmt=avif&q=60&crop=mobile"))).toEqual({
      crop: "mobile", fit: "cover", format: "avif", height: 480, quality: 60, width: 640,
    })
    expect(parseImageVariant({ w: ["320", "640"] })).toEqual({ width: 320 })
  })

  it.each([
    ["w=0", "`w` must be from 1"],
    ["w=1e3", "`w` must be a positive integer"],
    ["w=-1", "`w` must be a positive integer"],
    ["q=101", "`q` must be from 1 to 100"],
    ["fit=fill", "`fit` must be cover or inside"],
    ["fmt=bmp", "`fmt` must be one of"],
    ["crop=../x", "`crop` must be a crop name"],
  ])("rejects %s", (query, message) => {
    expect(() => parseImageVariant(new URLSearchParams(query))).toThrow(message)
  })

  it("builds canonical variant URLs that keep other parameters", () => {
    expect(imageVariantUrl("/api/_vitehub/blob/a%20b.jpg?v=2&w=1#top", { crop: "mobile", format: "webp", quality: 70, width: 640 }))
      .toBe("/api/_vitehub/blob/a%20b.jpg?v=2&w=640&fmt=webp&q=70&crop=mobile#top")
  })

  it("snaps sizes up to the allowed list and caps at the largest", () => {
    expect(snapImageSize(641)).toBe(750)
    expect(snapImageSize(1)).toBe(16)
    expect(snapImageSize(99_999)).toBe(3840)
    expect(snapImageSize(500, [100, 200])).toBe(200)
  })

  it("parses aspect ratios", () => {
    expect(parseAspectRatio("4:5")).toBe(0.8)
    expect(parseAspectRatio("16/9")).toBeCloseTo(1.7778)
    expect(parseAspectRatio("1.91:1")).toBe(1.91)
    expect(parseAspectRatio("0:1")).toBeUndefined()
    expect(parseAspectRatio("wide")).toBeUndefined()
  })

  it("centers crop regions on the focal point within the image edges", () => {
    const source = { height: 1000, width: 2000 }
    expect(focalCropRegion(source, 1, { x: 0.5, y: 0.5 })).toEqual({ height: 1000, left: 500, top: 0, width: 1000 })
    expect(focalCropRegion(source, 1, { x: 0.9, y: 0.1 })).toEqual({ height: 1000, left: 1000, top: 0, width: 1000 })
    expect(focalCropRegion(source, 1, { x: 0.1, y: 0.9 })).toEqual({ height: 1000, left: 0, top: 0, width: 1000 })
    expect(focalCropRegion(source, 4, { x: 0.5, y: 0.8 })).toEqual({ height: 500, left: 0, top: 500, width: 2000 })
  })

  it("resolves inside and cover geometry without upscaling", () => {
    const source = { height: 1000, width: 2000 }
    expect(resolveImageGeometry({ source, variant: { width: 640 } })).toEqual({ height: 320, width: 640 })
    expect(resolveImageGeometry({ source, variant: { width: 5000 } })).toEqual({ height: 1000, width: 2000 })
    expect(resolveImageGeometry({ source, variant: { height: 100 } })).toEqual({ height: 128, width: 256 })
    expect(resolveImageGeometry({ focal: { x: 1, y: 0.5 }, source, variant: { height: 256, width: 256 } })).toEqual({
      extract: { height: 1000, left: 1000, top: 0, width: 1000 }, height: 256, width: 256,
    })
    expect(resolveImageGeometry({ aspect: 0.8, source, variant: { width: 640 } })).toEqual({
      extract: { height: 1000, left: 600, top: 0, width: 800 }, height: 800, width: 640,
    })
    expect(resolveImageGeometry({ aspect: 2, source, variant: {} })).toEqual({ height: 1000, width: 2000 })
  })
})
