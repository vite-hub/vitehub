import { lookup } from "mrmime"

import { sourceError } from "../core/errors.ts"
import { normalizeSafeSourcePath } from "../core/path.ts"

import type { FileSource, SourceContent } from "../core/types.ts"

export interface FilesSourceOptions {
  /** Removed from the start of every path, such as the folder that an `import.meta.glob()` pattern starts with. */
  base?: string
}

/**
 * A Source of files that the server already holds, keyed by path. Pass the result of
 * `import.meta.glob(pattern, { query: "?raw", import: "default", eager: true })` to put the files in the server
 * bundle at build time. Hosts without a runtime file system, such as Cloudflare Workers, can then read them.
 */
export function files(entries: Record<string, SourceContent>, options: FilesSourceOptions = {}): FileSource<string> {
  const base = options.base ? `${options.base.replace(/\\/g, "/").replace(/\/+$/, "")}/` : ""
  const items = new Map<string, SourceContent>()
  for (const [path, content] of Object.entries(entries)) {
    const portable = path.replace(/\\/g, "/")
    if (base && !portable.startsWith(base)) {
      throw sourceError(`[vitehub] files() path ${JSON.stringify(path)} does not start with base ${JSON.stringify(options.base)}.`)
    }
    const key = normalizeSafeSourcePath(portable.slice(base.length))
    if (items.has(key)) throw sourceError(`[vitehub] files() has two files at ${JSON.stringify(key)}.`)
    items.set(key, content)
  }
  const keys = [...items.keys()].sort((left, right) => left.localeCompare(right))

  return {
    name: "files",
    async getKeys() {
      return keys
    },
    async getItem(key: string) {
      const content = items.get(key)
      if (content === undefined) throw sourceError(`[vitehub] files() could not find ${JSON.stringify(key)}.`)
      return { key, path: key, content, mediaType: lookup(key) }
    },
  }
}
