import { matchesAny, normalizeWorkspacePath } from "../core/path.ts"
import { createSourceContext, prepareWorkspaceSource } from "../sources/config.ts"

import type { LoaderContext, WorkspaceContent, WorkspaceLoader, WorkspaceSourceItem } from "../core/types.ts"

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

export function files(options: FilesLoaderOptions = {}): WorkspaceLoader {
  return {
    name: "files",
    async load(ctx: LoaderContext) {
      for (const source of ctx.sources) {
        const sourceContext = createSourceContext({
          name: ctx.workspace,
          rootDir: ctx.rootDir,
          sourceRootDir: ctx.sourceRootDir,
        }, { key: source.key, mountPath: "" }, ctx.store)
        await prepareWorkspaceSource(source, sourceContext)
        for (const key of await source.getKeys(sourceContext)) {
          const rawItem = await source.getItem(key, sourceContext)
          const rawPath = normalizeWorkspacePath(rawItem.path || rawItem.key)
          if (!shouldLoad(rawPath, options)) continue

          const transformed = options.transform ? await options.transform(rawItem) : rawItem
          const item = typeof transformed === "string" || transformed instanceof Uint8Array
            ? { ...rawItem, content: transformed }
            : transformed
          const path = normalizeWorkspacePath(item.path || rawPath)
          const content = item.content ?? (typeof item.data === "undefined" ? "" : JSON.stringify(item.data, null, 2))
          const digest = ctx.generateDigest({ content, metadata: item.metadata, mediaType: item.mediaType })
          const metaKey = `loader:files:${source.key}:${path}:digest`
          const previousDigest = await ctx.store.getMeta?.(metaKey)

          if (previousDigest === digest && await ctx.store.stat(path)) continue

          await ctx.store.writeFile(path, {
            path,
            content,
            mediaType: item.mediaType,
            metadata: item.metadata,
          })
          await ctx.store.setMeta?.(metaKey, digest)
        }
      }
    },
  }
}
