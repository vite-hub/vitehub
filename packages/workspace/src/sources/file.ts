import { file as createFileSource, type FileSourceOptions as SourcePackageFileSourceOptions } from "@vite-hub/source/sources/file"

import { normalizeSafeWorkspacePath } from "../core/path.ts"

import type { WorkspaceSource } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "probeKeys" | "sync" | "validate">
type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>

export type FileSourceOptions<TKey extends string = string> = SourcePackageFileSourceOptions<TKey> & SourceRuntimeOptions
export type FileSourceInput<TKey extends string = string> = FileSourceOptions<TKey> | TKey

export function file<const TKey extends string>(input: TKey): WorkspaceSource
export function file<const TKey extends string = string, const TOptions extends FileSourceOptions<TKey> = FileSourceOptions<TKey>>(input: ExactOptions<TOptions, FileSourceOptions<TKey>>): WorkspaceSource
export function file<const TKey extends string = string>(input: FileSourceInput<TKey>): WorkspaceSource {
  const options = (typeof input === "string" ? { path: input } : input) as FileSourceOptions<TKey>
  const key = normalizeSafeWorkspacePath(options.workspacePath || options.path || "")
  const mount = typeof options.mount === "object" && options.mount && !("path" in options.mount)
    ? { ...options.mount, path: "" }
    : options.mount ?? ""
  const source = createFileSource(options)
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount,
    probeKeys: options.probeKeys || [key],
    sync: options.sync,
    validate: options.validate,
  }
}
