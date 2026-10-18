import { glob as tinyglobby } from "tinyglobby"

import { sourceError } from "../core/errors.ts"
import { normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"
import { matchesAny } from "./path.ts"

import type { FileSource, SourceContext, SourceFile } from "../core/types.ts"

export interface GlobSourceOptions {
  cwd?: string
  dot?: boolean
  followSymlinks?: boolean
  /** Portable glob patterns: backslashes are separators, never escapes. Use [*], [?], [[] for literals. */
  include: string | string[]
  /** Uses the same portable separator and literal syntax as include. */
  ignore?: string | readonly string[]
  keyCache?: boolean
  prefix?: string
}

interface GlobKeyCache {
  snapshot?: { key: string, keys: Promise<string[]> }
  latest?: { key: string, keys: string[] }
}

export function glob(options: GlobSourceOptions): FileSource<string> {
  // createSource retains one context for each reader's preparation and reads.
  const caches = new WeakMap<SourceContext, GlobKeyCache>()

  function cacheFor(ctx: SourceContext) {
    let cache = caches.get(ctx)
    if (!cache) {
      cache = {}
      caches.set(ctx, cache)
    }
    return cache
  }

  async function getContextKey(ctx: SourceContext) {
    const { root, cwd } = await resolveGlobPaths(resolveSourceRoot(ctx), options.cwd)
    return `${root}\0${cwd}`
  }

  async function loadKeys(ctx: SourceContext) {
    const paths = await resolveGlobPaths(resolveSourceRoot(ctx), options.cwd)
    const include = normalizePatterns(options.include).map(normalizeGlobPattern)
    const ignore = normalizePatterns(options.ignore).map(normalizeGlobPattern)
    const files = await tinyglobby(include, {
      cwd: paths.cwd,
      dot: options.dot ?? false,
      followSymbolicLinks: options.followSymlinks ?? false,
      ignore: ["**/.git/**", "**/node_modules/**", ...ignore],
      onlyFiles: true,
    })
    let keys = files
      .map(file => normalizeSafeSourcePath(file, { allowReserved: true }))
      .filter(file => matchesAny(file, include) && !matchesAny(file, ignore))
    if (options.followSymlinks) {
      const rooted: string[] = []
      for (const key of keys) {
        if (await resolveRootedGlobFilePath(key, paths, true)) rooted.push(key)
      }
      keys = rooted
    }
    return keys.sort((left, right) => left.localeCompare(right))
  }

  async function refreshKeys(ctx: SourceContext) {
    const key = await getContextKey(ctx)
    const keys = await loadKeys(ctx)
    cacheFor(ctx).latest = { key, keys }
    return keys
  }

  async function getCachedKeys(ctx: SourceContext) {
    if (options.keyCache === false) return await refreshKeys(ctx)
    const key = await getContextKey(ctx)
    const cache = cacheFor(ctx)
    if (!cache.snapshot || cache.snapshot.key !== key) {
      const keys = refreshKeys(ctx)
      const entry = { key, keys }
      cache.snapshot = entry
      keys.catch(() => {
        if (cache.snapshot === entry) cache.snapshot = undefined
      })
    }
    return await cache.snapshot.keys
  }

  async function getKnownKeys(ctx: SourceContext) {
    const key = await getContextKey(ctx)
    const { latest } = cacheFor(ctx)
    if (latest?.key === key) return latest.keys
    return await getCachedKeys(ctx)
  }

  async function assertKey(key: string, ctx: SourceContext) {
    const keys = await getKnownKeys(ctx)
    if (keys.includes(key)) return
    if (options.keyCache !== false) {
      throw missingKeyError(key)
    }
    if ((await refreshKeys(ctx)).includes(key)) return
    throw missingKeyError(key)
  }

  async function resolveGlobFilePath(key: string, ctx: SourceContext) {
    const paths = await resolveGlobPaths(resolveSourceRoot(ctx), options.cwd)
    const path = await resolveRootedGlobFilePath(key, paths, options.followSymlinks === true)
    if (!path) throw missingKeyError(key)
    return path
  }

  const source: FileSource<string> = {
    name: "glob",
    async prepare(ctx: SourceContext) {
      cacheFor(ctx).snapshot = undefined
      await getCachedKeys(ctx)
    },
    getKeys(ctx: SourceContext) {
      return getCachedKeys(ctx)
    },
    async getMeta(key: string, ctx: SourceContext) {
      await assertKey(key, ctx)
      const { stat } = await import("node:fs/promises")
      const path = await resolveGlobFilePath(key, ctx)
      const info = await stat(path)
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(key: string, ctx: SourceContext): Promise<SourceFile<string>> {
      await assertKey(key, ctx)
      const { readFile, stat } = await import("node:fs/promises")
      const filePath = await resolveGlobFilePath(key, ctx)
      const prefix = normalizeSafeSourcePath(options.prefix || "", { allowEmpty: true })
      const bytes = await readFile(filePath)
      const info = await stat(filePath)
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

function missingKeyError(key: string) {
  return sourceError(`[vitehub] glob could not find ${JSON.stringify(key)}.`)
}

function normalizePatterns(patterns: string | readonly string[] | undefined): readonly string[] {
  if (!patterns) return []
  return Array.isArray(patterns) ? patterns : [String(patterns)]
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/")
}

function resolveSourceRoot(ctx: SourceContext) {
  return ctx.sourceRootDir || ctx.rootDir
}

interface ResolvedGlobPaths {
  root: string
  cwd: string
}

async function resolveGlobPaths(rootDir: string, cwd = "."): Promise<ResolvedGlobPaths> {
  const { realpath } = await import("node:fs/promises")
  const { isAbsolute, relative, resolve, sep } = await import("node:path")
  const resolvedRoot = await realpath(resolve(rootDir))
  const normalizedCwd = isAbsolute(cwd)
    ? cwd
    : normalizeSafeSourcePath(cwd === "." ? "" : cwd, { allowEmpty: true })
  const resolvedCwdPath = isAbsolute(normalizedCwd) ? resolve(normalizedCwd) : resolve(resolvedRoot, normalizedCwd)
  const resolvedCwd = await realpath(resolvedCwdPath)
  const rel = relative(resolvedRoot, resolvedCwd)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw sourceError(`[vitehub] glob cwd escapes the source root: ${JSON.stringify(cwd)}.`)
  }
  return { root: resolvedRoot, cwd: resolvedCwd }
}

async function resolveRootedGlobFilePath(
  key: string,
  paths: ResolvedGlobPaths,
  followSymlinks: boolean,
): Promise<string | undefined> {
  const { lstat, realpath } = await import("node:fs/promises")
  const { isAbsolute, relative, resolve, sep } = await import("node:path")
  const safeKey = normalizeSafeSourcePath(key, { allowReserved: true })
  const path = resolve(paths.cwd, safeKey)

  if (followSymlinks) {
    let target: string
    try {
      target = await realpath(path)
    }
    catch (error) {
      if (isUnavailablePathError(error)) return
      throw error
    }
    const rel = relative(paths.root, target)
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return
    return target
  }

  let current = paths.cwd
  for (const part of safeKey.split("/")) {
    current = resolve(current, part)
    if ((await lstat(current)).isSymbolicLink()) return
  }
  return path
}

function isUnavailablePathError(error: unknown) {
  return error instanceof Error
    && ["ENOENT", "ELOOP"].includes(String(Reflect.get(error, "code")))
}
