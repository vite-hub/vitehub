import { normalizeWorkspacePath } from "../path.ts"
import { lookup } from "mrmime"

import type { SourceContext, WorkspaceContent, WorkspaceSource } from "../types.ts"

export interface FileSourcePathOptions {
  path: string
  workspacePath?: string
  content?: WorkspaceContent
  mediaType?: string
}

export interface FileSourceInlineOptions {
  workspacePath: string
  content: WorkspaceContent
  mediaType?: string
  path?: never
}

export type FileSourceOptions = FileSourcePathOptions | FileSourceInlineOptions

function basename(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path
}

function sourceKey(options: FileSourceOptions) {
  if (options.workspacePath) return normalizeWorkspacePath(options.workspacePath)
  if ("path" in options && options.path) return normalizeWorkspacePath(basename(options.path))
  throw new TypeError("[vitehub] source.file requires a path or workspacePath.")
}

async function readSourceFile(options: FileSourceOptions, ctx: SourceContext) {
  if (!("path" in options) || !options.path) {
    throw new TypeError("[vitehub] source.file requires path when content is not provided.")
  }
  const { readFile } = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  return new Uint8Array(await readFile(resolve(ctx.rootDir, options.path)))
}

export function file(options: FileSourceOptions): WorkspaceSource {
  const key = sourceKey(options)
  const mediaType = options.mediaType || lookup(key)
  return {
    name: "file",
    async getKeys() {
      return [key]
    },
    async getItem(_key: string, ctx: SourceContext) {
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
