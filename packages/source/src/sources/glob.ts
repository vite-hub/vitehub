import { glob as tinyglobby } from "tinyglobby"

import { SourcePathError, sourceItemNotFoundError, sourceProviderRequestError } from "../core/errors.ts"
import { matchesAny, normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"

import type { SourceProviderOperation } from "../core/errors.ts"
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
    let files: string[]
    try {
      files = await tinyglobby(options.include, {
        cwd,
        dot: options.dot ?? false,
        followSymbolicLinks: options.followSymlinks ?? false,
        ignore: ["**/.git/**", "**/node_modules/**", ...ignore],
        onlyFiles: true,
      })
    }
    catch (cause) {
      throw sourceProviderRequestError("filesystem", "list", { cause })
    }
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
      throw sourceItemNotFoundError("glob", key)
    }
    if ((await refreshKeys(ctx)).includes(key)) return
    throw sourceItemNotFoundError("glob", key)
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
      const info = await runFileOperation("metadata", key, () => stat(resolve(cwd, key)))
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
      const bytes = await runFileOperation("read", key, () => readFile(resolve(cwd, key)))
      const info = await runFileOperation("metadata", key, () => stat(resolve(cwd, key)))
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
  let resolvedRoot: string
  try {
    resolvedRoot = await realpath(resolve(rootDir))
  }
  catch (cause) {
    throw sourceProviderRequestError("filesystem", "resolve-root", { cause })
  }
  const resolvedCwdPath = isAbsolute(cwd) ? resolve(cwd) : resolve(resolvedRoot, cwd)
  let resolvedCwd: string
  try {
    resolvedCwd = await realpath(resolvedCwdPath)
  }
  catch (cause) {
    throw sourceProviderRequestError("filesystem", "resolve", { cause })
  }
  const rel = relative(resolvedRoot, resolvedCwd)
  if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new SourcePathError(cwd)
  }
  return resolvedCwd
}

async function runFileOperation<TResult>(operation: SourceProviderOperation, key: string, run: () => Promise<TResult>): Promise<TResult> {
  try {
    return await run()
  }
  catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      throw sourceItemNotFoundError("glob", key)
    }
    throw sourceProviderRequestError("filesystem", operation, { cause })
  }
}
