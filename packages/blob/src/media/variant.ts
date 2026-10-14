// Image variant requests and geometry. Pure: shared by the serve route, the server, and browser helpers.

/** Output formats an image transformer produces. */
export type BlobImageFormat = "avif" | "jpeg" | "png" | "webp"

/**
 * How a variant fills its box. `inside` scales the image to fit within the width and height. `cover` fills the box
 * and crops around the focal point.
 */
export type BlobImageFit = "cover" | "inside"

/** A point in an image, from 0 to 1 on each axis. `{ x: 0.5, y: 0.5 }` is the center. */
export interface MediaFocalPoint {
  x: number
  y: number
}

/** One requested image variant. The serve route reads it from `?w=&h=&fit=&fmt=&q=&crop=`. */
export interface BlobImageVariant {
  /** Named crop of the media record, such as `"mobile"`. Unknown names serve the uncropped image. */
  crop?: string
  /** Defaults to `cover` when both `width` and `height` are set, otherwise `inside`. */
  fit?: BlobImageFit
  /** Defaults to `webp`. */
  format?: BlobImageFormat
  /** Snaps up to the nearest allowed size. */
  height?: number
  /** 1 to 100. Defaults to the configured quality, 75 unless set. */
  quality?: number
  /** Snaps up to the nearest allowed size. */
  width?: number
}

/** The region to cut from the source and the exact output size. Transformers apply it as given. */
export interface BlobImageOperation {
  /** Region of the source, in source pixels after EXIF rotation. */
  extract?: { height: number, left: number, top: number, width: number }
  format: BlobImageFormat
  height: number
  quality?: number
  width: number
}

/** Sizes that variant widths and heights snap to. A request cannot create a variant at any other size. */
export const defaultImageSizes: readonly number[] = Object.freeze([16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840])
/** Widths that `responsiveImage()` offers in a `srcset` by default. */
export const defaultResponsiveWidths: readonly number[] = Object.freeze([640, 750, 828, 1080, 1200, 1920, 2048, 3840])
export const defaultImageQuality = 75
export const imageFormats: readonly BlobImageFormat[] = Object.freeze(["avif", "jpeg", "png", "webp"])
const cropNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const integerPattern = /^\d{1,5}$/
const aspectPattern = /^(\d{1,5}(?:\.\d{1,4})?)\s*[:/x]\s*(\d{1,5}(?:\.\d{1,4})?)$/

/** Whether `name` can name a crop: letters, digits, `_`, and `-`, starting with a letter or digit, at most 64 characters. */
export function isMediaCropName(name: string): boolean {
  return cropNamePattern.test(name)
}

/** Parses an aspect ratio such as `"4:5"`, `"16/9"`, or `"1.91:1"` to width divided by height. */
export function parseAspectRatio(aspect: string): number | undefined {
  const match = aspectPattern.exec(aspect.trim())
  if (!match) return undefined
  const ratio = Number(match[1]) / Number(match[2])
  return Number.isFinite(ratio) && ratio >= 0.01 && ratio <= 100 ? ratio : undefined
}

function isUnitInterval(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
}

export function isMediaFocalPoint(value: unknown): value is MediaFocalPoint {
  if (Object(value) !== value) return false
  return isUnitInterval(Reflect.get(Object(value), "x")) && isUnitInterval(Reflect.get(Object(value), "y"))
}

function isFit(value: string): value is BlobImageFit {
  return value === "cover" || value === "inside"
}

function isFormat(value: string): value is BlobImageFormat {
  return value === "avif" || value === "jpeg" || value === "png" || value === "webp"
}

/** CSS `object-position` for a focal point, such as `"50% 30%"`. Pair it with `object-fit: cover`. */
export function focalPointToObjectPosition(focal: MediaFocalPoint | undefined): string | undefined {
  if (!isMediaFocalPoint(focal)) return undefined
  return `${Math.round(focal.x * 10_000) / 100}% ${Math.round(focal.y * 10_000) / 100}%`
}

/** Snaps a dimension up to the nearest allowed size, or down to the largest. */
export function snapImageSize(value: number, sizes: readonly number[] = defaultImageSizes): number {
  const sorted = [...sizes].sort((left, right) => left - right)
  return sorted.find(size => size >= value) ?? sorted.at(-1) ?? value
}

function readQuery(query: URLSearchParams | Record<string, unknown>, name: string): string | undefined {
  if (query instanceof URLSearchParams) return query.get(name) ?? undefined
  const value = query[name]
  const first = Array.isArray(value) ? value[0] : value
  return first === undefined || first === null ? undefined : String(first)
}

function readInteger(name: string, value: string | undefined, max: number): number | undefined {
  if (value === undefined || value === "") return undefined
  if (!integerPattern.test(value)) throw new TypeError(`Image variant \`${name}\` must be a positive integer.`)
  const number = Number(value)
  if (number < 1 || number > max) throw new TypeError(`Image variant \`${name}\` must be from 1 to ${max}.`)
  return number
}

