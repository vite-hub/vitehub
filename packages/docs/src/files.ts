import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { gzipSync } from "node:zlib"

/** A folder of Markdown files that the server reads by name, such as the content folder or the raw copies. */
interface DocsFileStore {
  name: string
  dir: string
}

/** Where each file sits in the unpacked bytes: `index[store][file]` is `[start, end]`. */
type DocsFilesIndex = Record<string, Record<string, [number, number]>>

/** What `#docs/files` exports in a production build. Development exports `null` and reads the folders. */
export interface DocsPackedFiles {
  index: DocsFilesIndex
  /** Every file, one after the other, as one gzip stream in base64. */
  packed: string
}

/** The Markdown files of a folder, without dot files or dot folders, as Nitro's server assets list them. */
function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter(file => !file.split("/").some(part => part.startsWith(".")))
    .sort()
}

/**
 * Packs the Markdown files of every store into one gzip stream. `order` lists `[store, file]` pairs to put first. Gzip
 * finds repeats only in the last 32 KB, so a page next to its raw copy packs a third smaller than the two folders apart.
 */
function packDocsFiles(stores: DocsFileStore[], order: Array<[store: string, file: string]> = []): DocsPackedFiles {
  const files = new Map(stores.map(store => [store.name, new Map(markdownFiles(store.dir).map(file => [file, join(store.dir, file)]))]))
  const sequence: Array<[string, string, string]> = []
  const added = new Set<string>()
  const add = (store: string, file: string) => {
    const path = files.get(store)?.get(file)
    if (!path || added.has(`${store}\0${file}`)) return
    added.add(`${store}\0${file}`)
    sequence.push([store, file, path])
  }
  for (const [store, file] of order) add(store, file)
  for (const [store, paths] of files) for (const file of paths.keys()) add(store, file)

  const index: DocsFilesIndex = Object.fromEntries(stores.map(store => [store.name, {}]))
  const chunks: Buffer[] = []
  let offset = 0
  for (const [store, file, path] of sequence) {
    const bytes = readFileSync(path)
    index[store]![file] = [offset, offset + bytes.length]
    chunks.push(bytes)
    offset += bytes.length
  }
  return { index, packed: gzipSync(Buffer.concat(chunks), { level: 9 }).toString("base64") }
}

/** The source of `#docs/files` for a production build. */
export function docsFilesModule(stores: DocsFileStore[], order?: Array<[store: string, file: string]>): string {
  const { index, packed } = packDocsFiles(stores, order)
  // `JSON.parse` of a string parses faster than an object literal of the same size.
  return `export default { index: JSON.parse(${JSON.stringify(JSON.stringify(index))}), packed: ${JSON.stringify(packed)} }\n`
}
