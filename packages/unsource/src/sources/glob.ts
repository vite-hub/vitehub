import { glob as tinyglobby } from "tinyglobby"

import { UnsourceError } from "../core/errors.ts"
import { matchesAny, normalizeSourcePath } from "../core/path.ts"

import type { Source, SourceContext, SourceItem } from "../core/types.ts"

export interface GlobSourceOptions {
  cwd?: string
  include: string | string[]
  exclude?: string | string[]
  root?: string
}

async function assertKnownKey<TKey extends string>(source: Source<TKey>, key: TKey, ctx: SourceContext) {
  if ((await source.getKeys(ctx)).includes(key)) return
  throw new UnsourceError(`[vitehub] source.glob could not find ${JSON.stringify(key)}.`)
}

export function glob<const TKey extends string = string>(options: GlobSourceOptions): Source<TKey> {
  const source: Source<TKey> = {
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
      await assertKnownKey(source, key, ctx)
      const { stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const info = await stat(resolve(cwd, key))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(key: TKey, ctx: SourceContext): Promise<SourceItem<TKey>> {
      await assertKnownKey(source, key, ctx)
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
  return source
}
