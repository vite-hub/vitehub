// Pure-JS image header parsing. Runs on Node, Workers, and browsers without native modules.

export type ImageProbeFormat = "avif" | "gif" | "jpeg" | "png" | "svg" | "webp"

/** What `probeImage()` reads from the image header. Dimensions are display dimensions after EXIF or `irot` rotation. */
export interface ImageProbe {
  contentType: string
  format: ImageProbeFormat
  height: number
  width: number
}

const contentTypes: Record<ImageProbeFormat, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
}

function result(format: ImageProbeFormat, width: number, height: number): ImageProbe | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return undefined
  return { contentType: contentTypes[format], format, height, width }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ""
  for (let index = offset; index < offset + length && index < bytes.length; index++) value += String.fromCharCode(bytes[index]!)
  return value
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
}

function probePng(bytes: Uint8Array): ImageProbe | undefined {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return undefined
  return result("png", u32be(bytes, 16), u32be(bytes, 20))
}

function probeGif(bytes: Uint8Array): ImageProbe | undefined {
  if (bytes.length < 10) return undefined
  return result("gif", u16le(bytes, 6), u16le(bytes, 8))
}

function probeWebp(bytes: Uint8Array): ImageProbe | undefined {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === "VP8 " && bytes.length >= 30) return result("webp", u16le(bytes, 26) & 0x3FFF, u16le(bytes, 28) & 0x3FFF)
  if (chunk === "VP8L" && bytes.length >= 25) {
    const b0 = bytes[21]!, b1 = bytes[22]!, b2 = bytes[23]!, b3 = bytes[24]!
    return result("webp", 1 + (((b1 & 0x3F) << 8) | b0), 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)))
  }
  if (chunk === "VP8X" && bytes.length >= 30) return result("webp", 1 + u24le(bytes, 24), 1 + u24le(bytes, 27))
  return undefined
}

/** Reads the EXIF orientation from an APP1 segment. Returns 1 when absent. */
function exifOrientation(bytes: Uint8Array, start: number, end: number): number {
  if (ascii(bytes, start, 6) !== "Exif\0\0") return 1
  const tiff = start + 6
  const little = ascii(bytes, tiff, 2) === "II"
  const read16 = (offset: number) => little ? u16le(bytes, offset) : u16be(bytes, offset)
  const read32 = (offset: number) => little
    ? (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000
    : u32be(bytes, offset)
  if (tiff + 8 > end) return 1
  const ifd = tiff + read32(tiff + 4)
  if (ifd + 2 > end) return 1
  const entries = read16(ifd)
  for (let index = 0; index < entries; index++) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > end) break
    if (read16(entry) === 0x0112) return read16(entry + 8)
  }
  return 1
}

function probeJpeg(bytes: Uint8Array): ImageProbe | undefined {
  let offset = 2
  let orientation = 1
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xFF) return undefined
    const marker = bytes[offset + 1]!
    // Fill bytes and markers without a length.
    if (marker === 0xFF) {
      offset++
      continue
    }
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = u16be(bytes, offset + 2)
    if (length < 2) return undefined
    if (marker === 0xE1) orientation = exifOrientation(bytes, offset + 4, Math.min(bytes.length, offset + 2 + length))
    // SOF0-SOF15 except DHT (C4), JPG (C8), and DAC (CC) carry the frame size.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (offset + 9 > bytes.length) return undefined
      const height = u16be(bytes, offset + 5)
      const width = u16be(bytes, offset + 7)
      return orientation >= 5 && orientation <= 8 ? result("jpeg", height, width) : result("jpeg", width, height)
    }
    if (marker === 0xDA) return undefined
    offset += 2 + length
  }
  return undefined
}

/** Walks ISO BMFF boxes for the largest `ispe` (primary image size) and an `irot` rotation. */
function probeAvif(bytes: Uint8Array): ImageProbe | undefined {
  let width = 0
  let height = 0
  let rotation = 0
  const containers = new Set(["meta", "iprp", "ipco"])
  function walk(start: number, end: number) {
    let offset = start
    while (offset + 8 <= end) {
      let size = u32be(bytes, offset)
      const type = ascii(bytes, offset + 4, 4)
      let header = 8
      if (size === 1 && offset + 16 <= end) {
        size = u32be(bytes, offset + 8) * 0x1_0000_0000 + u32be(bytes, offset + 12)
        header = 16
      }
      if (size === 0) size = end - offset
      if (size < header || offset + size > end) return
      if (type === "ispe" && size >= header + 12) {
        const boxWidth = u32be(bytes, offset + header + 4)
        const boxHeight = u32be(bytes, offset + header + 8)
        if (boxWidth * boxHeight > width * height) {
          width = boxWidth
          height = boxHeight
        }
      }
      else if (type === "irot" && size >= header + 1) {
        rotation = bytes[offset + header]! & 0x03
      }
      else if (containers.has(type)) {
        // `meta` is a full box: version and flags precede its children.
        walk(offset + header + (type === "meta" ? 4 : 0), offset + size)
      }
      offset += size
    }
  }
  walk(0, bytes.length)
  return rotation % 2 === 1 ? result("avif", height, width) : result("avif", width, height)
}

function svgLength(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(value)
  return match ? Math.round(Number(match[1])) : undefined
}

function probeSvg(bytes: Uint8Array): ImageProbe | undefined {
  const text = new TextDecoder().decode(bytes.subarray(0, 4096))
  const tag = /<svg\b([^>]*)>/i.exec(text)?.[1]
  if (tag === undefined) return undefined
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find(value => value !== undefined)
  const width = svgLength(attribute("width"))
  const height = svgLength(attribute("height"))
  if (width && height) return result("svg", width, height)
  const viewBox = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number)
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0) {
    const ratio = viewBox[2]! / viewBox[3]!
    if (width) return result("svg", width, Math.round(width / ratio))
    if (height) return result("svg", Math.round(height * ratio), height)
    return result("svg", Math.round(viewBox[2]!), Math.round(viewBox[3]!))
  }
  return undefined
}

/**
 * Reads the format and display size of a JPEG, PNG, WebP, GIF, AVIF, or SVG image from its bytes.
 * Returns `undefined` for other files and for headers it cannot read. It does not decode pixels or prove the file is valid.
 */
export function probeImage(input: Uint8Array | ArrayBuffer): ImageProbe | undefined {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length < 4) return undefined
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return probePng(bytes)
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return probeJpeg(bytes)
  if (ascii(bytes, 0, 4) === "GIF8") return probeGif(bytes)
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return probeWebp(bytes)
  // The major brand or a compatible brand of the `ftyp` box names AVIF.
  if (ascii(bytes, 4, 4) === "ftyp" && /avif|avis/.test(ascii(bytes, 8, Math.min(u32be(bytes, 0), 64) - 8))) return probeAvif(bytes)
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart()
  if (head.startsWith("<svg") || ((head.startsWith("<?xml") || head.startsWith("<!--") || head.startsWith("<!DOCTYPE")) && head.includes("<svg"))) return probeSvg(bytes)
  return undefined
}
