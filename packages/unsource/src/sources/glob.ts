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

async function assertKnownKey<TKey extends string>(getKeys: (ctx: SourceContext) => Promise<TKey[]>, key: TKey, ctx: SourceContext) {
  if ((await getKeys(ctx)).includes(key)) return
  throw new UnsourceError(`[vitehub] source.glob could not find ${JSON.stringify(key)}.`)
}

export function glob<const TKey extends string = string>(options: GlobSourceOptions): Source<TKey> {
  let snapshot: { key: string, keys: Promise<TKey[]> } | undefined

  async function loadKeys(ctx: SourceContext) {
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
  }

  async function getCachedKeys(ctx: SourceContext) {
    const { resolve } = await import("node:path")
    const key = resolve(ctx.rootDir, options.cwd || ".")
    if (!snapshot || snapshot.key !== key) {
      snapshot = { key, keys: loadKeys(ctx) }
    }
    return await snapshot.keys
  }

  const source: Source<TKey> = {
    name: "glob",
    async prepare(ctx: SourceContext) {
      snapshot = undefined
      await getCachedKeys(ctx)
    },
    getKeys(ctx: SourceContext) {
      return getCachedKeys(ctx)
    },
    async getMeta(key: TKey, ctx: SourceContext) {
      await assertKnownKey(getCachedKeys, key, ctx)
      const { stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const info = await stat(resolve(cwd, key))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(key: TKey, ctx: SourceContext): Promise<SourceItem<TKey>> {
      await assertKnownKey(getCachedKeys, key, ctx)
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
