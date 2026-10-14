// Image transformers: sharp on Node, the Cloudflare Images binding on Workers, and passthrough elsewhere.
import { getActiveCloudflareBinding } from "../runtime/state.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"
import { defaultImageQuality, defaultImageSizes } from "./variant.ts"
import { getBlobSharpModule, sharpFromModule } from "./sharp-module.ts"

import type { SharpLike } from "./sharp-module.ts"
import type { BlobImagesOptions, BlobImageTransformer, BlobImageTransformerName } from "./types.ts"

/** `blob.images` after defaults. `transformer` may also be a custom transformer in programmatic setups. */
export interface ResolvedBlobImages {
  binding: string
  quality: number
  sizes: readonly number[]
  transformer: BlobImageTransformer | BlobImageTransformerName
}

/** The part of the Cloudflare Images binding that ViteHub uses. */
export interface CloudflareImagesBindingLike {
  input(stream: ReadableStream<Uint8Array>): CloudflareImageTransformerLike
}

interface CloudflareImageTransformerLike {
  output(options: { format: string, quality?: number }): Promise<{ contentType(): string, response(): Response }>
  transform(options: Record<string, unknown>): CloudflareImageTransformerLike
}

export function resolveBlobImages(options: BlobImagesOptions | BlobImageTransformer | false | undefined): ResolvedBlobImages | undefined {
  if (options === false) return undefined
  if (options && "transform" in options) return { binding: "IMAGES", quality: defaultImageQuality, sizes: defaultImageSizes, transformer: options }
  return {
    binding: options?.binding ?? "IMAGES",
    quality: options?.quality ?? defaultImageQuality,
    sizes: options?.sizes?.length ? [...options.sizes].sort((left, right) => left - right) : defaultImageSizes,
    transformer: options?.transformer ?? "auto",
  }
}

/** Resizes with sharp. Pass the module, or ViteHub loads the registered or installed sharp on first use. */
export function createSharpImageTransformer(sharp?: SharpLike): BlobImageTransformer {
  return {
    name: "sharp",
    async transform(input, operation) {
      const module = sharp ?? await loadSharp()
      if (!module) throw blobErrorDiagnostics.BLOB_R0034({ message: "The sharp image transformer requires sharp. Install it with: pnpm add sharp" })
      // `rotate()` applies EXIF orientation first, so the region is in display coordinates.
      let pipeline = module(new Uint8Array(await input.arrayBuffer())).rotate()
      if (operation.extract) pipeline = pipeline.extract(operation.extract)
      pipeline = pipeline.resize(operation.width, operation.height, { fit: "fill" })
      // A PNG quality would switch sharp to a lossy palette, so PNG stays lossless.
      pipeline = pipeline.toFormat(operation.format, operation.format === "png" ? {} : { quality: operation.quality ?? defaultImageQuality })
      return new Blob([await pipeline.toBuffer()], { type: `image/${operation.format}` })
    },
  }
}

/** Resizes with a Cloudflare Images binding. Pass the binding or its name in the active Worker environment. */
export function createCloudflareImagesTransformer(binding: CloudflareImagesBindingLike | string = "IMAGES"): BlobImageTransformer {
  return {
    name: "cloudflare-images",
    async transform(input, operation) {
      const images = binding instanceof Object ? binding : getActiveCloudflareBinding<CloudflareImagesBindingLike>(binding)
      if (!images) throw blobErrorDiagnostics.BLOB_R0034({ message: `Cloudflare Images binding "${String(binding)}" was not found. Add an \`images\` binding to the Worker.` })
      // The region is already cut to the output aspect, so `cover` only scales. Cloudflare trims before resizing.
      const size = { fit: "cover", height: operation.height, width: operation.width }
      const options = operation.extract ? { ...size, trim: operation.extract } : size
      const result = await images.input(input.stream()).transform(options).output({
        format: `image/${operation.format}`,
        ...(operation.format === "png" ? {} : { quality: operation.quality ?? defaultImageQuality }),
      })
      return new Blob([await result.response().arrayBuffer()], { type: result.contentType() })
    },
  }
}

let sharpLoad: Promise<SharpLike | undefined> | undefined

/** Loads sharp without a static import, so Worker bundles never include it. */
async function loadSharp(): Promise<SharpLike | undefined> {
  const registered = getBlobSharpModule()
  if (registered) return registered
  sharpLoad ||= (async () => {
    if (!globalThis.process?.versions?.node) return undefined
    const specifier = "sharp"
    try {
      return sharpFromModule(await import(/* @vite-ignore */ specifier))
    }
    catch {
      return undefined
    }
  })()
  return sharpLoad
}

const sharpTransformer = createSharpImageTransformer()

/**
 * Picks the transformer for one request. `auto` uses the Cloudflare Images binding when the Worker has it, then sharp
 * when it can load, then passthrough. Passthrough returns `undefined`: the serve route sends the original.
 */
export async function selectImageTransformer(images: ResolvedBlobImages): Promise<BlobImageTransformer | undefined> {
  const { transformer } = images
  if (transformer === "passthrough") return undefined
  if (transformer === "cloudflare-images") return createCloudflareImagesTransformer(images.binding)
  if (transformer === "sharp") return sharpTransformer
  if (transformer !== "auto") return transformer
  if (getActiveCloudflareBinding(images.binding)) return createCloudflareImagesTransformer(images.binding)
  return await loadSharp() ? sharpTransformer : undefined
}