/**
 * Reads an image variant from serve route query parameters: `w`, `h`, `fit`, `fmt`, `q`, and `crop`.
 * Returns `undefined` when none are present. Throws a `TypeError` for invalid values. Other parameters are ignored.
 */
export function parseImageVariant(query: URLSearchParams | Record<string, unknown>): BlobImageVariant | undefined {
  const variant: BlobImageVariant = {}
  const width = readInteger("w", readQuery(query, "w"), 10_000)
  const height = readInteger("h", readQuery(query, "h"), 10_000)
  const quality = readInteger("q", readQuery(query, "q"), 100)
  const fit = readQuery(query, "fit")
  const format = readQuery(query, "fmt")
  const crop = readQuery(query, "crop")
  if (width !== undefined) variant.width = width
  if (height !== undefined) variant.height = height
  if (quality !== undefined) variant.quality = quality
  if (fit) {
    if (!isFit(fit)) throw new TypeError("Image variant `fit` must be cover or inside.")
    variant.fit = fit
  }
  if (format) {
    if (!isFormat(format)) throw new TypeError(`Image variant \`fmt\` must be one of ${imageFormats.join(", ")}.`)
    variant.format = format
  }
  if (crop) {
    if (!isMediaCropName(crop)) throw new TypeError("Image variant `crop` must be a crop name.")
    variant.crop = crop
  }
  return Object.keys(variant).length ? variant : undefined
}

/** Adds variant query parameters to a served Blob URL. Parameters keep a fixed order, so equal variants share one URL. */
export function imageVariantUrl(url: string, variant: BlobImageVariant): string {
  const hashIndex = url.indexOf("#")
  const base = hashIndex < 0 ? url : url.slice(0, hashIndex)
  const hash = hashIndex < 0 ? "" : url.slice(hashIndex + 1)
  const queryIndex = base.indexOf("?")
  const path = queryIndex < 0 ? base : base.slice(0, queryIndex)
  const search = queryIndex < 0 ? "" : base.slice(queryIndex + 1)
  const params = new URLSearchParams(search)
  for (const name of ["w", "h", "fit", "fmt", "q", "crop"]) params.delete(name)
  if (variant.width !== undefined) params.set("w", String(variant.width))
  if (variant.height !== undefined) params.set("h", String(variant.height))
  if (variant.fit) params.set("fit", variant.fit)
  if (variant.format) params.set("fmt", variant.format)
  if (variant.quality !== undefined) params.set("q", String(variant.quality))
  if (variant.crop) params.set("crop", variant.crop)
  const query = params.toString()
  return `${path}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** The largest region with `aspect` that fits in the source, centered on the focal point as far as the edges allow. */
export function focalCropRegion(source: { height: number, width: number }, aspect: number, focal: MediaFocalPoint = { x: 0.5, y: 0.5 }): NonNullable<BlobImageOperation["extract"]> {
  const width = Math.max(1, Math.min(source.width, Math.round(source.height * aspect)))
  const height = Math.max(1, Math.min(source.height, Math.round(width / aspect)))
  return {
    height,
    left: clamp(Math.round(focal.x * source.width - width / 2), 0, source.width - width),
    top: clamp(Math.round(focal.y * source.height - height / 2), 0, source.height - height),
    width,
  }
}

export interface ImageGeometryInput {
  /** Aspect ratio of a named crop, as width divided by height. */
  aspect?: number
  focal?: MediaFocalPoint
  sizes?: readonly number[]
  source: { height: number, width: number }
  variant: BlobImageVariant
}

/**
 * Resolves a variant request to a source region and an exact output size. Widths and heights snap to `sizes`,
 * and the output never upscales the source region.
 */
export function resolveImageGeometry(input: ImageGeometryInput): Pick<BlobImageOperation, "extract" | "height" | "width"> {
  const { source, variant } = input
  const sizes = input.sizes ?? defaultImageSizes
  const width = variant.width === undefined ? undefined : snapImageSize(variant.width, sizes)
  const height = variant.height === undefined ? undefined : snapImageSize(variant.height, sizes)
  const fit = variant.fit ?? (width && height ? "cover" : "inside")
  const aspect = input.aspect ?? (fit === "cover" && width && height ? width / height : undefined)
  if (aspect !== undefined) {
    const region = focalCropRegion(source, aspect, input.focal)
    let outputWidth = region.width
    if (width !== undefined) outputWidth = Math.min(width, region.width)
    else if (height !== undefined) outputWidth = Math.min(region.width, Math.round(height * aspect))
    const outputHeight = Math.max(1, Math.round(outputWidth / aspect))
    const whole = region.left === 0 && region.top === 0 && region.width === source.width && region.height === source.height
    return { ...(whole ? {} : { extract: region }), height: Math.min(outputHeight, region.height), width: Math.max(1, outputWidth) }
  }
  const scale = Math.min(1, width ? width / source.width : 1, height ? height / source.height : 1)
  return {
    height: Math.max(1, Math.round(source.height * scale)),
    width: Math.max(1, Math.round(source.width * scale)),
  }
}
