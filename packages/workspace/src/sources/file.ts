import { normalizeWorkspacePath } from "../path.ts"

import type { SourceContext, WorkspaceContent, WorkspaceSource } from "../types.ts"

export interface FileSourceOptions {
  path: string
  workspacePath?: string
  content?: WorkspaceContent
  mediaType?: string
}

function basename(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path
}

export function file(options: FileSourceOptions): WorkspaceSource {
  const key = normalizeWorkspacePath(options.workspacePath || basename(options.path))
  return {
    name: "file",
    async getKeys() {
      return [key]
    },
    async getItem(_key: string, ctx: SourceContext) {
      const { readFile } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const content = typeof options.content === "undefined"
        ? new Uint8Array(await readFile(resolve(ctx.rootDir, options.path)))
        : options.content
      return {
        key,
        path: key,
        content,
        mediaType: options.mediaType,
      }
    },
  }
}
