import { glob as tinyglobby } from "tinyglobby"

import { matchesAny, normalizeSourcePath } from "./path.ts"

import type { Source, SourceContext, SourceItem } from "./types.ts"

export interface GlobSourceOptions {
  cwd?: string
  include: string | string[]
  exclude?: string | string[]
  root?: string
}

export function glob<const TKey extends string = string>(options: GlobSourceOptions): Source<TKey> {
  return {
    name: "glob",
    async getKeys(ctx: SourceContext) {
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const files = await tinyglobby(options.include, {
        cwd,
        dot: true,
        ignore: ["**/.git/**", "**/node_modules/**", ...(Array.isArray(options.exclude) ? options.exclude : options.exclude ? [options.exclude] : [])],
        onlyFiles: true,
      })
      return files
        .map(file => normalizeSourcePath(file))
        .filter(file => matchesAny(file, options.include) && !(options.exclude && matchesAny(file, options.exclude)))
        .sort((left, right) => left.localeCompare(right)) as TKey[]
    },
    async getMeta(key: TKey, ctx: SourceContext) {
      const { stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const info = await stat(resolve(cwd, key))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(key: TKey, ctx: SourceContext): Promise<SourceItem<TKey>> {
      const { readFile, stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const root = normalizeSourcePath(options.root || "")
      const bytes = await readFile(resolve(cwd, key))
      const info = await stat(resolve(cwd, key))
      return {
        key,
        path: normalizeSourcePath(root ? `${root}/${key}` : key),
        content: new Uint8Array(bytes),
        metadata: { mtime: info.mtimeMs },
      }
    },
  }
}
