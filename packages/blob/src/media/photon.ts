// Image variants with Photon, a Rust image library compiled to WebAssembly. It runs on Workers and Node.
import { blobErrorDiagnostics } from "../error-diagnostics.ts"
import { isMissingPeerError } from "../internal/optional-peer.ts"
import { getBlobPhotonLoader, photonFromModule } from "./photon-module.ts"
import { jpegOrientation, probeImage } from "./probe.ts"
import { defaultImageQuality } from "./variant.ts"

import type { PhotonImageLike, PhotonLike } from "./photon-module.ts"
import type { BlobImageTransformer } from "./types.ts"
import type { BlobImageOperation } from "./variant.ts"

/** Photon rejects larger sources. */
export const photonMaxInputBytes = 10 * 1024 * 1024
/**
 * Photon rejects sources with more pixels. Decoding and resizing need about 19 bytes of WebAssembly memory per source
 * pixel, and a Worker has 128 MB for everything, so the limit keeps one variant under about 80 MB.
 */
export const photonMaxInputPixels = 4_000_000

const decodableFormats = new Set(["gif", "jpeg", "png", "webp"])
const triangleFilter = 2

type Region = NonNullable<BlobImageOperation["extract"]>

function rejected(message: string, cause?: unknown): Error {
  return blobErrorDiagnostics.BLOB_R0036({ message: `The photon image transformer ${message}`, ...(cause === undefined ? {} : { cause }) })
}

interface Size {
  height: number
  width: number
}

/** Maps a point of the displayed image to the stored pixels of an image with EXIF `orientation`. */
function storedPoint(orientation: number, { height, width }: Size, x: number, y: number): [number, number] {
  switch (orientation) {
    case 2: return [width - x, y]
    case 3: return [width - x, height - y]
    case 4: return [x, height - y]
    case 5: return [y, x]
    case 6: return [y, height - x]
    case 7: return [width - y, height - x]
    case 8: return [width - y, x]
    default: return [x, y]
  }
}

function storedRegion(region: Region, orientation: number, stored: Size): Region {
  const [x1, y1] = storedPoint(orientation, stored, region.left, region.top)
  const [x2, y2] = storedPoint(orientation, stored, region.left + region.width, region.top + region.height)
  return { height: Math.abs(y2 - y1), left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1) }
}

/** Turns stored pixels upright. Photon's `rotate()` interpolates at any angle, so it does not turn pixels exactly. */
function orient(photon: PhotonLike, image: PhotonImageLike, orientation: number): PhotonImageLike {
  const stored = { height: image.get_height(), width: image.get_width() }
  const width = orientation >= 5 ? stored.height : stored.width
  const height = orientation >= 5 ? stored.width : stored.height
  // Each display pixel reads the stored pixel under its center. The stored index changes by a fixed step per column and row.
  const index = (x: number, y: number) => {
    const [storedX, storedY] = storedPoint(orientation, stored, x + 0.5, y + 0.5)
    return Math.floor(storedY) * stored.width + Math.floor(storedX)
  }
  const start = index(0, 0)
  const column = index(1, 0) - start
  const row = index(0, 1) - start
  const source = new Uint32Array(image.get_raw_pixels().buffer)
  const pixels = new Uint32Array(width * height)
  for (let y = 0, target = 0; y < height; y++) {
    for (let x = 0, at = start + y * row; x < width; x++, at += column) pixels[target++] = source[at]!
  }
  return new photon.PhotonImage(new Uint8Array(pixels.buffer), width, height)
}

/**
 * Cuts and resizes the stored pixels, then turns the small result upright. Each step frees the previous image, so
 * WebAssembly memory holds at most two images.
 */
function encode(photon: PhotonLike, bytes: Uint8Array<ArrayBuffer>, operation: BlobImageOperation): Uint8Array<ArrayBuffer> {
  let image: PhotonImageLike
  try {
    image = photon.PhotonImage.new_from_byteslice(bytes)
  }
  catch (cause) {
    throw rejected("cannot decode the image.", cause)
  }
  const replace = (next: PhotonImageLike) => {
    image.free()
    image = next
  }
  try {
    const orientation = jpegOrientation(bytes)
    if (operation.extract) {
      const region = storedRegion(operation.extract, orientation, { height: image.get_height(), width: image.get_width() })
      replace(photon.crop(image, region.left, region.top, region.left + region.width, region.top + region.height))
    }
    const width = orientation >= 5 ? operation.height : operation.width
    const height = orientation >= 5 ? operation.width : operation.height
    if (image.get_width() !== width || image.get_height() !== height) replace(photon.resize(image, width, height, triangleFilter))
    if (orientation !== 1) replace(orient(photon, image, orientation))
    // The encoders write pixels only, so EXIF, XMP, and ICC metadata of the source are not copied.
    if (operation.format === "jpeg") return image.get_bytes_jpeg(operation.quality ?? defaultImageQuality)
    return operation.format === "png" ? image.get_bytes() : image.get_bytes_webp()
  }
  finally {
    image.free()
  }
}

/** Loads Photon from the registered loader, or from the installed package without a static import. */
async function loadPhoton(): Promise<PhotonLike> {
  const specifier = "@cf-wasm/photon"
  const load = getBlobPhotonLoader() ?? (() => import(/* @vite-ignore */ specifier))
  let module: unknown
  try {
    module = await load()
  }
  catch (cause) {
    const message = isMissingPeerError(cause, specifier)
      ? "The photon image transformer requires @cf-wasm/photon. Install it with: pnpm add @cf-wasm/photon"
      : `The photon image transformer cannot load @cf-wasm/photon: ${cause instanceof Error ? cause.message : String(cause)}`
    throw blobErrorDiagnostics.BLOB_R0034({ message, cause })
  }
  const photon = photonFromModule(module)
  if (!photon) throw blobErrorDiagnostics.BLOB_R0034({ message: "The photon image transformer loaded a module without the @cf-wasm/photon API." })
  return photon
}

/**
 * Resizes with `@cf-wasm/photon`. Pass the module, or ViteHub loads the registered or installed module on first use.
 * Photon writes WebP without loss and cannot write AVIF.
 */
export function createPhotonImageTransformer(photon?: PhotonLike): BlobImageTransformer {
  return {
    name: "photon",
    async transform(input, operation) {
      if (operation.format === "avif") throw rejected("cannot write AVIF. Request webp, jpeg, or png.")
      if (input.size > photonMaxInputBytes) throw rejected(`accepts images up to ${photonMaxInputBytes} bytes. This image has ${input.size} bytes.`)
      const bytes = new Uint8Array(await input.arrayBuffer())
      const probe = probeImage(bytes)
      if (!probe) throw rejected("cannot read the image size. It reads JPEG, PNG, WebP, and GIF images.")
      if (!decodableFormats.has(probe.format)) throw rejected(`reads JPEG, PNG, WebP, and GIF images, not ${probe.format.toUpperCase()}.`)
      if (probe.width * probe.height > photonMaxInputPixels) {
        throw rejected(`accepts images up to ${photonMaxInputPixels} pixels. This image is ${probe.width} × ${probe.height}.`)
      }
      return new Blob([encode(photon ?? await loadPhoton(), bytes, operation)], { type: `image/${operation.format}` })
    },
  }
}
