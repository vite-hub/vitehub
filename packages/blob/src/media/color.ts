// Average color of an image: a transformer scales it to a 1×1 PNG, and this module reads that pixel.
// Inflating with DecompressionStream keeps it portable across Node, Workers, and browsers.
import type { BlobImageTransformer } from "./types.ts"

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0")
}

/** Reads the first pixel of an 8-bit PNG as `#rrggbb`. Returns `undefined` for other PNG layouts. */
export async function readFirstPngPixel(bytes: Uint8Array): Promise<string | undefined> {
  if (bytes.length < 33 || bytes[0] !== 0x89) return undefined
  let offset = 8
  let colorType = -1
  let bitDepth = 0
  let palette: Uint8Array | undefined
  const data: Uint8Array[] = []
  while (offset + 8 <= bytes.length) {
    const length = u32(bytes, offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      bitDepth = body[8]!
      colorType = body[9]!
    }
    else if (type === "PLTE") palette = body
    else if (type === "IDAT") data.push(body)
    else if (type === "IEND") break
    offset += 12 + length
  }
  if (bitDepth !== 8 || !data.length) return undefined
  const joined = new Uint8Array(data.reduce((total, chunk) => total + chunk.length, 0))
  let position = 0
  for (const chunk of data) {
    joined.set(chunk, position)
    position += chunk.length
  }
  // Byte 0 is the scanline filter. Every filter leaves the first pixel of the first row unchanged.
  const pixel = (await inflate(joined)).subarray(1)
  switch (colorType) {
    case 0:
    case 4:
      return `#${hex(pixel[0]!)}${hex(pixel[0]!)}${hex(pixel[0]!)}`
    case 2:
    case 6:
      return `#${hex(pixel[0]!)}${hex(pixel[1]!)}${hex(pixel[2]!)}`
    case 3: {
      if (!palette) return undefined
      const index = pixel[0]! * 3
      return `#${hex(palette[index]!)}${hex(palette[index + 1]!)}${hex(palette[index + 2]!)}`
    }
    default:
      return undefined
  }
}

/** Average color of an image as `#rrggbb`, or `undefined` when the transformer or decoding fails. */
export async function averageImageColor(transformer: BlobImageTransformer, image: Blob): Promise<string | undefined> {
  try {
    const pixel = await transformer.transform(image, { format: "png", height: 1, width: 1 })
    return await readFirstPngPixel(new Uint8Array(await pixel.arrayBuffer()))
  }
  catch {
    return undefined
  }
}
