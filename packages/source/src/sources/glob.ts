import { glob as tinyglobby } from "tinyglobby"

import { sourceError } from "../core/errors.ts"
import { matchesAny, normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"

import type { Source, SourceContext, SourceItem } from "../core/types.ts"

export interface GlobSourceOptions {
  cwd?: string
  dot?: boolean
  followSymlinks?: boolean
  include: string | string[]
  ignore?: string | string[]
  keyCache?: boolean
  prefix?: string
}

export function glob<const TKey extends string = string>(options: GlobSourceOptions): Source<TKey> {
  let snapshot: { key: string, keys: Promise<TKey[]> } | undefined
  let latest: { key: string, keys: TKey[] } | undefined

  async function getContextKey(ctx: SourceContext) {
    return resolveCwd(resolveSourceRoot(ctx), options.cwd)
  }

  async function loadKeys(ctx: SourceContext) {
    const cwd = await resolveCwd(resolveSourceRoot(ctx), options.cwd)
    const ignore = normalizePatterns(options.ignore)
    const files = await tinyglobby(options.include, {
      cwd,
      dot: options.dot ?? false,
      followSymbolicLinks: options.followSymlinks ?? false,
      ignore: ["**/.git/**", "**/node_modules/**", ...ignore],
      onlyFiles: true,
    })
    return files
      .map(file => normalizeSourcePath(file))
      .filter(file => matchesAny(file, options.include) && !matchesAny(file, ignore))
      .sort((left, right) => left.localeCompare(right)) as TKey[]
  }

  async function refreshKeys(ctx: SourceContext) {
    const key = await getContextKey(ctx)
    const keys = await loadKeys(ctx)
    latest = { key, keys }
    return keys
  }

  async function getCachedKeys(ctx: SourceContext) {
    if (options.keyCache === false) return await refreshKeys(ctx)
    const key = await getContextKey(ctx)
    if (!snapshot || snapshot.key !== key) {
      const keys = refreshKeys(ctx)
      const entry = { key, keys }
      snapshot = entry
      keys.catch(() => {
        if (snapshot === entry) snapshot = undefined
      })
    }
    return await snapshot.keys
  }

  async function getKnownKeys(ctx: SourceContext) {
    const key = await getContextKey(ctx)
    if (latest?.key === key) return latest.keys
    return await getCachedKeys(ctx)
  }

  async function assertKey(key: TKey, ctx: SourceContext) {
    const keys = await getKnownKeys(ctx)
    if (keys.includes(key)) return
    if (options.keyCache !== false) {
      throw sourceError(`[vitehub] glob could not find ${JSON.stringify(key)}.`)
    }
    if ((await refreshKeys(ctx)).includes(key)) return
    throw sourceError(`[vitehub] glob could not find ${JSON.stringify(key)}.`)
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
      await assertKey(key, ctx)
      const { stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = await resolveCwd(resolveSourceRoot(ctx), options.cwd)
      const info = await stat(resolve(cwd, key))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(key: TKey, ctx: SourceContext): Promise<SourceItem<TKey>> {
      await assertKey(key, ctx)
      const { readFile, stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = await resolveCwd(resolveSourceRoot(ctx), options.cwd)
      const prefix = normalizeSafeSourcePath(options.prefix || "", { allowEmpty: true })
      const bytes = await readFile(resolve(cwd, key))
      const info = await stat(resolve(cwd, key))
      return {
        key,
        path: normalizeSourcePath(prefix ? `${prefix}/${key}` : key),
        content: new Uint8Array(bytes),
        metadata: { mtime: info.mtimeMs },
      }
    },
  }
  return source
}

function normalizePatterns(patterns: string | string[] | undefined): string[] {
  return Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
}

function resolveSourceRoot(ctx: SourceContext) {
  return ctx.sourceRootDir || ctx.rootDir
}

async function resolveCwd(rootDir: string, cwd = "."): Promise<string> {
  const { realpath } = await import("node:fs/promises")
  const { isAbsolute, relative, resolve } = await import("node:path")
  const resolvedRoot = await realpath(resolve(rootDir))
  const resolvedCwdPath = isAbsolute(cwd) ? resolve(cwd) : resolve(resolvedRoot, cwd)
  const resolvedCwd = await realpath(resolvedCwdPath)
  const rel = relative(resolvedRoot, resolvedCwd)
  if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
    throw sourceError(`[vitehub] glob cwd escapes the source root: ${JSON.stringify(cwd)}.`)
  }
  return resolvedCwd
}
