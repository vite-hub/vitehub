import { lookup } from "mrmime"

import { normalizeSourcePath } from "./path.ts"

import type { Source, SourceContent, SourceContext } from "./types.ts"

export interface FileSourcePathOptions<TKey extends string = string> {
  path: string
  workspacePath?: TKey
  content?: SourceContent
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

function basename(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path
}

function sourceKey<TKey extends string>(options: FileSourceOptions<TKey>): TKey {
  if (options.workspacePath) return normalizeSourcePath(options.workspacePath) as TKey
  if ("path" in options && options.path) return normalizeSourcePath(basename(options.path)) as TKey
  throw new TypeError("[vitehub] source.file requires a path or workspacePath.")
}

async function readSourceFile<TKey extends string>(options: FileSourceOptions<TKey>, ctx: SourceContext) {
  if (!("path" in options) || !options.path) {
    throw new TypeError("[vitehub] source.file requires path when content is not provided.")
  }
  const { readFile } = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  return new Uint8Array(await readFile(resolve(ctx.rootDir, options.path)))
}

export function file<const TKey extends string = string>(options: FileSourceOptions<TKey>): Source<TKey> {
  const key = sourceKey(options)
  const mediaType = options.mediaType || lookup(key)
  return {
    name: "file",
    async getKeys() {
      return [key]
    },
    async getMeta(_key: TKey, ctx: SourceContext) {
      if (!("path" in options) || !options.path) return
      const { stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const info = await stat(resolve(ctx.rootDir, options.path))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
    },
    async getItem(_key: TKey, ctx: SourceContext) {
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
