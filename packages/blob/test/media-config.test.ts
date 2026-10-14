import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { normalizeBlobOptions } from "../src/config.ts"
import { cloudflareImagesBinding } from "../src/internal/vite-build.ts"
import { responsiveImage } from "../src/media/responsive.ts"
import { hubBlob } from "../src/vite.ts"

describe("blob.images configuration", () => {
  it("is absent unless set, and normalizes sizes", () => {
    expect(normalizeBlobOptions({ driver: "fs" })).not.toHaveProperty("images")
    expect(normalizeBlobOptions({ driver: "fs", images: false })).toMatchObject({ images: false })
    expect(normalizeBlobOptions({ driver: "fs", images: { binding: " PHOTOS ", quality: 80, sizes: [640, 320, 640], transformer: "cloudflare-images" } })).toMatchObject({
      images: { binding: "PHOTOS", quality: 80, sizes: [320, 640], transformer: "cloudflare-images" },
    })
    expect(normalizeBlobOptions({ images: { transformer: "sharp" }, stores: { default: { driver: "fs" } } })).toMatchObject({ images: { transformer: "sharp" } })
  })

  it.each([
    [{ transformer: "imgix" }, "`blob.images.transformer` must be one of"],
    [{ quality: 0 }, "`blob.images.quality` must be an integer from 1 to 100."],
    [{ sizes: [] }, "`blob.images.sizes` must be a non-empty array"],
    [{ sizes: [1.5] }, "`blob.images.sizes` must be a non-empty array"],
    [{ binding: "" }, "`blob.images.binding` must be a non-empty"],
    ["on", "`blob.images` must be false or a plain object."],
  ])("rejects %j", (images, message) => {
    expect(() => normalizeBlobOptions({ driver: "fs", images: images as never })).toThrow(message)
  })

  it("adds a Cloudflare Images binding only for the explicit cloudflare-images transformer", () => {
    const store = { binding: "BLOB", driver: "cloudflare-r2" as const }
    expect(cloudflareImagesBinding({ store })).toBeUndefined()
    expect(cloudflareImagesBinding({ images: { transformer: "auto" }, store })).toBeUndefined()
    expect(cloudflareImagesBinding({ images: { transformer: "cloudflare-images" }, store })).toEqual({ binding: "IMAGES" })
    expect(cloudflareImagesBinding({ images: { binding: "PHOTOS", transformer: "cloudflare-images" }, store })).toEqual({ binding: "PHOTOS" })
  })
})

describe("generated Nitro plugin", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vitehub-blob-sharp-"))
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  async function generatePlugin(options: Parameters<typeof hubBlob>[0]) {
    const plugin = hubBlob(options)
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ build: { outDir: "dist" }, command: "build", plugins: [], root } as never)
    return await readFile(join(root, ".vitehub/nitro/blob/plugin.ts"), "utf8")
  }

  it("imports sharp with a literal specifier when the project installs it", async () => {
    expect(await generatePlugin({ driver: "fs" })).not.toContain("sharp")
    await expect(generatePlugin({ driver: "fs", images: { transformer: "sharp" } })).rejects.toThrow("cannot resolve sharp")
    await mkdir(join(root, "node_modules/sharp"), { recursive: true })
    await writeFile(join(root, "node_modules/sharp/package.json"), "{\"name\":\"sharp\"}")
    const source = await generatePlugin({ driver: "fs" })
    expect(source).toContain("import * as vitehubSharp from 'sharp'")
    expect(source).toContain("setBlobSharpModule(vitehubSharp)")
    expect(await generatePlugin({ driver: "fs", images: { transformer: "passthrough" } })).not.toContain("sharp")
    expect(await generatePlugin({ driver: "fs", images: false })).not.toContain("sharp")
  })

  it("parses variant queries in the serve route and answers invalid ones with 400", async () => {
    await generatePlugin({ driver: "fs", serve: true })
    const route = await readFile(join(root, ".vitehub/blob/serve-route.ts"), "utf8")
    expect(route).toContain("import { blob, parseImageVariant } from '@vite-hub/blob'")
    expect(route).toContain("const variant = parseImageVariant(getQuery(event))")
    expect(route).toContain("statusCode: 400")
    expect(route).toContain("blob.store(storeName).serve(event, pathname, options)")
  })
})

describe("responsiveImage", () => {
  const record = {
    alt: "Mountains at dawn",
    color: "#336699",
    contentType: "image/jpeg",
    crops: { mobile: { aspect: "4:5" }, story: { aspect: "9:16", replacement: { height: 1920, width: 1080 } } },
    focal: { x: 0.7, y: 0.4 },
    height: 1500,
    url: "/api/_vitehub/blob/hero.jpg",
    width: 2400,
  }

  it("builds a srcset that stops at the source width, with intrinsic size and focal styles", () => {
    const image = responsiveImage(record, { sizes: "(min-width: 1024px) 50vw, 100vw" })
    expect(image.sources).toEqual([])
    expect(image.img).toEqual({
      alt: "Mountains at dawn",
      decoding: "async",
      height: 1500,
      loading: "lazy",
      sizes: "(min-width: 1024px) 50vw, 100vw",
      src: "/api/_vitehub/blob/hero.jpg?w=1080&fmt=webp",
      srcset: [640, 750, 828, 1080, 1200, 1920, 2048, 2400].map(width => `/api/_vitehub/blob/hero.jpg?w=${width}&fmt=webp ${width}w`).join(", "),
      style: "object-position: 70% 40%; background-color: #336699",
      width: 2400,
    })
  })

  it("adds art-direction sources from named crops and replacements", () => {
    const image = responsiveImage(record, {
      art: [{ crop: "story", media: "(max-width: 480px)" }, { crop: "mobile", media: "(max-width: 768px)", sizes: "100vw" }, { crop: "missing", media: "print" }],
      fetchpriority: "high",
      format: "avif",
      loading: "eager",
      quality: 60,
      widths: [640, 1080],
    })
    expect(image.sources).toEqual([
      { height: 1920, media: "(max-width: 480px)", sizes: "100vw", srcset: "/api/_vitehub/blob/hero.jpg?w=640&fmt=avif&q=60&crop=story 640w, /api/_vitehub/blob/hero.jpg?w=1080&fmt=avif&q=60&crop=story 1080w", type: "image/avif", width: 1080 },
      { height: 1500, media: "(max-width: 768px)", sizes: "100vw", srcset: "/api/_vitehub/blob/hero.jpg?w=640&fmt=avif&q=60&crop=mobile 640w, /api/_vitehub/blob/hero.jpg?w=1080&fmt=avif&q=60&crop=mobile 1080w, /api/_vitehub/blob/hero.jpg?w=1200&fmt=avif&q=60&crop=mobile 1200w", type: "image/avif", width: 1200 },
    ])
    expect(image.img).toMatchObject({ fetchpriority: "high", loading: "eager", src: "/api/_vitehub/blob/hero.jpg?w=1080&fmt=avif&q=60" })
  })

  it("keeps GIF and SVG originals and requires a URL", () => {
    expect(responsiveImage({ contentType: "image/svg+xml", height: 10, url: "/logo.svg", width: 20 }, { alt: "Logo" })).toEqual({
      img: { alt: "Logo", decoding: "async", height: 10, loading: "lazy", src: "/logo.svg", width: 20 },
      sources: [],
    })
    expect(() => responsiveImage({ width: 10 })).toThrow("needs the served URL")
    expect(responsiveImage({}, { url: "/x.jpg", widths: [320] }).img.srcset).toBe("/x.jpg?w=320&fmt=webp 320w")
  })
})
