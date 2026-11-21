export type TarEntry =
  | { path: string, type: "directory" }
  | { path: string, type: "file", content: Uint8Array, executable?: boolean }
  | { path: string, type: "symlink", target: string }

const encoder = new TextEncoder()

function writeField(header: Uint8Array, offset: number, length: number, value: string) {
  header.set(encoder.encode(value).subarray(0, length), offset)
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number) {
  writeField(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`)
}

function tarHeader(name: string, type: string, size: number, mode: number, mtime: number, linkname = ""): Uint8Array {
  const header = new Uint8Array(512)
  writeField(header, 0, 100, name)
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, mtime)
  header.fill(0x20, 148, 156)
  writeField(header, 156, 1, type)
  writeField(header, 157, 100, linkname)
  writeField(header, 257, 8, "ustar\u000000")
  let checksum = 0
  for (const byte of header) checksum += byte
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return header
}

// A PAX record is "<length> <key>=<value>\n", where the length counts the whole record, its own digits included.
function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`
  const size = encoder.encode(body).byteLength
  let length = size + String(size).length
  if (String(length).length !== String(size).length) length = size + String(length).length
  return `${length}${body}`
}

function padding(size: number) {
  return new Uint8Array((512 - size % 512) % 512)
}

/** Packs the entries into one gzip tar archive. Names longer than the 100-byte ustar field use a PAX header. */
export async function createTarGz(entries: readonly TarEntry[], maxBytes: number): Promise<Uint8Array | undefined> {
  const mtime = Math.floor(Date.now() / 1000)
  const chunks: Uint8Array[] = []
  let size = 1024
  for (const entry of entries) {
    const start = chunks.length
    const name = entry.type === "directory" ? `${entry.path}/` : entry.path
    const linkname = entry.type === "symlink" ? entry.target : ""
    const pax = [
      encoder.encode(name).byteLength > 100 ? paxRecord("path", name) : "",
      encoder.encode(linkname).byteLength > 100 ? paxRecord("linkpath", linkname) : "",
    ].join("")
    if (pax) {
      const records = encoder.encode(pax)
      chunks.push(tarHeader("PaxHeader", "x", records.byteLength, 0o644, mtime), records, padding(records.byteLength))
    }
    if (entry.type === "directory") chunks.push(tarHeader(name, "5", 0, 0o755, mtime))
    else if (entry.type === "symlink") chunks.push(tarHeader(name, "2", 0, 0o777, mtime, linkname))
    else chunks.push(tarHeader(name, "0", entry.content.byteLength, entry.executable ? 0o755 : 0o644, mtime), entry.content, padding(entry.content.byteLength))
    for (let index = start; index < chunks.length; index++) size += chunks[index]!.byteLength
    if (size > maxBytes) return
  }
  chunks.push(new Uint8Array(1024))
  const tar = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    tar.set(chunk, offset)
    offset += chunk.byteLength
  }
  const compressed = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(compressed).arrayBuffer())
}
