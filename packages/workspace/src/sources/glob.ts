import { matchesAny, normalizeWorkspacePath } from "../path.ts"

import type { SourceContext, WorkspaceSource, WorkspaceSourceItem } from "../types.ts"

export interface GlobSourceOptions {
  cwd?: string
  include: string | string[]
  exclude?: string | string[]
  root?: string
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  const { relative } = await import("node:path")
  const files: string[] = []
  const entries = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of entries) {
    const path = `${current}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      files.push(...await walkFiles(root, path))
    }
    else if (entry.isFile()) {
      files.push(normalizeWorkspacePath(relative(root, path)))
    }
  }
  return files
}

export function glob(options: GlobSourceOptions): WorkspaceSource {
  return {
    name: "glob",
    async getKeys(ctx: SourceContext) {
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const files = await walkFiles(cwd)
      return files.filter(file => matchesAny(file, options.include) && !(options.exclude && matchesAny(file, options.exclude)))
    },
    async getItem(key: string, ctx: SourceContext): Promise<WorkspaceSourceItem> {
      const { readFile, stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const root = normalizeWorkspacePath(options.root || "")
      const bytes = await readFile(resolve(cwd, key))
      const info = await stat(resolve(cwd, key))
      return {
        key,
        path: normalizeWorkspacePath(root ? `${root}/${key}` : key),
        content: new Uint8Array(bytes),
        metadata: { mtime: info.mtimeMs },
      }
    },
  }
}
