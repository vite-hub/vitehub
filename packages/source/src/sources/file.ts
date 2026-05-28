import { lookup } from "mrmime"

import { SourceError } from "../core/errors.ts"
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

function basename(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path
}

function normalizeFileSourceOptions<TKey extends string>(input: FileSourceInput<TKey>): FileSourceOptions<TKey> {
  return typeof input === "string" ? { path: input } : input
}

function sourceKey<TKey extends string>(options: FileSourceOptions<TKey>): TKey {
  if (options.workspacePath) return normalizeSourcePath(options.workspacePath) as TKey
  if ("path" in options && options.path) return normalizeSourcePath(basename(normalizeSafeSourcePath(options.path))) as TKey
  throw new TypeError("[vitehub] source.file requires a path or workspacePath.")
}

async function readSourceFile<TKey extends string>(options: FileSourceOptions<TKey>, ctx: SourceContext) {
  if (!("path" in options) || !options.path) {
    throw new TypeError("[vitehub] source.file requires path when content is not provided.")
  }
  const { readFile } = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  return new Uint8Array(await readFile(resolve(ctx.sourceRootDir ?? ctx.rootDir, normalizeSafeSourcePath(options.path))))
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
      const { resolve } = await import("node:path")
      const info = await stat(resolve(ctx.sourceRootDir ?? ctx.rootDir, normalizeSafeSourcePath(options.path)))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(requestedKey: TKey, ctx: SourceContext) {
      if (requestedKey !== key) {
        throw new SourceError(`[vitehub] source.file could not find ${JSON.stringify(requestedKey)}.`)
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
