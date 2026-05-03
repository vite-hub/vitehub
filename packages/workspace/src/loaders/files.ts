import { matchesAny, normalizeWorkspacePath } from "../path.ts"

import type { LoaderContext, WorkspaceContent, WorkspaceLoader, WorkspaceSourceItem } from "../types.ts"

export interface FilesLoaderOptions {
  include?: string | string[]
  exclude?: string | string[]
  transform?: (item: WorkspaceSourceItem) => WorkspaceContent | WorkspaceSourceItem | Promise<WorkspaceContent | WorkspaceSourceItem>
}

function shouldLoad(path: string, options: FilesLoaderOptions) {
  if (options.include && !matchesAny(path, options.include)) return false
  if (options.exclude && matchesAny(path, options.exclude)) return false
  return true
}

function sourcePathsMetaKey(sourceName: string) {
  return `loader:files:${sourceName}:paths`
}

function sourceIndexMetaKey() {
  return "loader:files:sources"
}

function sourceDigestMetaKey(sourceName: string, path: string) {
  return `loader:files:${sourceName}:${path}:digest`
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : []
}

export function files(options: FilesLoaderOptions = {}): WorkspaceLoader {
  return {
    name: "files",
    async load(ctx: LoaderContext) {
      const currentPathsBySource = new Map<string, Set<string>>()
      const currentPaths = new Set<string>()

      for (const source of ctx.sources) {
        const sourcePaths = currentPathsBySource.get(source.name) || new Set<string>()
        currentPathsBySource.set(source.name, sourcePaths)

        await source.prepare?.({ rootDir: ctx.rootDir, workspace: ctx.workspace })
        for (const key of await source.getKeys({ rootDir: ctx.rootDir, workspace: ctx.workspace })) {
          const rawItem = await source.getItem(key, { rootDir: ctx.rootDir, workspace: ctx.workspace })
          const rawPath = normalizeWorkspacePath(rawItem.path || rawItem.key)
          if (!shouldLoad(rawPath, options)) continue

          const transformed = options.transform ? await options.transform(rawItem) : rawItem
          const item = typeof transformed === "string" || transformed instanceof Uint8Array
            ? { ...rawItem, content: transformed }
            : transformed
          const path = normalizeWorkspacePath(item.path || rawPath)
          const content = item.content ?? (typeof item.data === "undefined" ? "" : JSON.stringify(item.data, null, 2))
          const digest = ctx.generateDigest({ content, metadata: item.metadata, mediaType: item.mediaType })
          const metaKey = sourceDigestMetaKey(source.name, path)
          const previousDigest = await ctx.store.getMeta?.(metaKey)
          sourcePaths.add(path)
          currentPaths.add(path)

          if (previousDigest === digest && (await ctx.store.stat(path))?.type === "file") continue

          await ctx.store.writeFile(path, {
            path,
            content,
            mediaType: item.mediaType,
            metadata: item.metadata,
          })
          await ctx.store.setMeta?.(metaKey, digest)
        }
      }

      if (!ctx.store.getMeta || !ctx.store.setMeta) return

      for (const [sourceName, sourcePaths] of currentPathsBySource) {
        const previousPaths = readStringList(await ctx.store.getMeta(sourcePathsMetaKey(sourceName)))
        for (const path of previousPaths) {
          if (!sourcePaths.has(path) && !currentPaths.has(path)) {
            await ctx.store.rm(path, { force: true })
          }
        }
        await ctx.store.setMeta(sourcePathsMetaKey(sourceName), [...sourcePaths].sort())
      }

      const currentSourceNames = new Set(currentPathsBySource.keys())
      const previousSourceNames = readStringList(await ctx.store.getMeta(sourceIndexMetaKey()))
      for (const sourceName of previousSourceNames) {
        if (currentSourceNames.has(sourceName)) continue
        const previousPaths = readStringList(await ctx.store.getMeta(sourcePathsMetaKey(sourceName)))
        for (const path of previousPaths) {
          if (!currentPaths.has(path)) await ctx.store.rm(path, { force: true })
        }
        await ctx.store.setMeta(sourcePathsMetaKey(sourceName), [])
      }

      await ctx.store.setMeta(sourceIndexMetaKey(), [...currentSourceNames].sort())
    },
  }
}
