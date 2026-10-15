// Framework-neutral `<picture>` and `<img>` attributes for a media record.
import { defaultResponsiveWidths, focalCropRegion, focalPointToObjectPosition, imageVariantUrl, parseAspectRatio } from "./variant.ts"

import type { MediaCrop, MediaCropReplacement } from "./types.ts"
import type { BlobImageFormat, MediaFocalPoint } from "./variant.ts"

/** The parts of a media record that `responsiveImage()` reads. A `MediaRecord` from `blob.media.get()` fits. */
export interface ResponsiveImageInput {
  alt?: string
  color?: string
  contentType?: string
  crops?: Record<string, Pick<MediaCrop, "aspect"> & { replacement?: Pick<MediaCropReplacement, "height" | "width"> }>
  focal?: MediaFocalPoint
  height?: number
  /** Served URL of the original. Required here or in the options. */
  url?: string
  width?: number
}

/** One art-direction rule: show `crop` when `media` matches. Earlier rules win, as in `<picture>`. */
export interface ResponsiveImageArtDirection {
  crop: string
  /** Media query, such as `"(max-width: 640px)"`. */
  media: string
  /** Defaults to the image `sizes`. */
  sizes?: string
}

export interface ResponsiveImageOptions {
  /** Defaults to the record's alt text, then an empty string (a decorative image). */
  alt?: string
  /** `<source>` rules for other screens, such as a 4:5 crop below 640px. */
  art?: ResponsiveImageArtDirection[]
  /** Crop for the `<img>` itself. Defaults to the uncropped image. */
  crop?: string
  /** `fetchpriority` of the `<img>`. Use `high` for the largest image above the fold. */
  fetchpriority?: "auto" | "high" | "low"
  /** Defaults to `webp`. */
  format?: BlobImageFormat
  /** Defaults to `lazy`. */
  loading?: "eager" | "lazy"
  quality?: number
  /** The `sizes` attribute. Defaults to `100vw`. */
  sizes?: string
  /** Overrides the record URL. */
  url?: string
  /** Candidate widths. Defaults to 640 through 3840. Widths above the source are dropped. */
  widths?: readonly number[]
}

/** Attributes of one `<source>` in a `<picture>`. */
export interface ResponsiveImageSource {
  height?: number
  media?: string
  sizes: string
  srcset: string
  type: string
  width?: number
}

/** Attributes of the `<img>`. `width` and `height` reserve the layout box, so the page does not shift. */
export interface ResponsiveImageAttributes {
  alt: string
  decoding: "async"
  fetchpriority?: "auto" | "high" | "low"
  height?: number
  loading: "eager" | "lazy"
  sizes?: string
  src: string
  srcset?: string
  /** `object-position` from the focal point and a `background-color` placeholder, as a CSS declaration list. */
  style?: string
  width?: number
}

/** Render `sources` as `<source>` elements inside a `<picture>`, then `img` as its `<img>`. */
export interface ResponsiveImage {
  img: ResponsiveImageAttributes
  sources: ResponsiveImageSource[]
}

const unresizableTypes = new Set(["image/gif", "image/svg+xml"])

interface Candidates {
  height?: number
  src: string
  srcset?: string
  width?: number
}

function candidates(input: ResponsiveImageInput, url: string, crop: string | undefined, options: ResponsiveImageOptions): Candidates {
  const format = options.format ?? "webp"
  const named = crop ? input.crops?.[crop] : undefined
  const aspect = named ? parseAspectRatio(named.aspect) : undefined
  const source = named?.replacement?.width && named.replacement.height
    ? { height: named.replacement.height, width: named.replacement.width }
    : input.width && input.height ? { height: input.height, width: input.width } : undefined
  let naturalWidth = source?.width
  let naturalHeight = source?.height
  if (source && aspect) {
    const region = focalCropRegion(source, aspect)
    naturalWidth = region.width
    naturalHeight = Math.round(region.width / aspect)
  }
  const widths = [...(options.widths ?? defaultResponsiveWidths)].sort((left, right) => left - right)
  const offered = naturalWidth ? [...widths.filter(width => width < naturalWidth!), naturalWidth] : widths
  const variant = (width: number) => imageVariantUrl(url, {
    ...(named && aspect ? { crop } : {}),
    format,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    width,
  })
  const fallback = offered.find(width => width >= 1080) ?? offered.at(-1)!
  return {
    ...(naturalHeight ? { height: naturalHeight } : {}),
    src: variant(fallback),
    srcset: offered.map(width => `${variant(width)} ${width}w`).join(", "),
    ...(naturalWidth ? { width: naturalWidth } : {}),
  }
}

/**
 * Builds `<picture>` sources and `<img>` attributes for a media record: a `srcset` of width variants, `sizes`,
 * art-direction sources from named crops, intrinsic `width` and `height`, and a focal-point `object-position`.
 * GIF and SVG images keep their original URL, because variants would drop animation or vector detail.
 */
export function responsiveImage(input: ResponsiveImageInput, options: ResponsiveImageOptions = {}): ResponsiveImage {
  const url = options.url ?? input.url
  if (!url) throw new TypeError("[vitehub] responsiveImage() needs the served URL of the image. Read the record from the served Blob Store or pass `url`.")
  const sizes = options.sizes ?? "100vw"
  const style = [
    input.focal ? `object-position: ${focalPointToObjectPosition(input.focal)}` : undefined,
    input.color ? `background-color: ${input.color}` : undefined,
  ].filter(Boolean).join("; ")
  const img: ResponsiveImageAttributes = {
    alt: options.alt ?? input.alt ?? "",
    decoding: "async",
    loading: options.loading ?? "lazy",
    src: url,
    ...(options.fetchpriority ? { fetchpriority: options.fetchpriority } : {}),
    ...(style ? { style } : {}),
  }
  if (input.contentType && unresizableTypes.has(input.contentType.split(";")[0]!.trim().toLowerCase())) {
    if (input.width) img.width = input.width
    if (input.height) img.height = input.height
    return { img, sources: [] }
  }
  const type = `image/${options.format ?? "webp"}`
  const base = candidates(input, url, options.crop, options)
  Object.assign(img, { sizes, src: base.src, srcset: base.srcset }, base.width ? { width: base.width } : {}, base.height ? { height: base.height } : {})
  const sources = (options.art ?? [])
    .filter(rule => input.crops?.[rule.crop])
    .map((rule) => {
      const art = candidates(input, url, rule.crop, options)
      const source: ResponsiveImageSource = { media: rule.media, sizes: rule.sizes ?? sizes, srcset: art.srcset!, type }
      if (art.width) source.width = art.width
      if (art.height) source.height = art.height
      return source
    })
  return { img, sources }
}
