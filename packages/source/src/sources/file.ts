import { lookup } from "mrmime"

import { SourceError, SourcePathError, sourceItemIsDirectoryError, sourceItemNotFoundError, sourceProviderRequestError } from "../core/errors.ts"
import { normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"

import type { Source, SourceContent, SourceContext } from "../core/types.ts"

export interface FileSourcePathOptions<TKey extends string = string> {
  path: string
  workspacePath?: TKey
  content?: never
  mediaType?: string
}

export interface FileSourceInlineOptions<TKey extends string = string> {
  workspacePath: TKey
  content: SourceContent
  mediaType?: string
  path?: never
}

export type FileSourceOptions<TKey extends string = string> =
  | FileSourcePathOptions<TKey>
  | FileSourceInlineOptions<TKey>

type FileSourceInput<TKey extends string = string> = FileSourceOptions<TKey> | TKey

function normalizeFileSourceOptions<TKey extends string>(input: FileSourceInput<TKey>): FileSourceOptions<TKey> {
  return typeof input === "string" ? { path: input } : input
}

function sourceKey<TKey extends string>(options: FileSourceOptions<TKey>): TKey {
  if (options.workspacePath) return normalizeSourcePath(options.workspacePath) as TKey
  if ("path" in options && options.path) return normalizeSourcePath(normalizeSafeSourcePath(options.path)) as TKey
  throw new TypeError("[vitehub] file requires a path or workspacePath.")
}

function resolveSourceRoot(ctx: SourceContext) {
  return ctx.sourceRootDir || ctx.rootDir
}

async function readSourceFile<TKey extends string>(options: FileSourceOptions<TKey>, ctx: SourceContext, key: TKey) {
  if (!("path" in options) || !options.path) {
    throw new TypeError("[vitehub] file requires path when content is not provided.")
  }
  const { readFile, stat } = await import("node:fs/promises")
  const target = await resolveSafeSourceFilePath(options.path, key, ctx)
  try {
    if ((await stat(target)).isDirectory()) throw sourceItemIsDirectoryError("file", key)
    return new Uint8Array(await readFile(target))
  }
  catch (cause) {
    if (cause instanceof SourceError) throw cause
    if (isFileNotFoundError(cause)) throw sourceItemNotFoundError("file", key)
    throw sourceProviderRequestError("filesystem", "read", { cause })
  }
}

async function resolveSafeSourceFilePath(path: string, key: string, ctx: SourceContext) {
  const { realpath } = await import("node:fs/promises")
  const { relative, resolve, sep } = await import("node:path")
  let root: string
  try {
    root = await realpath(resolve(resolveSourceRoot(ctx)))
  }
  catch (cause) {
    throw sourceProviderRequestError("filesystem", "resolve-root", { cause })
  }
  let target: string
  try {
    target = await realpath(resolve(root, normalizeSafeSourcePath(path)))
  }
  catch (cause) {
    if (cause instanceof SourceError) throw cause
    if (isFileNotFoundError(cause)) throw sourceItemNotFoundError("file", key)
    throw sourceProviderRequestError("filesystem", "resolve", { cause })
  }
  const rel = relative(root, target)

  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new SourcePathError(path)
  }

  return target
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

export function file<const TKey extends string = string>(input: FileSourceInput<TKey>): Source<TKey> {
  const options = normalizeFileSourceOptions(input)
  const key = sourceKey(options)
  const mediaType = options.mediaType || lookup(key)
  return {
    name: "file",
    async getKeys() {
      return [key]
    },
    async getMeta(requestedKey: TKey, ctx: SourceContext) {
      if (requestedKey !== key) return
      if (!("path" in options) || !options.path) return
      const { stat } = await import("node:fs/promises")
      const target = await resolveSafeSourceFilePath(options.path, key, ctx)
      let info
      try {
        info = await stat(target)
      }
      catch (cause) {
        if (isFileNotFoundError(cause)) throw sourceItemNotFoundError("file", key)
        throw sourceProviderRequestError("filesystem", "metadata", { cause })
      }
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(requestedKey: TKey, ctx: SourceContext) {
      if (requestedKey !== key) {
        throw sourceItemNotFoundError("file", requestedKey)
      }
      const content = typeof options.content === "undefined"
        ? await readSourceFile(options, ctx, key)
        : options.content
      return {
        key,
        path: key,
        content,
        mediaType,
      }
    },
  }
}
