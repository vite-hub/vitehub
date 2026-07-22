import { lookup } from "mrmime"

import { sourceError, sourcePathError } from "../core/errors.ts"
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

async function readSourceFile<TKey extends string>(options: FileSourceOptions<TKey>, ctx: SourceContext) {
  if (!("path" in options) || !options.path) {
    throw new TypeError("[vitehub] file requires path when content is not provided.")
  }
  const { readFile } = await import("node:fs/promises")
  return new Uint8Array(await readFile(await resolveSafeSourceFilePath(options.path, ctx)))
}

async function resolveSafeSourceFilePath(path: string, ctx: SourceContext) {
  const { realpath } = await import("node:fs/promises")
  const { relative, resolve, sep } = await import("node:path")
  const root = await realpath(resolve(resolveSourceRoot(ctx)))
  const target = await realpath(resolve(root, normalizeSafeSourcePath(path)))
  const rel = relative(root, target)

  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw sourcePathError(path)
  }

  return target
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
      const info = await stat(await resolveSafeSourceFilePath(options.path, ctx))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(requestedKey: TKey, ctx: SourceContext) {
      if (requestedKey !== key) {
        throw sourceError(`[vitehub] file could not find ${JSON.stringify(requestedKey)}.`)
      }
      const content = typeof options.content === "undefined"
        ? await readSourceFile(options, ctx)
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
