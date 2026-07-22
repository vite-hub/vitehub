import { lookup } from "mrmime"

import { workspaceError } from "../core/errors.ts"
import { normalizeSafeWorkspacePath } from "../core/path.ts"

import type { MaybePromise, SourceContext, WorkspaceContent, WorkspaceSource, WorkspaceSourceItem } from "../core/types.ts"

type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>
type WorkspaceSourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "probeKeys" | "sync" | "validate">
type CustomWorkspaceSourceFile = Omit<WorkspaceSourceItem, "content" | "contentStream" | "key" | "path"> & {
  content: WorkspaceContent | ((context: SourceContext) => MaybePromise<WorkspaceContent>)
  path: string
}
type CustomWorkspaceSourceFiles = WorkspaceSourceRuntimeOptions & {
  files: readonly CustomWorkspaceSourceFile[]
}

export function custom<const TSource extends CustomWorkspaceSourceFiles>(source: ExactOptions<TSource, CustomWorkspaceSourceFiles>): WorkspaceSource
export function custom<const TSource extends WorkspaceSource>(source: ExactOptions<TSource, WorkspaceSource>): WorkspaceSource
export function custom(source: WorkspaceSource | CustomWorkspaceSourceFiles): WorkspaceSource {
  if (!("files" in source) || !Array.isArray(source.files)) return source as WorkspaceSource

  const { files: inputFiles, ...options } = source
  const files = inputFiles.map(file => ({
    ...file,
    path: normalizeSafeWorkspacePath(file.path),
  }))

  return {
    ...options,
    async getKeys() {
      return files.map(file => file.path)
    },
    async getItem(key, context) {
      const file = files.find(file => file.path === key)
      if (!file) throw workspaceError(`[vitehub] Custom Workspace Source file does not exist: ${key}.`)
      const { content, ...item } = file
      return {
        ...item,
        content: typeof content === "function" ? await content(context) : content,
        key,
        mediaType: item.mediaType || lookup(key) || undefined,
      }
    },
  }
}
