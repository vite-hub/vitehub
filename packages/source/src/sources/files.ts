import { lookup } from "mrmime"

import { sourceError } from "../core/errors.ts"
import { normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"

import type { FileSource, SourceContent } from "../core/types.ts"

export interface FilesSourceOptions {
  /** Removed from the start of every path, such as the folder that an `import.meta.glob()` pattern starts with. */
  base?: string
  /** Put before every item's path, like glob()'s `prefix`. Keys stay without it. */
  prefix?: string
}

/**
 * A Source of files that the server already holds, keyed by path. A ViteHub build turns `glob()` into this, with the
 * matched files in the server bundle. Call it yourself for files you hold another way.
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
  const prefix = normalizeSafeSourcePath(options.prefix || "", { allowEmpty: true })

  return {
    name: "files",
    async getKeys() {
      return keys
    },
    async getItem(key: string) {
      const content = items.get(key)
      if (content === undefined) throw sourceError(`[vitehub] files() could not find ${JSON.stringify(key)}.`)
      return { key, path: normalizeSourcePath(prefix ? `${prefix}/${key}` : key), content, mediaType: lookup(key) }
    },
  }
}
