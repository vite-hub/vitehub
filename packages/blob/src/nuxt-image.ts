// A `@nuxt/image` provider for the served Blob route. It does not import `@nuxt/image`: Nuxt Image calls the default
// export to get a provider object, so the contract is plain data. Browser safe, because Nuxt Image runs it on both sides.
import { defaultImageSizes, imageVariantUrl, snapImageSize } from "./media/variant.ts"
import { DEFAULT_BLOB_SERVE_ROUTE } from "./served.ts"

import type { BlobImageFit, BlobImageFormat, BlobImageVariant } from "./media/variant.ts"

/** Options of the `vitehub` provider, from `image.providers.vitehub.options` in `nuxt.config.ts`. */
export interface BlobImageProviderOptions {
  /** The `blob.serve` route, or a public URL of it. Defaults to `/api/_vitehub/blob`. */
  baseURL?: string
  /** Sizes that widths and heights snap to. Use the same list as `blob.images.sizes`. */
  imageSizes?: readonly number[]
}

/** The Nuxt Image modifiers that the provider reads. `crop` names a crop of the media record. */
export interface BlobImageModifiers {
  crop?: string
  fit?: string
  format?: string
  height?: number | string
  quality?: number | string
  width?: number | string
}

export interface BlobImageProvider {
  getImage: (src: string, options: BlobImageProviderOptions & { modifiers?: BlobImageModifiers }) => { url: string }
}

// Nuxt Image fit names. `contain` letterboxes there; the served route has no padding, so it scales to fit instead.
const fits = new Map<string, BlobImageFit>([["contain", "inside"], ["cover", "cover"], ["inside", "inside"]])
const formats = new Map<string, BlobImageFormat>([["avif", "avif"], ["jpeg", "jpeg"], ["jpg", "jpeg"], ["png", "png"], ["webp", "webp"]])

function positiveInteger(value: number | string | undefined): number | undefined {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number >= 1 ? number : undefined
}

function encodeSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment))
  }
  catch {
    return encodeURIComponent(segment)
  }
}

function sourceUrl(src: string, baseURL: string): string {
  // A served URL, such as the `url` of a media record, is used as it is.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(src) || src.startsWith(`${baseURL}/`)) return src
  // Nuxt Image adds a leading slash. Blob pathnames have none.
  const pathname = src.replace(/^\/+/, "").split("/").map(encodeSegment).join("/")
  return `${baseURL}/${pathname}`
}

/**
 * Maps Nuxt Image modifiers to the served Blob variant parameters. Widths and heights snap to the allowed sizes here,
 * as the server does, so equal variants share one URL and one CDN cache entry.
 */
function getImage(src: string, { baseURL = DEFAULT_BLOB_SERVE_ROUTE, imageSizes = defaultImageSizes, modifiers = {} }: Parameters<BlobImageProvider["getImage"]>[1]): { url: string } {
  const variant: BlobImageVariant = {}
  const width = positiveInteger(modifiers.width)
  const height = positiveInteger(modifiers.height)
  const quality = positiveInteger(modifiers.quality)
  const fit = modifiers.fit ? fits.get(modifiers.fit) : undefined
  const format = modifiers.format ? formats.get(modifiers.format.toLowerCase()) : undefined
  if (width) variant.width = snapImageSize(width, imageSizes)
  if (height) variant.height = snapImageSize(height, imageSizes)
  if (fit) variant.fit = fit
  if (format) variant.format = format
  if (quality) variant.quality = Math.min(quality, 100)
  if (modifiers.crop) variant.crop = modifiers.crop
  return { url: imageVariantUrl(sourceUrl(src, baseURL.replace(/\/+$/, "")), variant) }
}

/** The `@nuxt/image` provider for images in a served Blob Store. `vite-hub/nuxt` registers it as `vitehub`. */
export default function blobImageProvider(): BlobImageProvider {
  return { getImage }
}
