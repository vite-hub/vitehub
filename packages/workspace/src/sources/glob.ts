import { glob as tinyglobby } from "tinyglobby"

import { matchesAny, normalizeWorkspacePath } from "../path.ts"

import type { SourceContext, WorkspaceSource, WorkspaceSourceItem } from "../types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "swr" | "validate">

export interface GlobSourceOptions extends SourceRuntimeOptions {
  cwd?: string
  include: string | string[]
  exclude?: string | string[]
  root?: string
}

export function glob(options: GlobSourceOptions): WorkspaceSource {
  return {
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    name: "glob",
    swr: options.swr,
    validate: options.validate,
    async getKeys(ctx: SourceContext) {
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const files = await tinyglobby(options.include, {
        cwd,
        dot: true,
        ignore: ["**/.git/**", "**/node_modules/**", ...(Array.isArray(options.exclude) ? options.exclude : options.exclude ? [options.exclude] : [])],
        onlyFiles: true,
      })
      return files
        .map(file => normalizeWorkspacePath(file))
        .filter(file => matchesAny(file, options.include) && !(options.exclude && matchesAny(file, options.exclude)))
        .sort((left, right) => left.localeCompare(right))
    },
    async getMeta(key: string, ctx: SourceContext) {
      const { stat } = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const cwd = resolve(ctx.rootDir, options.cwd || ".")
      const info = await stat(resolve(cwd, key))
      return {
        digest: `${info.size}:${info.mtimeMs}`,
      }
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
