import { useKV } from "nitro/kv"
import files from "#docs/files"

const decoder = new TextDecoder()
let unpacked: Promise<Uint8Array> | undefined

async function unpack(base64: string): Promise<Uint8Array> {
  // Node, Bun, Deno, and Workers with nodejs_compat have node:zlib. It decodes faster than DecompressionStream.
  const zlib = globalThis.process?.getBuiltinModule?.("node:zlib")
  const buffer = globalThis.process?.getBuiltinModule?.("node:buffer")
  if (zlib && buffer) {
    const bytes = zlib.gunzipSync(buffer.Buffer.from(base64, "base64"))
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  const binary = atob(base64)
  const gzip = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) gzip[index] = binary.charCodeAt(index)
  return new Uint8Array(await new Response(new Response(gzip).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
}

/**
 * A Markdown file of a docs store: a content folder (`docs`, `docs-1`, ...) or the raw copies (`docs-raw`), or null.
 * A production build packs every file into one module. Nitro server assets would add one module per file, and
 * Cloudflare rejects a Worker upload with more than 5,000 modules. Development reads the folders through Nitro.
 */
export async function readDocsFile(store: string, file: string): Promise<string | null> {
  if (!files) {
    const content = await useKV(`assets:${store}`).getItem<string>(file)
    return content === null ? null : String(content)
  }
  const ranges = Object.hasOwn(files.index, store) ? files.index[store]! : undefined
  const range = ranges && Object.hasOwn(ranges, file) ? ranges[file] : undefined
  if (!range) return null
  const bytes = await (unpacked ??= unpack(files.packed))
  return decoder.decode(bytes.subarray(range[0], range[1]))
}
