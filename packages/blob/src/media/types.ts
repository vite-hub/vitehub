import type { BlobImageOperation, MediaFocalPoint } from "./variant.ts"

export type { BlobImageFit, BlobImageFormat, BlobImageOperation, BlobImageVariant, MediaFocalPoint } from "./variant.ts"

/** An uploaded file that replaces the generated image of one crop. ViteHub stores it under `_vitehub/media/crops/`. */
export interface MediaCropReplacement {
  contentType: string
  /** SHA-256 of the bytes, as hex. */
  hash: string
  height?: number
  pathname: string
  size: number
  width?: number
}

/** A named crop for art direction, such as a 4:5 image for narrow screens. */
export interface MediaCrop {
  /** Width to height, such as `"4:5"`, `"16:9"`, or `"1.91:1"`. */
  aspect: string
  /** Focal point of this crop. Defaults to the record's focal point, then the center. */
  focal?: MediaFocalPoint
  /** Uploaded file served instead of a crop of the original. Set it with `media.replaceCrop()`. */
  replacement?: MediaCropReplacement
}

/**
 * Media metadata for one Blob object. ViteHub stores it as JSON at `_vitehub/media/records/<pathname>.json` in the
 * same Blob Store, so it works on every driver, including drivers without custom metadata.
 */
export interface MediaRecord {
  alt?: string
  caption?: string
  /** Average color as `#rrggbb`, for a placeholder background. Present when an image transformer was available. */
  color?: string
  contentType: string
  createdAt: string
  crops?: Record<string, MediaCrop>
  /** ETag of the object the probe and hash describe. A different ETag makes `media.get()` read the object again. */
  etag?: string
  focal?: MediaFocalPoint
  /** SHA-256 of the bytes, as hex. Absent until ViteHub has read the object, for example in `media.list()`. */
  hash?: string
  height?: number
  pathname: string
  size: number
  updatedAt: string
  /** Served URL when the Blob Store is the served store. Never stored. */
  url?: string
  width?: number
}

/** Fields that `media.update()` changes. `null` removes a field or a crop. */
export interface MediaUpdate {
  alt?: string | null
  caption?: string | null
  /** Each crop is merged by name. A replacement is kept unless the crop is removed. */
  crops?: Record<string, { aspect: string, focal?: MediaFocalPoint | null } | null>
  focal?: MediaFocalPoint | null
}

/** One cached variant, as `media.variants()` and `vitehub blob variants` report it. */
export interface MediaVariantEntry {
  /** Pathname of the cache object under `_vitehub/derived/`. */
  cachePathname: string
  contentType?: string
  /** Transform key, such as `image:v1;src=original;out=640x427;fmt=webp;q=75;engine=sharp`. */
  key?: string
  size: number
  /** Pathname whose bytes the variant was made from: the original or a crop replacement. */
  source: string
}

/** Turns one image into one variant. Implement it to plug in another image service. */
export interface BlobImageTransformer {
  /** Stable name. It is part of variant cache keys, so a new transformer creates new variants. */
  readonly name: string
  /** Applies `operation.extract`, then resizes to exactly `operation.width` × `operation.height`, then encodes. */
  transform(input: Blob, operation: BlobImageOperation): Promise<Blob>
}

/** Built-in transformer names. `auto` picks the Cloudflare Images binding, then sharp, then passthrough. */
export type BlobImageTransformerName = "auto" | "cloudflare-images" | "passthrough" | "sharp"

/** `blob.images` options. Variants are on by default with the `auto` transformer. */
export interface BlobImagesOptions {
  /** Cloudflare Images binding name. Defaults to `IMAGES`. */
  binding?: string
  /** Default quality for lossy formats, from 1 to 100. Defaults to 75. */
  quality?: number
  /** Sizes that variant widths and heights snap to. Defaults to 16 through 3840. */
  sizes?: number[]
  /** Defaults to `auto`. */
  transformer?: BlobImageTransformerName
}
